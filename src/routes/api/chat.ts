import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  streamWithProvider,
  resolveOpenAICompatTransport,
  type GatewayOverride,
} from "@/utils/providers/credentials.server";
import type { ProviderId } from "@/utils/providers/types";
import { notifyN8nWebhook } from "@/utils/integrations.functions";
import { resolveAgentTools, TOOLABLE_IDS, type ToolableId } from "@/utils/tools/registry.server";
import { streamChatWithTools, type ToolEvent } from "@/utils/tools/loop.server";
import { buildSources, type RawSource, type Source } from "@/utils/tools/sources";
import {
  type Guardrails,
  parseGuardrails,
  isAnyGuardrailActive,
  evaluateInputGuardrails,
  applyOutputGuardrails,
  type OutputDecision,
} from "@/utils/guardrails";
import { budgetMessage, getBudgetDecision } from "@/utils/budgetGuard.server";
import { internalSecretMatches } from "@/utils/internalOrigin.server";
import {
  resolveMemoryConfig,
  loadMemoryContext,
  composeSystemPrompt,
  type MemoryOverrides,
} from "@/utils/memory/memory.server";
import { summarizeIfNeeded } from "@/utils/memory/summarize.server";
import { extractMemoriesFromTurn } from "@/utils/memory/extract.server";
import type { RecalledItem } from "@/utils/memory/types";
import { isImageModelId } from "@/lib/providerSupport";
import { getEffectiveModelRules, isModelAllowed } from "@/utils/iam.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // Allow the browser to read X-Trace-Id from the response so the Playground
  // can deep-link the user to the real execution_traces row.
  "Access-Control-Expose-Headers": "X-Trace-Id",
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  // Allow string OR multi-part content so vision-capable models can receive
  // image_url parts from the playground attachment flow.
  content:
    | string
    | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

// Extract a plain-text version of a message's content. Used wherever we need
// to log, score, or pass the prompt to a non-vision-aware code path.
function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : `[image: ${p.image_url.url.slice(0, 60)}…]`))
    .join("\n");
}

type Citation = {
  index: number;
  documentId: string;
  documentName: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  snippet: string;
};

const VALID_PROVIDERS: ProviderId[] = [
  "bedrock",
  "vertex",
  "anthropic",
  "azure_openai",
  "oci_genai",
  "qwen",
  "grok",
  "openai",
  "gemini",
  "ollama",
  "openrouter",
  "groq",
  "vllm",
  "nvidia",
];

function getServerSupabase(authToken?: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined,
  });
}

async function getUserIdFromRequest(request: Request): Promise<string | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const sb = getServerSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getClaims(token);
  return data?.claims?.sub ?? null;
}

// A ~170-line keyword-based `retrieveCitations` used to sit here. It was dead:
// the live auto-RAG path calls retrieveCitationsServer from
// @/utils/tools/kb.server (see below), which is also what embed.chat.ts uses.
// Two functions with nearly the same name, one of them unreachable, in the
// file where you least want to wonder which one runs.

/** Auto-RAG hits as sources, keeping the numbers the model was shown. */
function citationSources(citations: Citation[]): Source[] {
  return citations.map((c) => ({
    index: c.index,
    kind: "kb" as const,
    title: c.documentName,
    detail: c.knowledgeBaseName,
    snippet: c.snippet,
  }));
}

// buildGroundingPrompt is shared with the embed widget — see kb.server.ts. It
// defangs SOURCES delimiters out of retrieved text, which a local copy here
// did not do.

// Emit the answer's SOURCES as a TRAILING event, once the text is known.
//
// It has to be a trailer, not a preamble: whether the auto-RAG knowledge-base
// hits count as sources depends on whether the finished answer actually cited
// them. Retrieval happens before the model runs, so a preamble could only ever
// report "documents we looked up", which is how a web-search answer ended up
// listing knowledge base documents underneath it.
function withSourcesTrailer(
  upstream: ReadableStream<Uint8Array> | null,
  kbSources: Source[],
  toolSources: RawSource[],
): ReadableStream<Uint8Array> | null {
  if (!upstream) return upstream;
  if (kbSources.length === 0 && toolSources.length === 0) return upstream;

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let answer = "";

  const consumeLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[];
      };
      const delta =
        parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      if (typeof delta === "string") answer += delta;
    } catch {
      /* ignore */
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            let line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            consumeLine(line);
          }
        }
        if (buffer.trim()) consumeLine(buffer.trim());
        const sources = buildSources(kbSources, toolSources, answer);
        if (sources.length > 0) {
          controller.enqueue(
            encoder.encode(`event: sources\ndata: ${JSON.stringify({ sources })}\n\n`),
          );
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// Prefix an SSE stream with a single custom citations event so the client
// can render them alongside the streamed answer.
function withCitationsPreamble(
  upstream: ReadableStream<Uint8Array> | null,
  citations: Citation[],
): ReadableStream<Uint8Array> | null {
  if (!upstream) return upstream;
  if (citations.length === 0) return upstream;
  const encoder = new TextEncoder();
  const preamble = encoder.encode(`event: citations\ndata: ${JSON.stringify({ citations })}\n\n`);
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preamble);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// Prefix an SSE stream with one or more custom `tool` events so the
// playground inspector can show which tools the model invoked.
function withToolEventsPreamble(
  upstream: ReadableStream<Uint8Array> | null,
  events: ToolEvent[],
): ReadableStream<Uint8Array> | null {
  if (!upstream) return upstream;
  if (events.length === 0) return upstream;
  const encoder = new TextEncoder();
  const preamble = events.map((e) => `event: tool\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(preamble));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// Prefix an SSE stream with a single `memory_used` event so the playground
// can render a "Memory: N items recalled" chip under the assistant message.
function withMemoryUsedPreamble(
  upstream: ReadableStream<Uint8Array> | null,
  recalled: RecalledItem[],
  summaryUsed: boolean,
): ReadableStream<Uint8Array> | null {
  if (!upstream) return upstream;
  if (recalled.length === 0 && !summaryUsed) return upstream;
  const encoder = new TextEncoder();
  const payload = {
    recalled: recalled.map((r) => ({ id: r.id, kind: r.kind, content: r.content })),
    summaryUsed,
  };
  const preamble = encoder.encode(`event: memory_used\ndata: ${JSON.stringify(payload)}\n\n`);
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preamble);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// Wrap the SSE stream so the assistant's accumulated text is fed into the
// memory subsystem on completion: rolling-summary update (STM) + LTM
// extraction. Best-effort — failures are logged, never surfaced to the user.
function withPostTurnMemory(
  upstream: ReadableStream<Uint8Array> | null,
  ctx: {
    userId: string;
    agentId: string | undefined;
    conversationId: string | undefined;
    authToken: string | undefined;
    config: import("@/utils/memory/types").MemoryConfig;
    userMessage: string;
    apiKey: string;
  },
): ReadableStream<Uint8Array> | null {
  if (!upstream) return upstream;
  if (!ctx.userId || !ctx.authToken) return upstream;
  const wantsSTM = ctx.config.stm_enabled && ctx.config.stm_summarize && ctx.conversationId;
  const wantsLTM = ctx.config.ltm_enabled && ctx.config.ltm_auto_extract && ctx.agentId;
  if (!wantsSTM && !wantsLTM) return upstream;

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";
  let assistantText = "";

  const consumeLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[];
      };
      const delta =
        parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      if (typeof delta === "string") assistantText += delta;
    } catch {
      /* ignore */
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          controller.enqueue(value);
          textBuffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = textBuffer.indexOf("\n")) !== -1) {
            let line = textBuffer.slice(0, idx);
            textBuffer = textBuffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            consumeLine(line);
          }
        }
        if (textBuffer.trim()) consumeLine(textBuffer.trim());

        // Post-turn memory work — must be awaited inside the request lifetime
        // because Worker runtimes kill fire-and-forget promises after the
        // response stream closes (same reason recordTrace awaits).
        const sb = getServerSupabase(ctx.authToken);
        if (sb && assistantText.trim()) {
          if (wantsSTM && ctx.conversationId) {
            try {
              await summarizeIfNeeded({
                sb,
                userId: ctx.userId,
                conversationId: ctx.conversationId,
                windowMessages: ctx.config.stm_window_messages,
                summaryModel: ctx.config.stm_summary_model,
                apiKey: ctx.apiKey,
              });
            } catch (e) {
              console.warn("[memory.post] summarize failed:", (e as Error).message);
            }
          }
          if (wantsLTM && ctx.agentId) {
            try {
              await extractMemoriesFromTurn({
                sb,
                userId: ctx.userId,
                agentId: ctx.agentId,
                conversationId: ctx.conversationId ?? null,
                userMessage: ctx.userMessage,
                assistantMessage: assistantText,
                apiKey: ctx.apiKey,
                maxItems: ctx.config.ltm_max_items,
              });
            } catch (e) {
              console.warn("[memory.post] extract failed:", (e as Error).message);
            }
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

// Wrap the SSE stream so we can observe the assistant's tokens as they arrive
// and record one execution_traces row per chat request. This is what makes
// the Traces / Analytics / Budgets pages light up for real chat runs (not
// just demo seeded rows).
type TraceContext = {
  traceId: string;
  userId: string | null;
  authToken?: string;
  agentId?: string;
  agentName: string;
  provider: string;
  model: string;
  promptText: string;
  promptTokensApprox: number;
  startedAt: number;
  requestPayload?: Record<string, unknown>;
  // Optional post-turn n8n notify config. Fires once after the assistant
  // reply finishes streaming, so workflows can log/route/react to the turn.
  n8nNotify?: {
    webhookUrl: string;
    authHeader?: string;
  };
};

// Token approximation + cost estimation live in a shared module so swarm
// runtime, BI Agent, KB ingestion, memory work, etc. all price the same
// model the same way.
import { bodyJson, bodyText } from "@/utils/observability/redaction.server";
import {
  MAX_BODY_CHARS,
  MAX_MESSAGES,
  isConversationTooLarge,
  sanitizeTraceValue,
} from "@/utils/observability/traceSanitize";

import { approxTokens, estimateImageCost, isImageModel } from "@/utils/observability/pricing";
import { priceCall } from "@/utils/observability/priceResolver";

function estimateCost(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  // The full resolver, not the small bundled table: this writer produces most
  // execution_traces rows, and the table-only estimateTextCost silently wrote
  // $0 for anything it didn't list — gateway-decorated ids
  // (~anthropic/claude-haiku-latest), "-latest" aliases, every gemini model —
  // with no pricing_missing marker, so the reprice sweep couldn't find them
  // and budgets summed real spend as free.
  const priced = priceCall({ provider, model, kind: "text", tokensIn, tokensOut });
  return priced.costUsd;
}

/** True when nothing knows this model's rate — recorded so $0 is explainable. */
function costUnpriced(provider: string, model: string): boolean {
  return !priceCall({ provider, model, kind: "text", tokensIn: 0, tokensOut: 0 }).priced;
}

async function recordTrace(opts: {
  trace: TraceContext;
  status: "success" | "error" | "cancelled";
  errorMessage?: string;
  assistantText: string;
  skipResponsePayload?: boolean;
  // Optional upstream-reported usage. When set, used in preference to the
  // chars/4 approximation for far more accurate analytics + budgets.
  upstreamTokensIn?: number;
  upstreamTokensOut?: number;
  // Number of generated images detected in the assembled response. Used to
  // price image models per-image instead of as text tokens.
  imageCount?: number;
  /**
   * The final answer was REPLAYED from the last tool round rather than
   * generated by a separate provider call. The tool-round child trace already
   * carries that call's real usage and cost, so this parent row must record
   * zero — otherwise the final answer is billed twice (the child's measured
   * usage plus this row's chars/4 estimate of a call that never happened).
   */
  replayedFinal?: boolean;
  /**
   * Aggregate usage across the turn's tool rounds (from the loop's
   * x-agentswarms-loop-usage-* headers). Never added to this row's BILLING
   * columns — the child traces already carry it — but stored in the payload
   * as turn_* so the trace inspector can show what the whole turn consumed.
   */
  loopUsage?: { tokensIn: number; tokensOut: number };
}) {
  const { trace, status, errorMessage, assistantText, skipResponsePayload } = opts;
  const userId = trace.userId;
  if (!userId) {
    console.log("[trace] skipped — no userId (anonymous request)");
    return;
  }
  const sb = getServerSupabase(trace.authToken);
  if (!sb) {
    console.warn("[trace] skipped — no supabase client");
    return;
  }
  const isImg = isImageModel(trace.model) || (opts.imageCount ?? 0) > 0;
  const tokensIn = opts.replayedFinal ? 0 : (opts.upstreamTokensIn ?? trace.promptTokensApprox);
  const tokensOut =
    isImg || opts.replayedFinal ? 0 : (opts.upstreamTokensOut ?? approxTokens(assistantText));
  // Whether the numbers above are measured (provider-reported usage) or the
  // chars/4 fallback. Recorded so spend precision is knowable after the fact
  // instead of every row looking equally authoritative.
  const tokensEstimated =
    !opts.replayedFinal && (opts.upstreamTokensIn == null || opts.upstreamTokensOut == null);
  const latencyMs = Date.now() - trace.startedAt;
  const costUsd = opts.replayedFinal
    ? 0
    : isImg
      ? estimateImageCost(trace.model, Math.max(1, opts.imageCount ?? 1))
      : estimateCost(trace.provider, trace.model, tokensIn, tokensOut);

  // Build request_payload defensively. Some keys (like full message arrays)
  // can be very large — truncate per-message content so we don't blow up
  // the row, but ALWAYS include the structure so the trace inspector has
  // something to render.
  const rawPayload = trace.requestPayload ?? {};
  const safePayload = sanitizeTraceValue(rawPayload) as Record<string, unknown>;
  if (tokensEstimated) safePayload.tokens_estimated = true;
  if (opts.replayedFinal) safePayload.replayed_final = true;
  // Same marker recordGatewayCall stamps: a $0 that means "no known rate" must
  // be distinguishable from a real zero, and the reprice sweep finds rows by
  // exactly this flag once a rate exists. Replayed finals are $0 by design.
  if (!opts.replayedFinal && !isImg && costUnpriced(trace.provider, trace.model)) {
    safePayload.pricing_missing = true;
  }
  // Whole-turn totals (this row + the tool-round children), for display.
  const loopIn = opts.loopUsage?.tokensIn ?? 0;
  const loopOut = opts.loopUsage?.tokensOut ?? 0;
  if (loopIn > 0 || loopOut > 0) {
    safePayload.turn_tokens_in = tokensIn + loopIn;
    safePayload.turn_tokens_out = tokensOut + loopOut;
    safePayload.turn_cost_usd = Number(
      (costUsd + estimateCost(trace.provider, trace.model, loopIn, loopOut)).toFixed(6),
    );
  }
  if (Array.isArray(safePayload.messages)) {
    safePayload.messages = (
      safePayload.messages as Array<{ role?: string; content?: unknown }>
    ).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 4000) : m.content,
    }));
  }
  if (typeof safePayload.systemPrompt === "string") {
    safePayload.systemPrompt = (safePayload.systemPrompt as string).slice(0, 4000);
  }
  if (typeof safePayload.effectiveSystemPrompt === "string") {
    safePayload.effectiveSystemPrompt = (safePayload.effectiveSystemPrompt as string).slice(
      0,
      4000,
    );
  }

  console.log(
    "[trace] inserting payload keys:",
    Object.keys(safePayload),
    "msg count:",
    Array.isArray(safePayload.messages) ? (safePayload.messages as unknown[]).length : 0,
  );

  try {
    const insertRow = {
      id: trace.traceId,
      user_id: userId,
      agent_id: trace.agentId ?? null,
      agent_name: trace.agentName,
      llm_provider: trace.provider,
      llm_model: trace.model,
      prompt: bodyText(trace.promptText.slice(0, 4000)),
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: latencyMs,
      cost_usd: costUsd,
      status,
      error_message: errorMessage ?? null,
      request_payload: bodyJson(safePayload),
      response_payload: bodyJson(
        skipResponsePayload ? null : { preview: sanitizeTraceValue(assistantText.slice(0, 2000)) },
      ),
      tool_calls: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb.from("execution_traces") as any).upsert(insertRow);
    if (error) {
      console.error("[trace] insert failed:", error.message, error.details);
    } else {
      // One structured line per completed turn — the greppable/shippable
      // correlation point between user reports, logs and the trace row.
      console.log(
        `[chat-turn] ${JSON.stringify({
          trace_id: trace.traceId,
          agent: trace.agentName,
          model: trace.model,
          status,
          latency_ms: latencyMs,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: costUsd,
          estimated: tokensEstimated || undefined,
        })}`,
      );
      // Audit: chats against a SAVED agent get an explicit agent.chat event
      // (the underlying model call already shows up via execution_traces).
      if (trace.agentId) {
        const { auditEvent } = await import("@/utils/audit.server");
        auditEvent({
          userId,
          action: "agent.chat",
          resourceType: "agent",
          resourceName: trace.agentName,
          resourceId: trace.agentId,
          detail: { model: `${trace.provider}/${trace.model}`, status },
        });
      }
    }
  } catch (e) {
    console.error("[trace] exception:", e);
  }

  // Fire-and-forget: alert the user by email if they've crossed an alert
  // threshold or hit their monthly spend cap. Never throws.
  try {
    const { checkAndNotifyBudget, checkAndNotifyGroupBudgets } =
      await import("@/lib/email/budgetAlertTrigger.server");
    void checkAndNotifyBudget(userId);
    // BOTH call sites, deliberately. There are two places that fire budget
    // alerts — here and recordGatewayUsage — and wiring only one is the exact
    // mistake made when the fail-open spend bug was fixed in budgetGuard and
    // left in this file.
    void checkAndNotifyGroupBudgets(userId);
  } catch (e) {
    console.error("[trace] budget alert check failed to load:", e);
  }
}

function withTraceTap(
  upstream: ReadableStream<Uint8Array> | null,
  trace: TraceContext,
  opts?: { replayedFinal?: boolean; loopUsage?: { tokensIn: number; tokensOut: number } },
): ReadableStream<Uint8Array> | null {
  if (!upstream) {
    void recordTrace({ trace, status: "error", errorMessage: "Empty upstream", assistantText: "" });
    return upstream;
  }
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";
  let assistantText = "";
  // Captured from upstream SSE chunks when available. Most OpenAI-compatible
  // providers forward a `usage` block on the final chunk; when present these
  // are MUCH more accurate than our chars/4
  // approximation, so prefer them in recordTrace below.
  let upstreamTokensIn: number | null = null;
  let upstreamTokensOut: number | null = null;
  // For image generations: count assistant data:image/... payloads so we can
  // price the trace per-image instead of treating image bytes as text tokens.
  let imageCount = 0;
  const IMAGE_MD_RE = /!\[[^\]]*\]\(data:image\//g;

  const consumeLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        };
      };
      const delta =
        parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      if (typeof delta === "string") assistantText += delta;
      const u = parsed.usage;
      if (u) {
        const tin = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
        const tout = Number(u.completion_tokens ?? u.output_tokens ?? 0);
        if (tin > 0) upstreamTokensIn = tin;
        if (tout > 0) upstreamTokensOut = tout;
      }
    } catch {
      /* ignore keep-alives / non-JSON */
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          controller.enqueue(value);
          textBuffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = textBuffer.indexOf("\n")) !== -1) {
            let line = textBuffer.slice(0, idx);
            textBuffer = textBuffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            consumeLine(line);
          }
        }
        if (textBuffer.trim()) consumeLine(textBuffer.trim());
        // Count generated images in the assembled assistant payload.
        const imgMatches = assistantText.match(IMAGE_MD_RE);
        if (imgMatches) imageCount = imgMatches.length;
        // Emit a final cost event so observability tracers (which don't know
        // the per-model price table or the resolved agent model) can record
        // accurate per-node cost without a second DB lookup.
        //
        // This event reports the WHOLE TURN: the tool rounds' aggregate usage
        // (loopUsage, from the loop's headers) plus the final call — or, when
        // the final was replayed from the last tool round, the loop aggregate
        // alone (which already includes that round). Without the loop part,
        // agent turns showed latency but zero tokens/cost in the chat UI: the
        // parent's billing columns are deliberately zero for replayed finals
        // (children carry the cost), and this event used to mirror that.
        try {
          const isImg = isImageModel(trace.model) || imageCount > 0;
          const loopIn = opts?.loopUsage?.tokensIn ?? 0;
          const loopOut = opts?.loopUsage?.tokensOut ?? 0;
          const finalIn = opts?.replayedFinal ? 0 : (upstreamTokensIn ?? trace.promptTokensApprox);
          const finalOut =
            isImg || opts?.replayedFinal ? 0 : (upstreamTokensOut ?? approxTokens(assistantText));
          const tIn = loopIn + finalIn;
          const tOut = loopOut + finalOut;
          const cUsd = isImg
            ? estimateImageCost(trace.model, Math.max(1, imageCount)) +
              estimateCost(trace.provider, trace.model, loopIn, loopOut)
            : estimateCost(trace.provider, trace.model, tIn, tOut);
          controller.enqueue(
            new TextEncoder().encode(
              `event: cost\ndata: ${JSON.stringify({ model: trace.model, costUsd: cUsd, tokensIn: tIn, tokensOut: tOut })}\n\n`,
            ),
          );
        } catch {
          /* never break the stream over telemetry */
        }
        // CRITICAL: await the trace insert BEFORE closing the controller.
        // In Cloudflare Workers / serverless runtimes, fire-and-forget promises
        // after the response stream closes are killed when the request ends —
        // which silently drops every trace. Awaiting here keeps the insert
        // inside the request lifetime so it actually persists.
        await recordTrace({
          trace,
          status: "success",
          assistantText,
          upstreamTokensIn: upstreamTokensIn ?? undefined,
          upstreamTokensOut: upstreamTokensOut ?? undefined,
          imageCount,
          replayedFinal: opts?.replayedFinal,
          loopUsage: opts?.loopUsage,
        });
        // Fire post-turn n8n notification (also inside request lifetime).
        if (trace.n8nNotify?.webhookUrl) {
          const result = await notifyN8nWebhook({
            webhookUrl: trace.n8nNotify.webhookUrl,
            authHeader: trace.n8nNotify.authHeader,
            payload: {
              event: "agent.turn.completed",
              traceId: trace.traceId,
              agentId: trace.agentId ?? null,
              agentName: trace.agentName,
              provider: trace.provider,
              model: trace.model,
              userId: trace.userId,
              prompt: trace.promptText.slice(0, 4000),
              response: assistantText.slice(0, 8000),
              latencyMs: Date.now() - trace.startedAt,
              timestamp: new Date().toISOString(),
            },
          });
          if (!result.ok) {
            console.warn("[n8n notify] failed:", result.detail || result.status);
          }
        }
        controller.close();
      } catch (err) {
        await recordTrace({
          trace,
          status: "error",
          errorMessage: err instanceof Error ? err.message : "Stream error",
          assistantText,
        });
        controller.error(err);
      }
    },
    async cancel(reason) {
      reader.cancel(reason).catch(() => {});
      await recordTrace({
        trace,
        status: "error",
        errorMessage: typeof reason === "string" ? reason : "Stream cancelled",
        assistantText,
      });
    },
  });
}

// Wrap an SSE stream so the assistant's accumulated text is evaluated against
// output guardrails when the stream ends. Behavior:
//   - If the response is BLOCKED by safety: cancel the upstream and emit a
//     replacement assistant chunk + a `guardrail_warning` event.
//   - If only warnings/redactions apply: pass tokens through, then emit a
//     trailing `guardrail_warning` event (and, when the redacted final text
//     differs from the streamed text, a `guardrail_rewrite` event with the
//     full clean replacement so the UI can swap it in).
function withOutputGuardrails(
  upstream: ReadableStream<Uint8Array> | null,
  guardrails: Guardrails,
  citationsAvailable: boolean,
): ReadableStream<Uint8Array> | null {
  if (!upstream) return upstream;
  if (!isAnyGuardrailActive(guardrails)) return upstream;

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let textBuffer = "";
  let assistantText = "";

  const consumeLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[];
      };
      const delta =
        parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      if (typeof delta === "string") assistantText += delta;
    } catch {
      /* ignore */
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          // Pass through all chunks live (preserves streaming UX).
          controller.enqueue(value);
          textBuffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = textBuffer.indexOf("\n")) !== -1) {
            let line = textBuffer.slice(0, idx);
            textBuffer = textBuffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            consumeLine(line);
          }
        }
        if (textBuffer.trim()) consumeLine(textBuffer.trim());

        const decision: OutputDecision = applyOutputGuardrails(assistantText, guardrails, {
          hadCitations: citationsAvailable,
        });

        if (decision.blocked || decision.text !== assistantText) {
          // Emit a full-text replacement so the client can render the
          // sanitized version in place of the streamed (raw) text.
          controller.enqueue(
            encoder.encode(
              `event: guardrail_rewrite\ndata: ${JSON.stringify({ text: decision.text, blocked: decision.blocked })}\n\n`,
            ),
          );
        }
        if (decision.warnings.length > 0) {
          controller.enqueue(
            encoder.encode(
              `event: guardrail_warning\ndata: ${JSON.stringify({ warnings: decision.warnings, blocked: decision.blocked })}\n\n`,
            ),
          );
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      OPTIONS: async () => {
        return new Response(null, { status: 204, headers: corsHeaders });
      },

      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            messages: ChatMessage[];
            provider?: string;
            model?: string;
            systemPrompt?: string;
            temperature?: number;
            maxTokens?: number;
            agentId?: string;
            // Headless swarm runs (API key / cron) authenticate with the
            // service secret and name the owner here (see the internal-auth
            // block below). Ignored for normal browser requests.
            internalUserId?: string;
            // Per-call tool allow-list (used by the swarm runtime to pick
            // which tools each node exposes). When omitted, the registry
            // returns every capability the user is configured for.
            enabledTools?: string[];
            // Per-call tool configs (provider+key for web_search/web_browse,
            // workflow allow-list for n8n, server allow-list for MCP). Used
            // by the swarm runtime; when omitted, the agent's saved configs
            // are used.
            toolConfigs?: {
              web_search?: { provider?: string; api_key?: string };
              web_browse?: { provider?: string; api_key?: string };
              n8n_workflow_ids?: string[];
              mcp_server_names?: string[];
              sql_table_names?: string[];
              metric_model_names?: string[];
            };
            // Per-call guardrail override (used by swarm nodes that want
            // their own policy independent of the linked agent). Server
            // merges this OVER the agent's saved guardrails.
            guardrails?: Partial<Guardrails>;
            // Conversation id — when provided, STM (rolling summary +
            // sliding window) is loaded and post-turn summarization runs.
            // The playground passes the user's conversation row id; the
            // swarm runtime passes the swarm_run_id so STM persists across
            // nodes within one execution.
            conversationId?: string;
            // Per-call memory overrides (used by swarm nodes to set
            // ltm_scope = "agent" | "swarm" | "none"). Merged over the
            // agent's saved memory config.
            memoryOverrides?: {
              stm_enabled?: boolean;
              stm_window_messages?: number;
              stm_summarize?: boolean;
              ltm_enabled?: boolean;
              ltm_auto_extract?: boolean;
              ltm_recall_top_k?: number;
              ltm_scope?: "agent" | "swarm" | "none";
            };
            // Per-call extra KB ids — used by swarm nodes that reference a
            // shared/sample knowledge base without having a saved agent.
            knowledgeBaseIds?: string[];
            reranker?: { provider?: string; model?: string };
            // Per-call skill ids — used by swarm nodes to override the linked
            // agent's saved skill list. When omitted, the agent's saved
            // tools.skillIds are used.
            skillIds?: string[];
          };

          if (!Array.isArray(body.messages) || body.messages.length === 0) {
            return new Response(JSON.stringify({ error: "messages array is required" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          // SAME CEILING THE PUBLIC EMBED ALREADY ENFORCED. /api/embed/chat has
          // capped conversation size since it shipped; this endpoint — the one
          // that spends the operator's provider credits — had no cap at all.
          // The asymmetry was backwards: an embed visitor is anonymous but
          // rate-limited and reading a fixed agent, while any signed-in account
          // could post an unbounded body straight to the model.
          if (isConversationTooLarge(body.messages)) {
            return new Response(
              JSON.stringify({
                error: "conversation_too_large",
                message: `Conversations are limited to ${MAX_MESSAGES} messages and ${MAX_BODY_CHARS / 1000}k characters. Start a new chat, or trim the history.`,
              }),
              { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } },
            );
          }

          const provider = (body.provider || "openrouter") as ProviderId;
          if (!VALID_PROVIDERS.includes(provider)) {
            return new Response(JSON.stringify({ error: `Unsupported provider: ${provider}` }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }
          const model = body.model || process.env.OPENROUTER_DEFAULT_MODEL || "openai/gpt-4o-mini";

          // ===== Auth + trace context =====
          // Resolve userId up-front so every provider path can record
          // execution_traces. All providers (including the operator's
          // OPENROUTER_API_KEY default) require auth — see the "External
          // providers" check below.
          const authHeader = request.headers.get("authorization");
          const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
          // Internal server-to-server calls (headless swarm runs): authenticated
          // by the service-role secret, they name the swarm owner in the body.
          // Memory is disabled and the toolset is capped to the headless-safe
          // set; the data tools (kb_search/sql_query) run under the service role
          // but with scopeUserId set, so they only read the owner's own +
          // sample + IAM-shared data (never another tenant's).
          // Constant-time compare against INTERNAL_RUN_SECRET (falling back to
          // the service-role key) so the secret can't be probed by timing.
          const isInternalRun = internalSecretMatches(request.headers.get("x-internal-run-secret"));
          const userId = isInternalRun
            ? (body.internalUserId ?? null)
            : await getUserIdFromRequest(request);

          // IAM model governance: a user subject to model rules (their own or
          // any of their groups') may only call allowed provider/model
          // combinations. Users with no applicable rules are unrestricted.
          if (userId) {
            const iamSb = authToken
              ? getServerSupabase(authToken)
              : isInternalRun
                ? supabaseAdmin
                : null;
            if (iamSb) {
              const modelRules = await getEffectiveModelRules(iamSb, userId);
              if (modelRules && !isModelAllowed(modelRules, provider, model)) {
                return new Response(
                  JSON.stringify({
                    error: "model_not_allowed",
                    message: `Your administrator has not allowed ${provider}/${model} for your account. Ask a superadmin to adjust your model access.`,
                  }),
                  { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } },
                );
              }
            }

            // Hard budget cap. Opt-in (ENFORCE_BUDGET_CAP) — see budgetGuard —
            // and a no-op when no cap is set. Same chokepoint as the model gate,
            // so it covers playground, saved agents and every swarm node.
            // Checks the user's own cap AND every IAM group they belong to.
            const budget = await getBudgetDecision(userId);
            if (budget.over) {
              return new Response(
                JSON.stringify({
                  error: "budget_exceeded",
                  message:
                    `${budgetMessage(budget)} ` +
                    `(spent $${budget.spend.toFixed(2)} of $${budget.cap.toFixed(2)} this month.)`,
                }),
                { status: 402, headers: { "Content-Type": "application/json", ...corsHeaders } },
              );
            }
          }

          // Look up the agent for trace label, gateway flag, n8n webhook,
          // saved built-in tool toggles, AND saved tool-configs (per-tool
          // alt-provider keys, n8n workflow allow-list, MCP server allow-list).
          let agentName = "Playground";
          let agentRouteThroughGateway = false;
          let agentN8nWebhookUrl: string | null = null;
          const agentBuiltInToggles: Record<string, boolean> = {};
          const agentToolConfigs: {
            web_search?: { provider?: string; api_key?: string };
            web_browse?: { provider?: string; api_key?: string };
            n8n_workflow_ids?: string[];
            mcp_server_names?: string[];
            sql_table_names?: string[];
            metric_model_names?: string[];
          } = {};
          let agentSkillIds: string[] = [];
          let agentGuardrails: Guardrails = parseGuardrails(undefined);
          if (body.agentId && authToken) {
            try {
              const sb = getServerSupabase(authToken);
              if (sb) {
                const { data: a } = await sb
                  .from("agents")
                  .select("name, tools, n8n_webhook_url")
                  .eq("id", body.agentId)
                  .maybeSingle();
                if (a?.name) agentName = a.name;
                const tools = (a?.tools ?? {}) as {
                  routeThroughGateway?: unknown;
                  builtInTools?: Record<string, unknown>;
                  toolConfigs?: Record<string, Record<string, unknown>>;
                  workflows?: Record<string, Record<string, unknown>>;
                  activeWorkflows?: Record<string, unknown>;
                  mcpServerNames?: unknown;
                  guardrails?: unknown;
                  skillIds?: unknown;
                };
                if (Array.isArray(tools.skillIds)) {
                  agentSkillIds = tools.skillIds.filter(
                    (s): s is string => typeof s === "string" && s.length > 0,
                  );
                }
                agentGuardrails = parseGuardrails(tools.guardrails);
                agentRouteThroughGateway = tools.routeThroughGateway === true;
                agentN8nWebhookUrl = a?.n8n_webhook_url ?? null;
                if (tools.builtInTools && typeof tools.builtInTools === "object") {
                  for (const [k, v] of Object.entries(tools.builtInTools)) {
                    if (typeof v === "boolean") agentBuiltInToggles[k] = v;
                  }
                }
                // toolConfigs.web_search / web_browse — provider + api_key
                const ws = tools.toolConfigs?.web_search;
                if (ws && typeof ws === "object") {
                  agentToolConfigs.web_search = {
                    provider: typeof ws.provider === "string" ? ws.provider : undefined,
                    api_key: typeof ws.api_key === "string" ? ws.api_key : undefined,
                  };
                }
                const wb = tools.toolConfigs?.web_browse;
                if (wb && typeof wb === "object") {
                  agentToolConfigs.web_browse = {
                    provider: typeof wb.provider === "string" ? wb.provider : undefined,
                    api_key: typeof wb.api_key === "string" ? wb.api_key : undefined,
                  };
                }
                // n8n workflow allow-list — comma-separated string in the
                // form's workflow config OR an array under the new field.
                const n8nWf = tools.workflows?.n8n;
                if (n8nWf && typeof n8nWf === "object") {
                  const raw = (n8nWf as { workflow_ids?: unknown }).workflow_ids;
                  if (typeof raw === "string") {
                    agentToolConfigs.n8n_workflow_ids = raw
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                  } else if (Array.isArray(raw)) {
                    agentToolConfigs.n8n_workflow_ids = raw.filter(
                      (s): s is string => typeof s === "string",
                    );
                  }
                }
                // MCP server allow-list
                if (Array.isArray(tools.mcpServerNames)) {
                  agentToolConfigs.mcp_server_names = tools.mcpServerNames.filter(
                    (s): s is string => typeof s === "string" && s.trim().length > 0,
                  );
                }
                // SQL table allow-list — saved on the agent under
                // tools.toolConfigs.sql_query.table_names as a string array.
                const sqlCfg = tools.toolConfigs?.sql_query;
                if (sqlCfg && typeof sqlCfg === "object") {
                  const raw = (sqlCfg as { table_names?: unknown }).table_names;
                  if (Array.isArray(raw)) {
                    agentToolConfigs.sql_table_names = raw.filter(
                      (s): s is string => typeof s === "string" && s.trim().length > 0,
                    );
                  }
                }
                // Semantic model allow-list — saved under
                // tools.toolConfigs.metric_query.model_names. Unlike the SQL
                // list this is deny-by-default, so an absent config correctly
                // leaves the tool with nothing and it is not registered.
                const metricCfg = tools.toolConfigs?.metric_query;
                if (metricCfg && typeof metricCfg === "object") {
                  const raw = (metricCfg as { model_names?: unknown }).model_names;
                  if (Array.isArray(raw)) {
                    agentToolConfigs.metric_model_names = raw.filter(
                      (s): s is string => typeof s === "string" && s.trim().length > 0,
                    );
                  }
                }
              }
            } catch {
              /* ignore — trace label is non-critical */
            }
          }

          // Map the agent's saved web_search/web_browse switches into the
          // curated TOOLABLE_IDS. Used when the request didn't pass an
          // explicit `enabledTools` allow-list (the swarm runtime always does).
          function deriveEnabledToolsFromAgent(): ToolableId[] | undefined {
            const t = agentBuiltInToggles;
            if (!t || Object.keys(t).length === 0) return undefined;
            const out: ToolableId[] = [];
            if (t.web_search) out.push("web_search");
            if (t.web_browse || t.web_browser) out.push("web_browse");
            if (t.kb_search || t.knowledge_base) out.push("kb_search");
            if (t.kb_graph_search || t.knowledge_graph) out.push("kb_graph_search");
            if (t.calculator) out.push("calculator");
            if (t.datetime) out.push("datetime");
            if (t.weather) out.push("weather");
            if (t.sql_query) out.push("sql_query");
            if (t.n8n || t.n8n_run_workflow) out.push("n8n_run_workflow");
            if (t.mcp || t.mcp_call_tool) out.push("mcp_call_tool");
            if (t.send_notification || t.notifications) out.push("send_notification");
            return out.length > 0 ? out : undefined;
          }

          // Merge per-call toolConfigs (from swarm) over the agent's saved
          // configs. Per-call wins because the swarm node may want to
          // override the agent for this specific run.
          function resolveToolConfigs() {
            const merged: typeof agentToolConfigs = { ...agentToolConfigs };
            const c = body.toolConfigs;
            if (c) {
              if (c.web_search) merged.web_search = { ...merged.web_search, ...c.web_search };
              if (c.web_browse) merged.web_browse = { ...merged.web_browse, ...c.web_browse };
              if (Array.isArray(c.n8n_workflow_ids) && c.n8n_workflow_ids.length > 0) {
                merged.n8n_workflow_ids = c.n8n_workflow_ids;
              }
              if (Array.isArray(c.mcp_server_names) && c.mcp_server_names.length > 0) {
                merged.mcp_server_names = c.mcp_server_names;
              }
              if (Array.isArray(c.sql_table_names) && c.sql_table_names.length > 0) {
                merged.sql_table_names = c.sql_table_names;
              }
              if (Array.isArray(c.metric_model_names) && c.metric_model_names.length > 0) {
                merged.metric_model_names = c.metric_model_names;
              }
            }
            return merged;
          }

          // Resolve gateway override + n8n notify config (best-effort).
          let gatewayOverride: GatewayOverride | undefined;
          let n8nGlobal: {
            instance_url?: string;
            webhook_token?: string;
            auth_type?: string;
          } | null = null;
          if (userId && authToken) {
            try {
              const sb = getServerSupabase(authToken);
              if (sb) {
                // Secrets (gateway api_key / n8n webhook_token) are encrypted at
                // rest in integrations.config — decrypt them server-side here.
                const { resolveIntegrationConfig } =
                  await import("@/utils/providers/integrationConfig.server");
                const { data: gw } = await sb
                  .from("integrations")
                  .select("config, is_active")
                  .eq("type", "llm_gateway")
                  .eq("is_active", true)
                  .maybeSingle();
                if (gw?.is_active && gw.config) {
                  const cfg = (await resolveIntegrationConfig(
                    userId,
                    "llm_gateway",
                    gw.config as Record<string, unknown>,
                  )) as {
                    base_url?: string;
                    api_key?: string;
                    provider?: string;
                    route_all?: unknown;
                  };
                  // Route when the agent opted in OR the gateway is set to
                  // route ALL traffic (the switch on the Integrations page).
                  const shouldRoute = agentRouteThroughGateway || cfg.route_all === true;
                  if (shouldRoute && cfg.base_url && cfg.api_key) {
                    gatewayOverride = {
                      baseUrl: cfg.base_url.replace(/\/+$/, ""),
                      apiKey: cfg.api_key,
                      provider: cfg.provider,
                    };
                  }
                }
                const { data: n8n } = await sb
                  .from("integrations")
                  .select("config, is_active")
                  .eq("type", "n8n")
                  .eq("is_active", true)
                  .maybeSingle();
                if (n8n?.is_active && n8n.config) {
                  n8nGlobal = (await resolveIntegrationConfig(
                    userId,
                    "n8n",
                    n8n.config as Record<string, unknown>,
                  )) as unknown as typeof n8nGlobal;
                }
              }
            } catch {
              /* ignore — non-critical */
            }
          }

          const lastUserForTrace = [...body.messages].reverse().find((m) => m.role === "user");
          const promptText = lastUserForTrace ? messageText(lastUserForTrace.content).trim() : "";
          const trace: TraceContext = {
            traceId: crypto.randomUUID(),
            userId,
            authToken,
            agentId: body.agentId,
            agentName,
            provider,
            model,
            promptText,
            promptTokensApprox: approxTokens(
              (body.systemPrompt || "") +
                "\n" +
                body.messages.map((m) => messageText(m.content)).join("\n"),
            ),
            startedAt: Date.now(),
            requestPayload: {
              provider,
              model,
              agentId: body.agentId ?? null,
              temperature: body.temperature ?? null,
              maxTokens: body.maxTokens ?? null,
              systemPrompt: body.systemPrompt ?? null,
              messages: body.messages,
              gatewayRouted: !!gatewayOverride,
            },
            n8nNotify: agentN8nWebhookUrl
              ? (() => {
                  const g = n8nGlobal as { auth_type?: string; webhook_token?: string } | null;
                  let authHeader: string | undefined;
                  if (g?.auth_type === "header" && g.webhook_token) {
                    authHeader = g.webhook_token.startsWith("Bearer ")
                      ? g.webhook_token
                      : `Bearer ${g.webhook_token}`;
                  } else if (g?.auth_type === "basic" && g.webhook_token) {
                    authHeader = `Basic ${btoa(g.webhook_token)}`;
                  }
                  return { webhookUrl: agentN8nWebhookUrl, authHeader };
                })()
              : undefined,
          };

          // ===== Guardrails — input enforcement (real, not mock) =====
          // Resolve effective guardrails: per-call body.guardrails wins over
          // the agent's saved guardrails (so a swarm node can have a stricter
          // policy than the linked agent).
          const effectiveGuardrails: Guardrails = body.guardrails
            ? parseGuardrails({ ...agentGuardrails, ...body.guardrails })
            : agentGuardrails;

          if (isAnyGuardrailActive(effectiveGuardrails) && promptText) {
            const decision = evaluateInputGuardrails(promptText, effectiveGuardrails);
            if (!decision.allowed) {
              await recordTrace({
                trace,
                status: "error",
                errorMessage: `Guardrail: ${decision.reason}`,
                assistantText: "",
              });
              return new Response(
                JSON.stringify({
                  error: decision.reason,
                  code: "GUARDRAIL_INPUT_BLOCKED",
                }),
                {
                  status: 422,
                  headers: {
                    "Content-Type": "application/json",
                    "X-Trace-Id": trace.traceId,
                    ...corsHeaders,
                  },
                },
              );
            }
            // PII redaction in input — rewrite the last user message in
            // place so the upstream LLM never sees the raw values.
            if (Object.keys(decision.redactions).length > 0) {
              const last = [...body.messages].reverse().find((m) => m.role === "user");
              if (last) {
                if (typeof last.content === "string") {
                  last.content = decision.outboundText;
                } else {
                  // Multi-part: redact only the text segments.
                  last.content = last.content.map((p) =>
                    p.type === "text" ? { ...p, text: decision.outboundText } : p,
                  );
                }
              }
              if (trace.requestPayload) {
                trace.requestPayload.guardrailRedactions = decision.redactions;
              }
            }
          }
          // Record the resolved guardrails on the trace for transparency.
          if (trace.requestPayload && isAnyGuardrailActive(effectiveGuardrails)) {
            trace.requestPayload.guardrails = {
              enableInputFilters: effectiveGuardrails.enableInputFilters,
              enableOutputFilters: effectiveGuardrails.enableOutputFilters,
              blockPII: effectiveGuardrails.blockPII,
              blockProfanity: effectiveGuardrails.blockProfanity,
              contentSafetyLevel: effectiveGuardrails.contentSafetyLevel,
              enableCitationCheck: effectiveGuardrails.enableCitationCheck,
              enableHallucinationFilter: effectiveGuardrails.enableHallucinationFilter,
            };
          }
          let citations: Citation[] = [];
          let effectiveSystemPrompt = body.systemPrompt;

          // ===== Skills injection =====
          // Resolve effective skill ids: per-call body.skillIds wins over the
          // agent's saved tools.skillIds. Sample skills come from in-code
          // map; user skills are fetched from agent_skills (RLS-scoped).
          {
            const effectiveSkillIds = Array.isArray(body.skillIds)
              ? body.skillIds.filter((s): s is string => typeof s === "string" && s.length > 0)
              : agentSkillIds;
            if (effectiveSkillIds.length > 0) {
              try {
                const { resolveSkills, buildSkillsPromptBlock, isSampleSkillId } =
                  await import("@/lib/skills");
                const dbIds = effectiveSkillIds.filter((id) => !isSampleSkillId(id));
                let userSkillRows: Array<{
                  id: string;
                  name: string;
                  description: string | null;
                  body: string;
                  tags: string[];
                }> = [];
                if (dbIds.length > 0 && authToken) {
                  const sb = getServerSupabase(authToken);
                  if (sb) {
                    const { data } = await sb
                      .from("agent_skills")
                      .select("id, name, description, body, tags")
                      .in("id", dbIds);
                    userSkillRows = (data ?? []) as typeof userSkillRows;
                  }
                }
                const resolved = resolveSkills(effectiveSkillIds, userSkillRows);
                if (resolved.length > 0) {
                  const block = buildSkillsPromptBlock(resolved);
                  effectiveSystemPrompt = effectiveSystemPrompt
                    ? `${block}\n\n${effectiveSystemPrompt}`
                    : block;
                }
              } catch (err) {
                console.error("Skill resolution failed:", err);
              }
            }
          }

          const extraKbIds = Array.isArray(body.knowledgeBaseIds)
            ? body.knowledgeBaseIds.filter(
                (s): s is string => typeof s === "string" && s.length > 0,
              )
            : [];

          // Explicit re-ranker from the request body (swarm nodes send it
          // inline; standalone agents carry it in tools.reranker instead).
          const bodyReranker =
            body.reranker &&
            typeof body.reranker.provider === "string" &&
            typeof body.reranker.model === "string"
              ? { provider: body.reranker.provider, model: body.reranker.model }
              : undefined;

          // Skip auto-RAG (kb_search preamble) when the caller explicitly
          // passed an enabledTools allow-list that does NOT include kb_search.
          // This prevents swarm nodes that only enable kb_graph_search from
          // being polluted with kb_search citations + a "answer only from
          // sources" grounding prompt that suppresses the real tool call.
          const explicitAllowList = Array.isArray(body.enabledTools) ? body.enabledTools : null;
          const autoRagAllowed = !explicitAllowList || explicitAllowList.includes("kb_search");

          if (autoRagAllowed && (body.agentId || extraKbIds.length > 0) && authToken) {
            const query = promptText;
            if (query) {
              try {
                const sbAuto = getServerSupabase(authToken);
                if (sbAuto) {
                  const { retrieveCitationsServer, buildGroundingPrompt } =
                    await import("@/utils/tools/kb.server");
                  // The asker's email, for matching provider-mirrored ACLs on
                  // connector documents (source_acl scope). Absent claim →
                  // restricted docs stay owner-only, which is the safe side.
                  let principalEmail: string | null = null;
                  try {
                    const { data: claimsRes } = await sbAuto.auth.getClaims(authToken);
                    principalEmail =
                      (claimsRes?.claims as { email?: string } | undefined)?.email ?? null;
                  } catch {
                    principalEmail = null;
                  }
                  citations = await retrieveCitationsServer({
                    sb: sbAuto,
                    agentId: body.agentId,
                    extraKbIds,
                    query,
                    topK: 5,
                    userId,
                    reranker: bodyReranker,
                    principal: { email: principalEmail },
                  });
                  if (citations.length > 0) {
                    effectiveSystemPrompt = buildGroundingPrompt(citations, body.systemPrompt);
                  }
                }
              } catch (err) {
                console.error("RAG retrieval failed:", err);
                // Don't block the chat — just continue without grounding.
              }
            }
          }

          // ===== Memory (STM + LTM) =====
          // Load per-agent memory config, then fetch the conversation's
          // rolling summary (STM) and recall top-K LTM items keyed off the
          // current user prompt. Both blocks are folded into the system
          // prompt; the sliding window is applied to body.messages below.
          let recalledItems: RecalledItem[] = [];
          const memoryConfig = await (async () => {
            const sb = authToken ? getServerSupabase(authToken) : null;
            if (!sb) {
              const { DEFAULT_MEMORY_CONFIG } = await import("@/utils/memory/types");
              return { ...DEFAULT_MEMORY_CONFIG };
            }
            return resolveMemoryConfig({
              sb,
              agentId: body.agentId,
              overrides: body.memoryOverrides as MemoryOverrides | undefined,
            });
          })();
          let memorySummaryUsed = false;
          if (userId && authToken) {
            try {
              const sbMem = getServerSupabase(authToken);
              if (sbMem) {
                const loaded = await loadMemoryContext({
                  sb: sbMem,
                  userId,
                  agentId: body.agentId,
                  conversationId: body.conversationId ?? null,
                  userPrompt: promptText,
                  config: memoryConfig,
                });
                recalledItems = loaded.recalled;
                memorySummaryUsed = !!loaded.summaryBlock;
                effectiveSystemPrompt = composeSystemPrompt({
                  basePrompt: effectiveSystemPrompt,
                  ltmBlock: loaded.ltmBlock,
                  summaryBlock: loaded.summaryBlock,
                });
              }
            } catch (e) {
              console.warn("[memory] load failed:", (e as Error).message);
            }
          }

          // Apply STM sliding window: only the last N messages are sent to
          // the model. The rolling summary already captures everything older.
          if (memoryConfig.stm_enabled && body.messages.length > memoryConfig.stm_window_messages) {
            body.messages = body.messages.slice(-memoryConfig.stm_window_messages);
          }

          // Persist effective system prompt + citations on the trace payload.
          if (trace.requestPayload) {
            trace.requestPayload.effectiveSystemPrompt = effectiveSystemPrompt ?? null;
            trace.requestPayload.citations = citations.map((c) => ({
              index: c.index,
              documentName: c.documentName,
              knowledgeBaseName: c.knowledgeBaseName,
            }));
            trace.requestPayload.memory = {
              stm_enabled: memoryConfig.stm_enabled,
              stm_window_messages: memoryConfig.stm_window_messages,
              ltm_enabled: memoryConfig.ltm_enabled,
              ltm_recalled: recalledItems.length,
              summary_used: memorySummaryUsed,
              conversationId: body.conversationId ?? null,
            };
          }

          // ===== External providers — require auth + per-user credentials =====
          if (!userId) {
            return new Response(
              JSON.stringify({ error: "Authentication required for external providers" }),
              { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } },
            );
          }

          try {
            // Providers don't all accept multi-part image_url content in the
            // plain-text path. Flatten to text — vision uploads only work
            // through the image-generation branch below.
            const flatMessages = body.messages.map((m) => ({
              role: m.role,
              content: messageText(m.content),
            }));

            // If the agent asked for tools (web_search/web_browse/kb_search/
            // n8n/mcp) AND the provider speaks OpenAI Chat Completions, run
            // the shared tool-calling loop. This is what makes "I enabled
            // web_search on a Gemini/OpenAI/Grok agent and it can't search"
            // finally work.
            // Headless (internal) runs have no user JWT, so tools run under the
            // service-role client — but ONLY the data tools that honour
            // scopeUserId (below) may do so safely. Cap the allow-list to that
            // set server-side so an unscoped tool (kb_graph_search, memory, …)
            // can never be wired on a headless run, whatever the caller sent.
            const HEADLESS_AGENT_TOOL_ALLOW = new Set<ToolableId>([
              "web_search",
              "web_browse",
              "calculator",
              "datetime",
              "weather",
              "mcp_call_tool",
              "sql_query",
              "kb_search",
              // Safe here for the same reason sql_query is: runMetricQuery
              // forwards scopeUserId and the IAM-resolved grantedModelIds into
              // runSemanticQuery, so a service-role run still only ever reads
              // the swarm owner's own + shared models. Its per-agent allow-list
              // narrows it further and is deny-by-default.
              "metric_query",
            ]);
            const sbForTools = authToken
              ? getServerSupabase(authToken)
              : isInternalRun
                ? supabaseAdmin
                : null;
            const explicitAllow = Array.isArray(body.enabledTools)
              ? (body.enabledTools.filter((t) =>
                  (TOOLABLE_IDS as readonly string[]).includes(t),
                ) as ToolableId[])
              : undefined;
            const rawAllowList = explicitAllow ?? deriveEnabledToolsFromAgent();
            const allowList = isInternalRun
              ? (rawAllowList ?? []).filter((t) => HEADLESS_AGENT_TOOL_ALLOW.has(t))
              : rawAllowList;
            // Owner-scope tool data access on headless runs (RLS is off there).
            const toolScopeUserId = isInternalRun && userId ? userId : undefined;
            const transport = await resolveOpenAICompatTransport({
              userId,
              provider,
              gateway: gatewayOverride,
            }).catch(() => null);

            // ===== Image-generation models (Gemini "Nano Banana" family, etc.) =====
            // These models don't speak chat-completion-with-tools — they
            // return a base64 data URL on `choices[0].message.images[0]`.
            // Route them through a single non-streaming call and emit one
            // synthetic SSE chunk that contains markdown referencing the
            // returned image, so the existing client parser, the playground
            // markdown renderer, and the swarm RunPanel image gallery all
            // light up without bespoke transport code.
            if (isImageModelId(model)) {
              if (!transport || !transport.apiKey) {
                return new Response(
                  JSON.stringify({
                    error: `No ${provider} credentials configured for image generation. Add them in Integrations.`,
                  }),
                  {
                    status: 500,
                    headers: {
                      "Content-Type": "application/json",
                      "X-Trace-Id": trace.traceId,
                      ...corsHeaders,
                    },
                  },
                );
              }
              try {
                // Take the latest user message and split it into a text
                // prompt + any attached image_url parts (used for editing).
                const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
                let promptForImage = "";
                const imageInputs: Array<{ url: string }> = [];
                if (lastUser) {
                  if (typeof lastUser.content === "string") {
                    promptForImage = lastUser.content;
                  } else {
                    for (const part of lastUser.content) {
                      if (part.type === "text")
                        promptForImage += (promptForImage ? "\n" : "") + part.text;
                      else if (part.type === "image_url")
                        imageInputs.push({ url: part.image_url.url });
                    }
                  }
                }
                if (!promptForImage.trim() && imageInputs.length === 0) {
                  promptForImage = "Generate an image.";
                }

                // Build a request with multi-part content so the model can
                // both read the prompt and edit any input images.
                const userParts: Array<
                  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
                > = [];
                if (promptForImage.trim()) userParts.push({ type: "text", text: promptForImage });
                for (const img of imageInputs)
                  userParts.push({ type: "image_url", image_url: { url: img.url } });

                const sysMessages = effectiveSystemPrompt
                  ? [{ role: "system" as const, content: effectiveSystemPrompt }]
                  : [];

                const upstream = await fetch(transport.endpointUrl, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${transport.apiKey}`,
                    "Content-Type": "application/json",
                    ...transport.extraHeaders,
                  },
                  body: JSON.stringify({
                    model,
                    messages: [...sysMessages, { role: "user", content: userParts }],
                    modalities: ["image", "text"],
                  }),
                  signal: request.signal,
                });

                if (!upstream.ok) {
                  const errText = await upstream.text().catch(() => "");
                  let errorMessage = `Image gateway error (${upstream.status})`;
                  if (upstream.status === 429)
                    errorMessage = "Rate limit exceeded. Please wait and try again.";
                  else if (upstream.status === 402)
                    errorMessage = "AI credits exhausted for this provider.";
                  else {
                    try {
                      const j = JSON.parse(errText) as { error?: { message?: string } };
                      if (j.error?.message) errorMessage = j.error.message;
                    } catch {
                      if (errText.trim()) errorMessage = errText.trim().slice(0, 300);
                    }
                  }
                  await recordTrace({ trace, status: "error", errorMessage, assistantText: "" });
                  const status =
                    upstream.status === 429 || upstream.status === 402 ? upstream.status : 500;
                  return new Response(JSON.stringify({ error: errorMessage }), {
                    status,
                    headers: {
                      "Content-Type": "application/json",
                      "X-Trace-Id": trace.traceId,
                      ...corsHeaders,
                    },
                  });
                }

                type ImageJson = {
                  choices?: Array<{
                    finish_reason?: string;
                    message?: {
                      content?: string;
                      images?: Array<{ image_url?: { url?: string } }>;
                    };
                  }>;
                  usage?: Record<string, unknown>;
                };
                let json = (await upstream.json()) as ImageJson;
                let msg = json.choices?.[0]?.message;
                let caption = (msg?.content || "").trim();
                let dataUrl = msg?.images?.[0]?.image_url?.url || "";
                let finishReason = json.choices?.[0]?.finish_reason || "";

                // Retry once with a stronger directive prefix when the model
                // returned text-only or hit MAX_TOKENS without producing an
                // image. This recovers from the common case where the model
                // "answers" instead of generating after a few back-and-forth
                // turns.
                if (!dataUrl) {
                  console.log("[image] no image on first attempt", {
                    finishReason,
                    captionLen: caption.length,
                    captionSnippet: caption.slice(0, 200),
                    usage: json.usage,
                    inputImages: imageInputs.length,
                  });
                  const retryUserParts: Array<
                    | { type: "text"; text: string }
                    | { type: "image_url"; image_url: { url: string } }
                  > = [
                    {
                      type: "text",
                      text: `Generate an image. Respond with the image only, no commentary.\n\nImage description: ${promptForImage || "a creative scene"}`,
                    },
                  ];
                  for (const img of imageInputs) {
                    retryUserParts.push({ type: "image_url", image_url: { url: img.url } });
                  }
                  const retry = await fetch(transport.endpointUrl, {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${transport.apiKey}`,
                      "Content-Type": "application/json",
                      ...transport.extraHeaders,
                    },
                    body: JSON.stringify({
                      model,
                      messages: [{ role: "user", content: retryUserParts }],
                      modalities: ["image", "text"],
                    }),
                  });
                  if (retry.ok) {
                    json = (await retry.json()) as ImageJson;
                    msg = json.choices?.[0]?.message;
                    caption = (msg?.content || "").trim();
                    dataUrl = msg?.images?.[0]?.image_url?.url || "";
                    finishReason = json.choices?.[0]?.finish_reason || "";
                  }
                }

                if (!dataUrl) {
                  console.log("[image] no image after retry", {
                    finishReason,
                    captionLen: caption.length,
                    captionSnippet: caption.slice(0, 200),
                    usage: json.usage,
                  });
                  const reasonHint =
                    finishReason === "MAX_TOKENS" || finishReason === "length"
                      ? " The model hit its output limit — try a shorter, more focused prompt or remove input images."
                      : caption
                        ? ` The model replied with text instead: "${caption.slice(0, 160)}${caption.length > 160 ? "…" : ""}". Try rephrasing as a direct image request (e.g. "Generate an image of …").`
                        : ' Try a more descriptive, direct image request (e.g. "Generate an image of …").';
                  const errorMessage = `Image model returned no image.${reasonHint}`;
                  await recordTrace({
                    trace,
                    status: "error",
                    errorMessage,
                    assistantText: caption,
                  });
                  return new Response(JSON.stringify({ error: errorMessage }), {
                    status: 502,
                    headers: {
                      "Content-Type": "application/json",
                      "X-Trace-Id": trace.traceId,
                      ...corsHeaders,
                    },
                  });
                }

                // Compose the assistant payload. The data URL itself goes
                // into a markdown image so MarkdownMessage renders it and
                // the swarm RunPanel URL_RE picks it up for the gallery.
                const assistantPayload = `${caption ? caption + "\n\n" : ""}![generated image](${dataUrl})`;

                if (trace.requestPayload) {
                  trace.requestPayload.modality = "image";
                  trace.requestPayload.imagePromptLength = promptForImage.length;
                  trace.requestPayload.imageInputCount = imageInputs.length;
                }
                // Record the trace synchronously so the inspector has it
                // before the client even reads the response. We pass a
                // short caption-only assistantText so it isn't bloated by
                // the base64 data URL (which can be hundreds of KB).
                await recordTrace({
                  trace,
                  status: "success",
                  assistantText: caption || "[image generated]",
                  skipResponsePayload: true,
                });

                // Stream as a single SSE chunk + [DONE] so the existing
                // client parser ingests it the same way it handles text.
                const sseStream = new ReadableStream<Uint8Array>({
                  start(controller) {
                    const enc = new TextEncoder();
                    const chunk = {
                      choices: [{ delta: { content: assistantPayload } }],
                    };
                    controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    controller.enqueue(enc.encode("data: [DONE]\n\n"));
                    controller.close();
                  },
                });
                return new Response(sseStream, {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "X-Trace-Id": trace.traceId,
                    ...corsHeaders,
                  },
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : "Image generation error";
                console.error("Image gen error:", err);
                await recordTrace({
                  trace,
                  status: "error",
                  errorMessage: message,
                  assistantText: "",
                });
                return new Response(JSON.stringify({ error: message }), {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    "X-Trace-Id": trace.traceId,
                    ...corsHeaders,
                  },
                });
              }
            }

            if (transport && transport.apiKey && sbForTools && allowList && allowList.length > 0) {
              const mergedConfigs = resolveToolConfigs();
              const resolved = await resolveAgentTools(
                {
                  userId,
                  agentId: body.agentId,
                  authToken,
                  sb: sbForTools,
                  scopeUserId: toolScopeUserId,
                },
                { enabledTools: allowList, toolConfigs: mergedConfigs, extraKbIds },
              );
              if (resolved.tools.length > 0) {
                const toolEvents: ToolEvent[] = [];
                // Append the registry's source-routing guidance so the model
                // picks the right tool when several data sources are attached
                // (tables vs KB vs web) instead of defaulting to sql_query.
                const systemWithRouting = [effectiveSystemPrompt, resolved.guidance]
                  .filter((s): s is string => Boolean(s && s.trim()))
                  .join("\n\n");
                const upstreamWithTools = await streamChatWithTools({
                  apiKey: transport.apiKey,
                  model,
                  systemPrompt: systemWithRouting || undefined,
                  userMessages: flatMessages,
                  tools: resolved.tools,
                  handlers: resolved.handlers,
                  toolCtx: {
                    userId,
                    agentId: body.agentId,
                    authToken,
                    sb: sbForTools,
                    conversationId: body.conversationId ?? null,
                    reranker: bodyReranker,
                    scopeUserId: toolScopeUserId,
                  },
                  temperature: body.temperature,
                  maxTokens: body.maxTokens,
                  endpointUrl: transport.endpointUrl,
                  extraHeaders: transport.extraHeaders,
                  organizationId: transport.organizationId,
                  onToolEvent: (e) => toolEvents.push(e),
                  userId: userId ?? null,
                  parentTraceId: trace?.traceId ?? null,
                  // Client abort must stop the loop server-side too — without
                  // this, Stop closed the browser connection while tool rounds
                  // kept running (and billing) to the last iteration.
                  signal: request.signal,
                });
                if (!upstreamWithTools.ok) {
                  const t = await upstreamWithTools.text().catch(() => "");
                  throw new Error(`${provider} [${upstreamWithTools.status}]: ${t.slice(0, 300)}`);
                }
                if (trace.requestPayload && toolEvents.length > 0) {
                  trace.requestPayload.toolEvents = toolEvents;
                }
                // The loop reports the turn's aggregate tool-round usage in
                // headers; thread it through so the cost event and the trace
                // payload show whole-turn numbers instead of zeros.
                const loopIn =
                  Number(upstreamWithTools.headers.get("x-agentswarms-loop-usage-in") ?? 0) || 0;
                const loopOut =
                  Number(upstreamWithTools.headers.get("x-agentswarms-loop-usage-out") ?? 0) || 0;
                const tapped = withTraceTap(upstreamWithTools.body, trace, {
                  replayedFinal: upstreamWithTools.headers.get("x-agentswarms-replayed") === "1",
                  loopUsage:
                    loopIn > 0 || loopOut > 0
                      ? { tokensIn: loopIn, tokensOut: loopOut }
                      : undefined,
                });
                const withCits = withCitationsPreamble(tapped, citations);
                const withTools = withToolEventsPreamble(withCits, toolEvents);
                // Attribution comes from what the tools RETURNED, so a web
                // answer lists links and a table answer lists tables — the
                // knowledge base only joins them when the answer cites it.
                const withSrc = withSourcesTrailer(
                  withTools,
                  citationSources(citations),
                  toolEvents.flatMap((e) => (e.type === "tool_result" ? (e.sources ?? []) : [])),
                );
                const withMem = withMemoryUsedPreamble(withSrc, recalledItems, memorySummaryUsed);
                const memoryApiKey = process.env.OPENROUTER_API_KEY;
                const withPostMem = memoryApiKey
                  ? withPostTurnMemory(withMem, {
                      userId,
                      agentId: body.agentId,
                      conversationId: body.conversationId,
                      authToken,
                      config: memoryConfig,
                      userMessage: promptText,
                      apiKey: memoryApiKey,
                    })
                  : withMem;
                const guarded = withOutputGuardrails(
                  withPostMem,
                  effectiveGuardrails,
                  citations.length > 0,
                );
                return new Response(guarded, {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    "X-Trace-Id": trace.traceId,
                    ...corsHeaders,
                  },
                });
              }
            }

            // No tools (or unsupported provider for tools) — plain stream.
            const upstream = await streamWithProvider({
              userId,
              provider,
              modelId: model,
              systemPrompt: effectiveSystemPrompt,
              messages: flatMessages,
              temperature: body.temperature,
              maxTokens: body.maxTokens,
              gateway: gatewayOverride,
            });
            const tapped = withTraceTap(upstream.body, trace);
            const withCits = withCitationsPreamble(tapped, citations);
            const withSrc = withSourcesTrailer(withCits, citationSources(citations), []);
            const withMem = withMemoryUsedPreamble(withSrc, recalledItems, memorySummaryUsed);
            const memoryApiKey = process.env.OPENROUTER_API_KEY;
            const withPostMem = memoryApiKey
              ? withPostTurnMemory(withMem, {
                  userId,
                  agentId: body.agentId,
                  conversationId: body.conversationId,
                  authToken,
                  config: memoryConfig,
                  userMessage: promptText,
                  apiKey: memoryApiKey,
                })
              : withMem;
            const guarded = withOutputGuardrails(
              withPostMem,
              effectiveGuardrails,
              citations.length > 0,
            );
            return new Response(guarded, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Trace-Id": trace.traceId,
                ...corsHeaders,
              },
            });
          } catch (err) {
            // A client abort is the user hitting Stop, not a provider fault:
            // nobody is listening for this response, so record the turn as
            // cancelled rather than as a scary provider error in Traces.
            if (err instanceof Error && err.name === "AbortError") {
              await recordTrace({
                trace,
                status: "cancelled",
                errorMessage: "Cancelled by the user",
                assistantText: "",
              }).catch(() => {});
              return new Response(null, { status: 499 });
            }
            const message = err instanceof Error ? err.message : "Provider error";
            console.error(`Provider ${provider} error:`, err);
            await recordTrace({
              trace,
              status: "error",
              errorMessage: message,
              assistantText: "",
            });
            return new Response(JSON.stringify({ error: message }), {
              status: 502,
              headers: {
                "Content-Type": "application/json",
                "X-Trace-Id": trace.traceId,
                ...corsHeaders,
              },
            });
          }
        } catch (e) {
          console.error("chat route error:", e);
          return new Response(
            JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
          );
        }
      },
    },
  },
});
