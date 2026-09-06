// One turn, asked from a chat client.
//
// Nothing here is a second way to run an agent. The turn goes through
// /api/chat's internal channel with the body the AI gateway builds — the
// agent's prompt, its tools through the same mapping agent chat uses, its
// knowledge, its guardrails — as the channel OWNER, so IAM model rules,
// budgets, traces and audit apply exactly as they do in the app. The channel
// adds who asked and where, and the audit row that says so.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import type { AnalystTurn } from "@/lib/aiAnalyst";
import type { ChannelTarget } from "@/utils/channels/core";
import { buildInternalChatBody, type AgentRowForGateway } from "@/utils/gateway/api.server";
import { internalRunSecret, resolveInternalOrigin } from "@/utils/internalOrigin.server";
import { describeChatRefusal, readChatStream } from "@/utils/internalChat.server";

const AGENT_COLUMNS =
  "id, name, system_prompt, llm_provider, llm_model, temperature, max_tokens, knowledge_base_id, tools, is_active";

/** How long a chat client will wait before the person gives up on it anyway. */
const TURN_TIMEOUT_MS = 120_000;

export type ChannelSurface = "slack" | "teams";

export type ChannelAnswer =
  | { ok: true; text: string; traceId: string | null; targetName: string }
  | { ok: false; error: string };

/**
 * Run one agent turn for a channel.
 *
 * The agent is looked up among the OWNER's own — the service-role client
 * would otherwise happily return anyone's — and an inactive or deleted one
 * is a refusal in words, because the person in Slack cannot fix an id.
 */
export async function answerAsAgent(args: {
  ownerId: string;
  agentId: string;
  question: string;
  surface: ChannelSurface;
  /** Ties every model call, data read and cost of this turn together. */
  decisionId?: string;
}): Promise<ChannelAnswer> {
  const { data } = await supabaseAdmin
    .from("agents")
    .select(AGENT_COLUMNS)
    .eq("id", args.agentId)
    .eq("user_id", args.ownerId)
    .maybeSingle();
  const agent = data as AgentRowForGateway | null;
  if (!agent) return { ok: false, error: "That agent no longer exists." };
  if (!agent.is_active) return { ok: false, error: `The agent "${agent.name}" is paused.` };

  const secret = internalRunSecret();
  if (!secret) {
    return {
      ok: false,
      error: "Server is missing INTERNAL_RUN_SECRET / SUPABASE_SERVICE_ROLE_KEY.",
    };
  }

  const body = buildInternalChatBody({
    ownerId: args.ownerId,
    // No cost scope: a channel turn is simply the owner's spend, metered by
    // their own budgets. A key has a ceiling of its own; a Slack channel is
    // not a key.
    target: { kind: "agent", agent },
    candidate: { provider: agent.llm_provider, model: agent.llm_model },
    messages: [{ role: "user", content: args.question }],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const res = await fetch(`${resolveInternalOrigin()}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-internal-run-secret": secret },
      body: JSON.stringify({ ...body, decisionId: args.decisionId }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: describeChatRefusal(res.status, text, `${agent.llm_provider}/${agent.llm_model}`),
      };
    }
    const traceId = res.headers.get("X-Trace-Id");
    const { text } = await readChatStream(res.body);
    if (!text.trim()) {
      return { ok: false, error: "The agent produced no answer. Its trace has the detail." };
    }
    return { ok: true, text, traceId, targetName: agent.name };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: /abort/i.test(message)
        ? `The agent did not finish within ${Math.round(TURN_TIMEOUT_MS / 1000)} seconds.`
        : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type TargetAnswer =
  | { ok: true; kind: "agent"; text: string; targetName: string; traceId: string | null }
  | { ok: true; kind: "analyst"; turn: AnalystTurn; targetName: string }
  | { ok: false; error: string };

/**
 * Run whatever this channel points at.
 *
 * The two targets answer in different shapes on purpose - an analyst's steps
 * are the point of that surface, an agent's answer is prose - so the caller
 * renders, and this decides only who runs and whether it worked.
 */
export async function answerForTarget(args: {
  ownerId: string;
  target: ChannelTarget;
  question: string;
  surface: ChannelSurface;
  decisionId?: string;
}): Promise<TargetAnswer> {
  if (args.target.type === "agent") {
    const res = await answerAsAgent({
      ownerId: args.ownerId,
      agentId: args.target.id,
      question: args.question,
      surface: args.surface,
      decisionId: args.decisionId,
    });
    return res.ok
      ? {
          ok: true,
          kind: "agent",
          text: res.text,
          targetName: res.targetName,
          traceId: res.traceId,
        }
      : { ok: false, error: res.error };
  }
  const { runAnalystTurnServer } = await import("@/utils/analyst/run.server");
  const outcome = await runAnalystTurnServer({
    analystId: args.target.id,
    ownerId: args.ownerId,
    question: args.question,
    priorTurns: [],
    surface: args.surface,
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };
  return { ok: true, kind: "analyst", turn: outcome.turn, targetName: "the analyst" };
}

/**
 * The audit row a channel turn leaves, whichever target answered: who owns
 * the channel, which platform asked, who asked there, what it cost to find
 * and whether it worked. The question itself is recorded truncated — it is
 * the person's words, and the trace already holds the whole turn.
 */
export function auditChannelTurn(args: {
  ownerId: string;
  surface: ChannelSurface;
  channelId: string;
  channelName: string;
  target: ChannelTarget;
  targetName: string | null;
  question: string;
  status: "success" | "error";
  error?: string;
  traceId?: string | null;
  decisionId?: string;
  /** The Slack command that routed here, when one did. */
  command?: string | null;
  /** Who asked, as the platform names them. Not an AgentSwarms identity. */
  asker?: string | null;
}): void {
  auditEvent({
    userId: args.ownerId,
    action: args.surface === "slack" ? "slack.command" : "teams.message",
    resourceType: args.surface === "slack" ? "slack_workspace" : "teams_webhook",
    resourceId: args.channelId,
    resourceName: args.channelName,
    decisionId: args.decisionId,
    detail: {
      target: `${args.target.type}:${args.target.id}`,
      target_name: args.targetName,
      command: args.command ?? null,
      asked_by: args.asker ?? null,
      question: args.question.slice(0, 500),
      status: args.status,
      ...(args.error ? { error: args.error.slice(0, 500) } : {}),
      ...(args.traceId ? { trace_id: args.traceId } : {}),
    },
  });
}
