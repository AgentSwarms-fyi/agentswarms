// Lifecycle for published MCP servers: cold start, deploy, stop, logs.
//
// A running MCP server is a `notebook_runtime_sessions` row of kind 'service',
// so it inherits the existing sandbox hardening, reconcile loop and reaper
// rather than growing a second copy of all of it. What lives here is only what
// is genuinely different: scale-to-zero cold starts, the start lease, and the
// deploy handshake that records what tools the server actually exposes.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  canUseRuntime,
  countLiveServices,
  countLiveServicesTotal,
  getRuntimeSettings,
  mcpServiceCaps,
} from "@/utils/notebookRuntime/config.server";
import {
  LIVE,
  refreshSession,
  startSession,
  stopSession,
  type SessionRow,
} from "@/utils/notebookRuntime/service.server";
import { getOrchestrator, MCP_SERVICE_PATH } from "@/utils/notebookRuntime/orchestrator";
import {
  MCP_PROTOCOL_VERSION,
  parseJsonOrSse,
  isLegacyFingerprint,
  toolsFingerprint,
  toolsFromListResult,
  type McpTool,
} from "./protocol";

export type McpAppRow = Database["public"]["Tables"]["mcp_apps"]["Row"];

/** How long we will wait for a sandbox to come up before giving the caller a 503. */
const COLD_START_MS = 45_000;
const POLL_MS = 750;

/**
 * Staleness window on the start lease.
 *
 * The lease is the app row's own `status = 'deploying'`, so a process that dies
 * mid-start would wedge the app forever without a TTL. Comfortably longer than
 * a cold start, short enough that a crash self-heals within a minute or two.
 */
const LEASE_TTL_MS = 120_000;

export type EnsureResult =
  | { ok: true; endpoint: string; session: SessionRow }
  | { ok: false; status: number; error: string; message: string };

function fail(status: number, error: string, message: string): EnsureResult {
  return { ok: false, status, error, message };
}

/** The newest live sandbox for this app, if any. */
async function liveSession(appId: string): Promise<SessionRow | null> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("*")
    .eq("mcp_app_id", appId)
    .eq("kind", "service")
    .in("status", [...LIVE])
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

/**
 * Claim the right to start this app's sandbox.
 *
 * A single conditional UPDATE on the app row: concurrent updates to one row
 * serialize in Postgres, so exactly one replica sees a matching row and the
 * rest see zero. Without this, two app instances taking a simultaneous first
 * request would each cold-start a container and one would be orphaned.
 */
async function acquireStartLease(appId: string): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - LEASE_TTL_MS).toISOString();
  const { data } = await supabaseAdmin
    .from("mcp_apps")
    .update({ status: "deploying", deploy_error: null })
    .eq("id", appId)
    .or(`status.neq.deploying,updated_at.lt.${staleCutoff}`)
    .select("id");
  return Array.isArray(data) && data.length > 0;
}

async function setAppStatus(
  appId: string,
  status: McpAppRow["status"],
  deployError?: string | null,
): Promise<void> {
  await supabaseAdmin
    .from("mcp_apps")
    .update({ status, deploy_error: deployError ?? null })
    .eq("id", appId);
}

/** Poll a session until it is serving, it dies, or we run out of patience. */
async function waitReady(session: SessionRow, deadline: number): Promise<SessionRow | null> {
  let row = session;
  while (Date.now() < deadline) {
    row = await refreshSession(row);
    if (row.status === "ready" && row.endpoint) return row;
    if (["stopped", "error", "succeeded"].includes(row.status)) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

/**
 * Return a live endpoint for this app, cold-starting the sandbox if needed.
 *
 * Scale-to-zero means the first call after an idle period pays the start cost;
 * every later call finds the session already ready and does one DB read.
 */
export async function ensureRunning(app: McpAppRow): Promise<EnsureResult> {
  const settings = await getRuntimeSettings();
  if (!settings.enabled) {
    return fail(
      503,
      "runtime_disabled",
      "The server runtime is not enabled on this instance, so MCP servers cannot run.",
    );
  }
  // Re-checked on every cold start, not only at deploy time: revoking an
  // owner's runtime grant has to actually stop their published servers, and
  // this is the one place every path (edge request, test console, deploy)
  // funnels through.
  if (!(await canUseRuntime(app.user_id))) {
    return fail(
      403,
      "not_permitted",
      "The owner of this MCP server no longer has access to the server runtime.",
    );
  }

  const deadline = Date.now() + COLD_START_MS;

  const existing = await liveSession(app.id);
  if (existing) {
    const ready = await waitReady(existing, deadline);
    if (ready?.endpoint) {
      await touch(ready.id);
      return { ok: true, endpoint: ready.endpoint, session: ready };
    }
    // It died while we watched. Fall through and start a fresh one rather than
    // reporting a failure the next request would have fixed anyway.
  }

  if (!(await acquireStartLease(app.id))) {
    // Another replica is starting it. Wait for its session to appear rather
    // than racing it into a second container.
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const s = await liveSession(app.id);
      if (!s) continue;
      const ready = await waitReady(s, deadline);
      if (ready?.endpoint) {
        await touch(ready.id);
        return { ok: true, endpoint: ready.endpoint, session: ready };
      }
      break;
    }
    return fail(503, "starting", "The MCP server is still starting — retry in a few seconds.");
  }

  try {
    const caps = mcpServiceCaps();
    if ((await countLiveServices(app.user_id)) >= caps.perUser) {
      await setAppStatus(app.id, "error", `Per-user limit of ${caps.perUser} running MCP servers`);
      return fail(
        429,
        "user_limit",
        `You already have ${caps.perUser} MCP servers running (the per-user limit). Stop one and try again.`,
      );
    }
    if ((await countLiveServicesTotal()) >= caps.total) {
      await setAppStatus(app.id, "error", "Instance is at MCP server capacity");
      return fail(
        503,
        "at_capacity",
        "This instance is at MCP server capacity — try again shortly.",
      );
    }

    const { session } = await startSession({
      userId: app.user_id,
      mcpAppId: app.id,
      kind: "service",
      restartOnFailure: app.keep_warm,
    });

    const ready = await waitReady(session, deadline);
    if (!ready?.endpoint) {
      const logs = await logsOf(app.id).catch(() => "");
      await stopSession(session).catch(() => {});
      await setAppStatus(app.id, "error", firstError(logs) || "The server did not start in time");
      return fail(
        503,
        "start_failed",
        "The MCP server did not start. Check its logs for the Python error.",
      );
    }

    await setAppStatus(app.id, "ready");
    return { ok: true, endpoint: ready.endpoint, session: ready };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setAppStatus(app.id, "error", message);
    return fail(503, "start_failed", message);
  }
}

/**
 * Mark the sandbox as still wanted.
 *
 * Idle reaping reads `last_active_at`, so without this a busy MCP server would
 * be torn down mid-traffic simply because nothing had refreshed its row.
 */
async function touch(sessionId: string): Promise<void> {
  await supabaseAdmin
    .from("notebook_runtime_sessions")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", sessionId);
}

/**
 * Endpoint of an ALREADY-running sandbox, or null.
 *
 * Unlike ensureRunning() this never starts anything — for work that is only
 * worth doing if the server happens to be up (session teardown), cold-starting
 * a container to tell it about a session it has already forgotten is pure cost.
 */
export async function runningEndpoint(appId: string): Promise<string | null> {
  const session = await liveSession(appId);
  if (!session || session.status !== "ready") return null;
  return session.endpoint ?? null;
}

/** Stop whatever sandbox this app is running (no-op when already stopped). */
export async function stopApp(appId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("*")
    .eq("mcp_app_id", appId)
    .in("status", [...LIVE]);
  for (const row of data ?? []) await stopSession(row).catch(() => {});
  await setAppStatus(appId, "stopped");
}

/** Container stdout/stderr for the owner's Logs tab. */
export async function logsOf(appId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_sessions")
    .select("container_ref, logs")
    .eq("mcp_app_id", appId)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return "";
  if (row.container_ref) {
    try {
      const orch = await getOrchestrator(await getRuntimeSettings());
      const live = await orch.logs(row.container_ref);
      if (live) return live;
    } catch {
      /* container already gone — fall back to whatever was captured at teardown */
    }
  }
  return row.logs ?? "";
}

/** First Python error line in a log blob, for a one-line status message. */
function firstError(logs: string): string {
  const line = logs
    .split("\n")
    .reverse()
    .find((l) => /Error|Exception|Traceback/i.test(l));
  return line?.trim().slice(0, 300) ?? "";
}

// ── MCP handshake against our own sandbox ───────────────────────────────────

/**
 * initialize → notifications/initialized → tools/list.
 *
 * No SSRF guard: unlike /mcp's user-supplied endpoints, this URL comes from the
 * orchestrator's view of a container we started ourselves and is never
 * influenced by request input.
 */
export async function handshake(
  endpoint: string,
): Promise<{ ok: true; tools: McpTool[] } | { ok: false; message: string }> {
  const url = `${endpoint}${MCP_SERVICE_PATH}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // The Streamable HTTP spec requires clients to accept BOTH.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };

  const post = async (body: unknown, sessionId?: string | null) =>
    fetch(url, {
      method: "POST",
      headers: sessionId ? { ...headers, "Mcp-Session-Id": sessionId } : headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

  try {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agentswarms-mcp-builder", version: "1.0.0" },
      },
    });
    if (!init.ok) return { ok: false, message: `initialize → HTTP ${init.status}` };
    const sessionId = init.headers.get("Mcp-Session-Id");
    await init.text().catch(() => "");

    await post(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      sessionId,
    ).catch(() => null);

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    if (!list.ok) return { ok: false, message: `tools/list → HTTP ${list.status}` };
    const parsed = parseJsonOrSse(await list.text(), list.headers.get("content-type") ?? "");
    if (parsed?.error?.message)
      return { ok: false, message: `tools/list → ${parsed.error.message}` };
    return { ok: true, tools: toolsFromListResult(parsed) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "handshake failed" };
  }
}

export type DeployResult =
  | { ok: true; tools: McpTool[]; toolsChanged: boolean }
  | { ok: false; error: string; logs: string };

/**
 * Restart an app on its current source and record what it exposes.
 *
 * Always tears the old sandbox down first: the source is baked into the process
 * at import time, so a running container would keep serving the previous code
 * and "Deploy" would appear to do nothing.
 */
export async function deploy(app: McpAppRow): Promise<DeployResult> {
  await stopApp(app.id);

  const started = await ensureRunning(app);
  if (!started.ok) {
    return { ok: false, error: started.message, logs: await logsOf(app.id).catch(() => "") };
  }

  const shook = await handshake(started.endpoint);
  if (!shook.ok) {
    await setAppStatus(app.id, "error", shook.message);
    return { ok: false, error: shook.message, logs: await logsOf(app.id).catch(() => "") };
  }

  const hash = toolsFingerprint(shook.tools);
  // Only a *change* counts — a first deploy has nothing to have drifted from,
  // so it must not open with a scary re-approval banner.
  //
  // A hash written by an older algorithm is not a change either: it cannot be
  // compared with a new one, and flagging every existing app at once would
  // train owners to click through the diff, which is the habit a real rug pull
  // relies on. It is upgraded in place instead. The one-deploy cost is that a
  // tool change made in the SAME deploy as the upgrade is not flagged.
  const toolsChanged =
    Boolean(app.tools_hash) && !isLegacyFingerprint(app.tools_hash) && app.tools_hash !== hash;
  const now = new Date().toISOString();

  await supabaseAdmin
    .from("mcp_apps")
    .update({
      tools: shook.tools as unknown as Database["public"]["Tables"]["mcp_apps"]["Update"]["tools"],
      tools_hash: hash,
      status: "ready",
      deploy_error: null,
      last_deployed_at: now,
      ...(toolsChanged ? { tools_changed_at: now } : {}),
      // A first deploy is implicitly approved by the act of deploying it.
      ...(app.tools_hash ? {} : { tools_approved_at: now }),
    })
    .eq("id", app.id);

  await snapshotVersion(app, shook.tools);

  return { ok: true, tools: shook.tools, toolsChanged };
}

/** Append an immutable version row for this deploy. */
async function snapshotVersion(app: McpAppRow, tools: McpTool[]): Promise<void> {
  const { data: last } = await supabaseAdmin
    .from("mcp_app_versions")
    .select("version")
    .eq("app_id", app.id)
    .order("version", { ascending: false })
    .limit(1);
  const next = (last?.[0]?.version ?? 0) + 1;
  await supabaseAdmin.from("mcp_app_versions").insert({
    app_id: app.id,
    user_id: app.user_id,
    version: next,
    source_code: app.source_code,
    requirements: app.requirements,
    tools: tools as unknown as Database["public"]["Tables"]["mcp_app_versions"]["Insert"]["tools"],
  });
}
