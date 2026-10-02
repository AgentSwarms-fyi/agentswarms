// Teams as an agent channel: which activities are questions, what the
// question actually says once Teams' markup is out of it, and where the answer
// is allowed to go.
//
// The signature checking lives in teamsJwt.test.ts. What is pinned here is
// everything that happens after a request is known to be genuine — most
// importantly the two ways a bot can misbehave without any attacker at all: by
// answering its own messages for ever, and by answering activities that were
// never questions.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  TEAMS_MAX_TEXT,
  isAnswerableActivity,
  replyActivity,
  replyEndpoint,
  teamsMessageText,
  tenantAllowed,
  truncateForTeams,
  type TeamsActivity,
} from "@/lib/teamsActivity";
import { channelTargetMissing } from "@/utils/channels/core";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const activity = (over: Partial<TeamsActivity> = {}): TeamsActivity => ({
  type: "message",
  id: "1700000000000",
  text: "<at>Analyst</at> what were sales last week",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  conversation: { id: "19:meeting@thread.tacv2" },
  from: { id: "29:user", name: "Ada", aadObjectId: "aad-1" },
  recipient: { id: "28:bot", name: "Analyst" },
  channelData: { tenant: { id: "tenant-1" } },
  ...over,
});

describe("what counts as a question", () => {
  it("answers a message", () => {
    expect(isAnswerableActivity(activity())).toBe(true);
  });

  it("never answers its own message", () => {
    // Teams delivers the bot's own posts back to it. A bot that answers itself
    // never stops, and it is the failure that costs money while it happens.
    const echo = activity({ from: { id: "28:bot" }, recipient: { id: "28:bot" } });
    expect(isAnswerableActivity(echo)).toBe(false);
  });

  it("ignores everything that is not a message", () => {
    // Answering conversationUpdate greets an empty room; answering
    // messageReaction answers the bot's own last message.
    for (const type of ["conversationUpdate", "messageReaction", "typing", "invoke", "event"]) {
      expect(isAnswerableActivity(activity({ type })), type).toBe(false);
    }
  });

  it("ignores an activity with nothing to answer or nowhere to answer it", () => {
    expect(isAnswerableActivity(activity({ text: "<at>Analyst</at>" }))).toBe(false);
    expect(isAnswerableActivity(activity({ text: "   " }))).toBe(false);
    expect(isAnswerableActivity(activity({ serviceUrl: undefined }))).toBe(false);
    expect(isAnswerableActivity(activity({ conversation: {} }))).toBe(false);
    expect(isAnswerableActivity(null)).toBe(false);
  });
});

describe("what was actually asked", () => {
  it("takes the mention out and leaves the question alone", () => {
    // Left in, the agent is asked to interpret its own name as part of the
    // question — which it will dutifully try to do.
    expect(teamsMessageText(activity())).toBe("what were sales last week");
  });

  it("handles a mention with attributes, and a stray half of one", () => {
    expect(teamsMessageText(activity({ text: '<at id="0">My Bot</at> hello' }))).toBe("hello");
    expect(teamsMessageText(activity({ text: "</at> hello" }))).toBe("hello");
  });

  it("unescapes what Teams escaped, and nothing more", () => {
    expect(teamsMessageText(activity({ text: "rows where a &lt; b &amp;&amp; c &gt; d" }))).toBe(
      "rows where a < b && c > d",
    );
    // Markdown and punctuation are the person's words; paraphrasing a question
    // is the one thing this integration must never do.
    expect(teamsMessageText(activity({ text: "**net_usd** by region?" }))).toBe(
      "**net_usd** by region?",
    );
  });
});

describe("where the answer goes", () => {
  it("replies to the conversation it came from, in the same thread", () => {
    expect(replyEndpoint(activity())).toBe(
      "https://smba.trafficmanager.net/emea/v3/conversations/19%3Ameeting%40thread.tacv2/activities",
    );
    const reply = replyActivity(activity(), "42");
    expect(reply.replyToId).toBe("1700000000000");
    expect(reply).toMatchObject({ type: "message", text: "42" });
    expect((reply.conversation as { id: string }).id).toBe("19:meeting@thread.tacv2");
  });

  it("has nowhere to reply when the activity says nothing about where", () => {
    expect(replyEndpoint(activity({ serviceUrl: undefined }))).toBeNull();
    expect(replyEndpoint(activity({ conversation: {} }))).toBeNull();
  });

  it("truncates rather than being rejected whole", () => {
    const long = "x".repeat(TEAMS_MAX_TEXT + 500);
    const out = truncateForTeams(long);
    expect(out.length).toBeLessThanOrEqual(TEAMS_MAX_TEXT);
    expect(out).toMatch(/truncated/);
    expect(truncateForTeams("short")).toBe("short");
  });
});

describe("which tenant a bot serves", () => {
  it("lets a multi-tenant registration answer anyone", () => {
    expect(tenantAllowed(null, activity())).toBe(true);
  });

  it("refuses another organisation for a single-tenant registration", () => {
    // The token proves Microsoft sent it. It does not prove which organisation
    // it came from, and this bot answers about one company's data.
    expect(tenantAllowed("tenant-1", activity())).toBe(true);
    expect(tenantAllowed("tenant-1", activity({ channelData: { tenant: { id: "other" } } }))).toBe(
      false,
    );
    expect(tenantAllowed("tenant-1", activity({ channelData: {} }))).toBe(false);
  });
});

describe("the wiring", () => {
  const route = rd("src/routes/api/teams.messages.ts");
  const server = rd("src/utils/channels/teams.server.ts");
  const migration = rd("supabase/migrations/20260879000000_teams_bots.sql");

  it("verifies before it acts on anything in the activity", () => {
    // The order is the security: reading the activity first and trusting any
    // of it would be trusting the attacker's own JSON.
    const verifyAt = route.indexOf("await verifyTeamsToken(");
    expect(verifyAt).toBeGreaterThan(0);
    expect(verifyAt).toBeLessThan(route.indexOf("isAnswerableActivity(activity)"));
    expect(verifyAt).toBeLessThan(route.indexOf("answerForTarget("));
  });

  it("checks the token's serviceUrl against the ACTIVITY's", () => {
    // Passing the token's own value would make the check tautological — the
    // subtle way to have this code and no protection.
    expect(route).toContain("serviceUrl: activity.serviceUrl ?? null");
  });

  it("refuses everything the same way", () => {
    // A response that distinguished "unknown bot" from "bad signature" would
    // tell a prober which bots exist.
    expect(route).toContain('new Response("Unauthorized", { status: 401 })');
    expect(route).not.toMatch(/status:\s*40[34]/);
  });

  it("acknowledges immediately and answers later", () => {
    // Teams stops waiting after about fifteen seconds; a turn takes 30-95.
    expect(route).toContain("void (async () => {");
    expect(route).toContain('new Response("", { status: 200 })');
  });

  it("owns its table, owner-only, audited", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.teams_bots");
    expect(migration).toContain("ALTER TABLE public.teams_bots ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("auth.uid() = user_id");
    expect(migration).toContain("audit_row_change('teams_bot')");
    // One row per registration: two would make "whose agent answers?" a guess.
    expect(migration).toContain("UNIQUE (app_id)");
  });

  it("keeps the credential server-side and out of every summary", () => {
    const fns = rd("src/utils/teams.functions.ts");
    expect(fns).toContain("hasAppPassword");
    expect(fns).not.toContain("app_password_enc: r.app_password_enc");
    expect(server).toContain("decryptJson");
  });

  it("keeps a stored password when an edit does not mention one", () => {
    // Otherwise changing which agent answers silently stops it answering.
    const fns = rd("src/utils/teams.functions.ts");
    expect(fns).toContain("if (data.app_password) {");
  });

  it("mints its outbound token against the right authority", () => {
    // A single-tenant bot must authenticate against its own tenant; using the
    // multi-tenant authority is the difference that makes it never work.
    expect(server).toContain("login.microsoftonline.com/${encodeURIComponent(bot.tenant_id)}");
    expect(server).toContain("login.microsoftonline.com/botframework.com");
    expect(server).toContain("https://api.botframework.com/.default");
  });

  it("forgets a cached token when the password stops working", () => {
    expect(server).toContain("if (res.status === 401) forgetTeamsToken(args.bot.app_id)");
  });

  it("sends a person to the right settings page", () => {
    // This is the message someone reads when the bot cannot answer; pointing
    // them at Slack's page would be the whole failure.
    expect(channelTargetMissing(null, "teams")).toContain("Integrations → Teams");
    expect(channelTargetMissing(null)).toContain("Integrations → Slack");
  });

  it("is reachable where Slack is", () => {
    const page = rd("src/routes/_authenticated/integrations.tsx");
    expect(page).toContain("<TeamsTab />");
    expect(page).toContain('<TabsTrigger value="teams">Teams</TabsTrigger>');
  });

  it("runs the turn through the one shared path, as the owner", () => {
    // Not a second way to run an agent: same gateway body, same IAM rules,
    // budgets and traces as everywhere else.
    expect(route).toContain("answerForTarget(");
    expect(route).toContain("ownerId: bot.user_id");
    expect(route).toContain('surface: "teams"');
    expect(route).toContain("auditChannelTurn(");
  });
});
