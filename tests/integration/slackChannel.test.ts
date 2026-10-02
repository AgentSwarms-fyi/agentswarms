// The two Slack endpoints, driven the way Slack drives them: a real workspace
// row, a real signature over the exact bytes, against a running instance.
//
// The unit tests decide who answers a command; only this can show that a
// signed request reaches that decision, that an unsigned one does not, and
// that the acknowledgement comes back inside Slack's three seconds while the
// turn runs on behind it.
//
// Everything created here is removed in an afterAll. The audit events the run
// produces stay, as they must — a gap in the chain reads as tampering for ever.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { admin, hasSupabase, TEST_PREFIX } from "./setup";

/** The instance under test. Docker Compose publishes 8080 by default. */
const BASE = process.env.APP_BASE_URL ?? "http://localhost:8080";

/**
 * A signing secret invented for this run, never stored anywhere but the row
 * this test creates and deletes. It has to be encrypted the way the app
 * encrypts it, so the endpoint can decrypt it — which is the app's own
 * function, not a re-implementation of AES-GCM here.
 */
const SIGNING_SECRET = `itest-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const TEAM_ID = `T0ITEST${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

function sign(rawBody: string, ts: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
}

async function post(
  path: string,
  rawBody: string,
  opts: { json?: boolean; badSignature?: boolean; retry?: boolean; noSignature?: boolean } = {},
) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    "Content-Type": opts.json ? "application/json" : "application/x-www-form-urlencoded",
  };
  if (!opts.noSignature) {
    headers["X-Slack-Request-Timestamp"] = ts;
    headers["X-Slack-Signature"] = opts.badSignature ? "v0=deadbeef" : sign(rawBody, ts);
  }
  if (opts.retry) headers["X-Slack-Retry-Num"] = "1";
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: rawBody });
  return { status: res.status, text: await res.text() };
}

/** An instance to test against, or the suite has nothing to drive. */
async function appIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!hasSupabase)("Slack channel endpoints", () => {
  let workspaceId: string | null = null;
  let routeId: string | null = null;
  let agentName: string | null = null;
  let up = false;

  beforeAll(async () => {
    up = await appIsUp();
    if (!up) return;

    // An owner with an agent to route to. Both endpoints run the turn as this
    // user, so the row has to belong to somebody real.
    const { data: agent } = await admin()
      .from("agents")
      .select("id, name, user_id")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (!agent) return;
    agentName = agent.name;

    // The app's own encryption, so the endpoint can decrypt what it reads.
    const { encryptJson } = await import("@/utils/providers/crypto.server");
    const { data: ws } = await admin()
      .from("slack_workspaces")
      .insert({
        user_id: agent.user_id,
        team_id: TEAM_ID,
        team_name: `${TEST_PREFIX}slack`,
        signing_secret_enc: await encryptJson({ secret: SIGNING_SECRET }),
        is_active: true,
      })
      .select("id")
      .maybeSingle();
    workspaceId = ws?.id ?? null;
    if (!workspaceId) return;

    const { data: route } = await admin()
      .from("slack_command_routes")
      .insert({
        user_id: agent.user_id,
        workspace_id: workspaceId,
        command: "/itest",
        target_type: "agent",
        target_id: agent.id,
        is_active: true,
      })
      .select("id")
      .maybeSingle();
    routeId = route?.id ?? null;
  });

  afterAll(async () => {
    if (routeId) await admin().from("slack_command_routes").delete().eq("id", routeId);
    // The workspace cascade would take the route anyway; both are named so a
    // half-created run still cleans up after itself.
    if (workspaceId) await admin().from("slack_workspaces").delete().eq("id", workspaceId);
  });

  it("refuses an unsigned request, and a wrongly signed one, with the same 401", async () => {
    if (!up || !workspaceId) return;
    const body = `team_id=${TEAM_ID}&command=%2Fitest&text=hi&response_url=https%3A%2F%2Fhooks.slack.com%2Fservices%2Fitest`;
    expect((await post("/api/slack/command", body, { noSignature: true })).status).toBe(401);
    expect((await post("/api/slack/command", body, { badSignature: true })).status).toBe(401);
    const event = JSON.stringify({ type: "event_callback", team_id: TEAM_ID });
    expect(
      (await post("/api/slack/events", event, { json: true, badSignature: true })).status,
    ).toBe(401);
  });

  it("answers the Events API handshake with the challenge, once it is signed", async () => {
    if (!up || !workspaceId) return;
    const challenge = `itest-${Date.now()}`;
    const body = JSON.stringify({ type: "url_verification", challenge });
    const signed = await post("/api/slack/events", body, { json: true });
    expect(signed.status).toBe(200);
    expect(JSON.parse(signed.text)).toEqual({ challenge });
    // Unsigned, the handshake is refused like everything else.
    expect((await post("/api/slack/events", body, { json: true, noSignature: true })).status).toBe(
      401,
    );
  });

  it("acknowledges a routed command at once, and runs the agent behind it", async () => {
    if (!up || !workspaceId || !routeId) return;
    const body =
      `team_id=${TEAM_ID}&command=%2Fitest&text=reply+with+the+single+word+ready` +
      `&response_url=https%3A%2F%2Fhooks.slack.com%2Fservices%2Fitest&user_name=itest&user_id=UITEST&channel_id=C1`;
    const started = Date.now();
    const res = await post("/api/slack/command", body);
    // Slack shows an error if this takes longer than three seconds, and a turn
    // takes thirty to ninety — so the ack cannot be waiting for the answer.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(res.status).toBe(200);
    const ack = JSON.parse(res.text) as { response_type: string; blocks: unknown[] };
    expect(ack.response_type).toBe("in_channel");
    expect(JSON.stringify(ack.blocks)).toContain("Working on");

    // The turn itself runs out of band. Give it time, then read the audit row
    // it leaves — which is the only observable end of it here, because the
    // answer goes to a Slack host this test does not own.
    await new Promise((r) => setTimeout(r, 45_000));
    const { data: events } = await admin()
      .from("audit_events")
      .select("action, detail")
      .eq("resource_id", workspaceId)
      .eq("action", "slack.command")
      .order("created_at", { ascending: false })
      .limit(1);
    const row = events?.[0] as { detail?: Record<string, unknown> } | undefined;
    expect(row, "no slack.command audit row was written").toBeTruthy();
    expect(row?.detail?.command).toBe("/itest");
    expect(row?.detail?.asked_by).toBe("itest");
    expect(String(row?.detail?.target)).toMatch(/^agent:/);
    // Whether the model answered or the provider refused, the row says which,
    // and a success names the agent that answered.
    if (row?.detail?.status === "success") expect(row.detail.target_name).toBe(agentName);
  }, 90_000);

  it("acknowledges and drops a retry rather than answering twice", async () => {
    if (!up || !workspaceId) return;
    const body = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      authorizations: [{ user_id: "UBOT" }],
      event: { type: "app_mention", user: "UITEST", text: "<@UBOT> hi", channel: "C1", ts: "1.1" },
    });
    const res = await post("/api/slack/events", body, { json: true, retry: true });
    expect(res.status).toBe(200);
    // A mention with no bot token cannot be answered at all; the workspace row
    // is where that is recorded, and a dropped retry must not touch it.
    const { data } = await admin()
      .from("slack_workspaces")
      .select("last_event_at")
      .eq("id", workspaceId)
      .maybeSingle();
    expect(data?.last_event_at ?? null).toBeNull();
  });

  it("records why a mention could not be answered without a bot token", async () => {
    if (!up || !workspaceId) return;
    const body = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      authorizations: [{ user_id: "UBOT" }],
      event: { type: "app_mention", user: "UITEST", text: "<@UBOT> hi", channel: "C1", ts: "1.2" },
    });
    expect((await post("/api/slack/events", body, { json: true })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2_000));
    const { data } = await admin()
      .from("slack_workspaces")
      .select("last_error")
      .eq("id", workspaceId)
      .maybeSingle();
    expect(String(data?.last_error ?? "")).toContain("bot token");
  }, 20_000);
});
