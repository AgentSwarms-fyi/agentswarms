// Slack as an agent channel: which target answers a slash command, what is
// left of a message once Slack's markup is out, which events are worth
// answering at all, and the wiring that keeps both endpoints honest — verify
// before parse, acknowledge inside three seconds, run as the workspace owner,
// audit what was asked and by whom.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CHANNEL_TARGET_TYPES,
  channelTargetMissing,
  isAnswerableSlackEvent,
  isSlackRetry,
  normalizeSlashCommand,
  routeForCommand,
  slackMessageText,
  type SlackRoute,
} from "@/utils/channels/core";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const route = (over: Partial<SlackRoute> = {}): SlackRoute => ({
  command: "/support",
  target_type: "agent",
  target_id: "agent-1",
  is_active: true,
  ...over,
});

describe("a slash command", () => {
  it("normalises to one lowercase form, so a route and a request meet", () => {
    expect(normalizeSlashCommand("/ask")).toBe("/ask");
    expect(normalizeSlashCommand("ask")).toBe("/ask");
    expect(normalizeSlashCommand("  /Ask  ")).toBe("/ask");
    expect(normalizeSlashCommand("//ask")).toBe("/ask");
    expect(normalizeSlashCommand("data-help")).toBe("/data-help");
    expect(normalizeSlashCommand("ask_2")).toBe("/ask_2");
  });

  it("refuses what Slack cannot send, when it is saved rather than when it is used", () => {
    for (const bad of ["", "/", "   ", "/ask me", "/ask?", "-lead", "/" + "x".repeat(33), null]) {
      expect(normalizeSlashCommand(bad), String(bad)).toBeNull();
    }
    expect(normalizeSlashCommand(undefined)).toBeNull();
    expect(normalizeSlashCommand(42 as unknown as string)).toBeNull();
  });
});

describe("who answers", () => {
  it("a route wins, and it is matched however the command was typed", () => {
    const routes = [route()];
    expect(routeForCommand("/support", routes, "analyst-1")).toEqual({
      type: "agent",
      id: "agent-1",
    });
    expect(routeForCommand("/SUPPORT", routes, "analyst-1")).toEqual({
      type: "agent",
      id: "agent-1",
    });
  });

  it("falls back to the workspace analyst, which is what every install had", () => {
    // No route for this command.
    expect(routeForCommand("/ask", [route()], "analyst-1")).toEqual({
      type: "analyst",
      id: "analyst-1",
    });
    // No routes at all.
    expect(routeForCommand("/ask", [], "analyst-1")).toEqual({ type: "analyst", id: "analyst-1" });
    // An inactive route is as good as none.
    expect(routeForCommand("/support", [route({ is_active: false })], "analyst-1")).toEqual({
      type: "analyst",
      id: "analyst-1",
    });
  });

  it("is nobody when there is neither a route nor an analyst, and says so", () => {
    expect(routeForCommand("/ask", [], null)).toBeNull();
    expect(routeForCommand("/support", [route({ is_active: false })], undefined)).toBeNull();
    expect(channelTargetMissing(null)).toMatch(/Integrations → Slack/);
    expect(channelTargetMissing("agent")).toMatch(/agent/);
    expect([...CHANNEL_TARGET_TYPES]).toEqual(["agent", "analyst"]);
  });
});

describe("what the person actually asked", () => {
  it("takes out the bot mention, the markup and the entities", () => {
    expect(slackMessageText("<@U123ABC> what was revenue last month?")).toBe(
      "what was revenue last month?",
    );
    expect(slackMessageText("<@U1|bot> hi <@U2> there")).toBe("hi there");
    // A channel mention keeps its label; a bare one goes.
    expect(slackMessageText("compare <#C1|finance> and <#C2>")).toBe("compare finance and");
    // A link keeps the text a human wrote, or the URL when there is none.
    expect(slackMessageText("see <https://x.test/a|the report>")).toBe("see the report");
    expect(slackMessageText("see <https://x.test/a>")).toBe("see https://x.test/a");
    // Slack escapes these three; a model should read what was typed.
    expect(slackMessageText("a &amp; b &lt; c &gt; d")).toBe("a & b < c > d");
    expect(slackMessageText("<!here> anyone?")).toBe("anyone?");
    expect(slackMessageText("   spaced   out   ")).toBe("spaced out");
    expect(slackMessageText(null)).toBe("");
    expect(slackMessageText("<@U123ABC>")).toBe("");
  });
});

describe("which events are worth answering", () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    type: "app_mention",
    user: "U1",
    text: "hello",
    ...over,
  });

  it("answers a mention and a direct message", () => {
    expect(isAnswerableSlackEvent(ev(), "UBOT")).toBe(true);
    expect(isAnswerableSlackEvent(ev({ type: "message", channel_type: "im" }), "UBOT")).toBe(true);
  });

  it("stays out of everything else", () => {
    // A plain channel message is not addressed to the bot.
    expect(isAnswerableSlackEvent(ev({ type: "message", channel_type: "channel" }), "UBOT")).toBe(
      false,
    );
    // Another bot: two bots in one channel would answer each other for as
    // long as the workspace can afford it.
    expect(isAnswerableSlackEvent(ev({ bot_id: "B1" }), "UBOT")).toBe(false);
    // Its own message, by user id.
    expect(isAnswerableSlackEvent(ev({ user: "UBOT" }), "UBOT")).toBe(false);
    // An edit is not a new question.
    expect(isAnswerableSlackEvent(ev({ subtype: "message_changed" }), "UBOT")).toBe(false);
    expect(isAnswerableSlackEvent(ev({ text: "   " }), "UBOT")).toBe(false);
    expect(isAnswerableSlackEvent(null, "UBOT")).toBe(false);
    expect(isAnswerableSlackEvent({ type: undefined }, "UBOT")).toBe(false);
  });

  it("drops a retry, because the first delivery is still being answered", () => {
    expect(isSlackRetry("1")).toBe(true);
    expect(isSlackRetry("3")).toBe(true);
    expect(isSlackRetry(null)).toBe(false);
    expect(isSlackRetry("")).toBe(false);
    expect(isSlackRetry(undefined)).toBe(false);
  });
});

describe("the wiring", () => {
  it("both endpoints verify the raw body before they trust any of it", () => {
    for (const f of ["src/routes/api/slack.command.ts", "src/routes/api/slack.events.ts"]) {
      const src = rd(f);
      expect(src, f).toContain("const rawBody = await request.text();");
      expect(src, f).toContain("verifySlackRequest({");
      // Every failure is the same terse 401: an endpoint that explained itself
      // would be telling a prober which workspaces exist.
      expect(src, f).toContain('return new Response("Unauthorized", { status: 401 });');
    }
    // The command endpoint finds the workspace before it can verify, and does
    // not trust that parse for anything else.
    expect(rd("src/routes/api/slack.command.ts")).toContain(
      'const teamId = new URLSearchParams(rawBody).get("team_id");',
    );
  });

  it("answers out of band and acknowledges inside Slack's three seconds", () => {
    const cmd = flat(rd("src/routes/api/slack.command.ts"));
    expect(cmd).toContain("void (async () => {");
    expect(cmd).toContain("blocks: ackBlocks(cmd.text)");
    const events = flat(rd("src/routes/api/slack.events.ts"));
    expect(events).toContain("void (async () => {");
    // A retry arrives while the first attempt is still thinking.
    expect(events).toContain('isSlackRetry(request.headers.get("x-slack-retry-num"))');
    // An event has no response_url, so the answer goes back over the Web API,
    // in the thread it was asked in.
    expect(events).toContain("postSlackMessage({");
    expect(events).toContain("const threadTs = event.thread_ts ?? event.ts ?? null;");
  });

  it("runs the target as the workspace owner, through the one internal channel", () => {
    const run = flat(rd("src/utils/channels/run.server.ts"));
    expect(run).toContain("buildInternalChatBody({");
    // The agent is looked up among the OWNER's own; the service-role client
    // would otherwise happily return anyone's.
    expect(run).toContain('.eq("user_id", args.ownerId)');
    expect(run).toContain("if (!agent.is_active)");
    // A channel is not a key: it has no ceiling of its own.
    expect(run).not.toContain("costScope");
    expect(run).toContain('action: args.surface === "slack" ? "slack.command" : "teams.message"');
    expect(run).toContain("question: args.question.slice(0, 500)");
  });

  it("a route can only point at something its owner owns", () => {
    const fns = flat(rd("src/utils/slack.functions.ts"));
    expect(fns).toContain("normalizeSlashCommand(data.command)");
    // RLS stops a write to someone else's row; nothing stops writing someone
    // else's id into your own, and the endpoint would then answer as them.
    expect(fns).toContain('.eq("user_id", userId) .maybeSingle();');
    expect(fns).toContain('throw new Error("Pick an agent or analyst you own.");');
    // Both halves of the mention target or neither.
    expect(fns).toContain(
      "mention_target_type: data.mention_target_id ? (data.mention_target_type ?? null) : null,",
    );
  });

  it("the migration carries the table, its uniqueness and its audit trigger", () => {
    const mig = flat(rd("supabase/migrations/20260869000000_chat_channels.sql"));
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS public.slack_command_routes");
    expect(mig).toContain("UNIQUE (workspace_id, command)");
    expect(mig).toContain("target_type text NOT NULL CHECK (target_type IN ('agent', 'analyst'))");
    expect(mig).toContain("Users manage own slack command routes");
    expect(mig).toContain("audit_row_change('slack_command_route')");
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS mention_target_type text");
    expect(mig).toContain("audit_row_change('slack_workspace')");
  });

  it("the editor routes commands and names who answers a mention", () => {
    const card = flat(rd("src/components/integrations/SlackRoutingCard.tsx"));
    expect(card).toContain("Mentions and DMs");
    expect(card).toContain("Slash commands");
    expect(card).toContain("normalizeSlashCommand(d?.command)");
    // A workspace with no bot token cannot answer a mention at all.
    expect(card).toContain("Mentions need a bot token");
    const tab = flat(rd("src/components/integrations/SlackTab.tsx"));
    expect(tab).toContain("<SlackRoutingCard");
    expect(tab).toContain("/api/slack/events");
    expect(tab).toContain("app_mention");
  });

  it("the docs say what the endpoints do", () => {
    const doc = flat(rd("docs/AGENT_CHAT.md"));
    expect(doc).toContain("/api/slack/events");
    expect(doc).toContain("app_mention");
    expect(doc).toContain("chat:write");
    expect(flat(rd("src/routes/docs.playground.tsx"))).toContain("/api/slack/events");
  });
});
