// Shared helper for recording server-side LLM usage into execution_traces
// from code that doesn't go through /api/chat (BI Agent, KB ingestion,
// memory work, embeddings, etc.). Uses supabaseAdmin so we can attribute
// rows to a user_id without needing the user's bearer token in scope, while
// still respecting the existing RLS read policy (auth.uid() = user_id) for
// the analytics dashboard.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { bodyJson, bodyText } from "@/utils/observability/redaction.server";
import { approxTokens, isImageModel } from "./pricing";
import { priceCall } from "./priceResolver";

export type GatewayCallSurface =
  | "BI Agent: Plan"
  | "BI Agent: SQL"
  | "BI Agent: Chart"
  | "BI Agent: Narrative"
  | "BI Agent: Suggestions"
  | "BI Agent: Generic"
  | "Memory: Summarize"
  | "Memory: Extract"
  | "KB: Embedding"
  | "KB: Graph Build"
  | "KB: Ingest URL"
  | "KB: Ingest GitHub"
  | "Skills: Generate"
  | "Tools: Generate"
  | "Exam: Evaluate"
  | "Exam: Generate Set"
  | "Templates: Provision"
  | "Chat: tool-round"
  | (string & {});

export type UsageKind = "text" | "embedding" | "image";

export type RecordGatewayCallArgs = {
  userId: string;
  surface: GatewayCallSurface;
  model: string;
  // Provide explicit token counts when the upstream returns them. If absent,
  // pass `promptText` / `responseText` and we'll approximate.
  tokensIn?: number;
  tokensOut?: number;
  promptText?: string;
  responseText?: string;
  // For image generations: number of images produced (used to compute cost).
  imageCount?: number;
  latencyMs?: number;
  status?: "success" | "error";
  errorMessage?: string | null;
  kind?: UsageKind; // defaults: image if model is image; embedding via callers; else text
  parentTraceId?: string | null;
  requestPreview?: unknown;
  responsePreview?: unknown;
  agentId?: string | null;
  /**
   * Which credential this call was made through, when it wasn't a signed-in
   * user acting directly (embed key, swarm API key). Recorded on the trace so
   * per-credential budgets are computable — see budgetGuard.server.ts.
   */
  costScope?: { type: "embed_key" | "swarm_api_key"; id: string } | null;
  // Which backend actually served the call. Defaults to "openrouter" since
  // that's the shared default provider for all internal/background calls;
  // pass the real provider id when a caller knows it (e.g. "openai" for
  // embeddings).
  provider?: string;
};

function tokensFromText(t?: string): number {
  return approxTokens(t);
}

export async function recordGatewayCall(args: RecordGatewayCallArgs): Promise<void> {
  try {
    if (!args.userId) return;
    const kind: UsageKind = args.kind ?? (isImageModel(args.model) ? "image" : "text");
    const tokensIn = args.tokensIn ?? tokensFromText(args.promptText);
    const tokensOut = args.tokensOut ?? tokensFromText(args.responseText);
    const status = args.status ?? "success";

    // Priced through the resolver so the PROVIDER counts. The trace has always
    // recorded llm_provider and the price lookup ignored it, so the same model
    // cost the same on Bedrock, on Anthropic direct and through OpenRouter's
    // margin — three different numbers in reality.
    const provider = args.provider ?? "openrouter";
    const priced = priceCall({
      provider,
      model: args.model,
      kind,
      tokensIn,
      tokensOut,
      imageCount: args.imageCount,
    });
    const costUsd = priced.costUsd;

    const requestPayload: Record<string, unknown> = {
      surface: args.surface,
      kind,
    };
    // Same measured-vs-estimated marker as the chat path: absent explicit
    // token counts mean the chars/4 fallback produced these numbers.
    if (args.tokensIn == null || args.tokensOut == null) requestPayload.tokens_estimated = true;
    // A model with no entry in the price table costs 0, and 0 is
    // indistinguishable from "cheap" once it reaches a report or a budget
    // comparison. getBudgetDecision sums cost_usd, so an unpriced model never
    // accumulates, the monthly total stays under the limit for ever and the
    // hard stop never fires. Marked on the trace so the spend figure can say it
    // is incomplete rather than quietly being wrong.
    if (!priced.priced) requestPayload.pricing_missing = true;
    else requestPayload.price_source = priced.source;
    if (args.parentTraceId) requestPayload.parent_trace_id = args.parentTraceId;
    if (typeof args.imageCount === "number") requestPayload.image_count = args.imageCount;
    if (args.requestPreview !== undefined) requestPayload.preview = args.requestPreview;

    const responsePayload: Record<string, unknown> = {};
    if (args.responsePreview !== undefined) responsePayload.preview = args.responsePreview;

    const insertRow = {
      user_id: args.userId,
      agent_id: args.agentId ?? null,
      // Real column, not just jsonb: the /traces UI nests child rounds under
      // their parent turn and the OTel exporter joins them into one
      // distributed trace, both by indexed lookup.
      parent_trace_id: args.parentTraceId ?? null,
      agent_name: args.surface,
      llm_provider: provider,
      llm_model: args.model,
      prompt: bodyText(args.promptText ? args.promptText.slice(0, 4000) : null),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: args.latencyMs ?? 0,
      cost_usd: costUsd,
      status,
      error_message: args.errorMessage ?? null,
      request_payload: bodyJson(requestPayload),
      response_payload: bodyJson(responsePayload),
      tool_calls: [],
      cost_scope_type: args.costScope?.type ?? null,
      cost_scope_id: args.costScope?.id ?? null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin.from("execution_traces") as any).insert(insertRow);
    if (error) {
      console.error("[recordGatewayCall] insert failed:", error.message, "surface:", args.surface);
    }

    // Fire-and-forget: check the user's monthly AI spend cap and email
    // them if they've crossed an alert threshold or hit the hard cap.
    // Must never block or throw — runs after every traced call.
    try {
      const { checkAndNotifyBudget, checkAndNotifyGroupBudgets } =
        await import("@/lib/email/budgetAlertTrigger.server");
      void checkAndNotifyBudget(args.userId);
      // Team caps warn on the same path. Enforcement for groups already
      // existed; only the warning did not, so a team went from 0% to blocked
      // with nobody told.
      void checkAndNotifyGroupBudgets(args.userId);
    } catch (e) {
      console.error("[recordGatewayCall] budget alert check failed to load:", e);
    }
  } catch (e) {
    console.error("[recordGatewayCall] exception:", e);
  }
}

// Helper: pull token usage from an OpenAI-compatible non-streaming response.
export function extractUsage(json: unknown): { tokensIn: number; tokensOut: number } | null {
  if (!json || typeof json !== "object") return null;
  const u = (json as { usage?: Record<string, unknown> }).usage;
  if (!u || typeof u !== "object") return null;
  const tin = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const tout = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!tin && !tout) return null;
  return { tokensIn: Math.max(0, tin | 0), tokensOut: Math.max(0, tout | 0) };
}
