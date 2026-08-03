// OTLP/HTTP trace exporter — streams AgentSwarms observability to any
// OpenTelemetry collector (Datadog Agent OTLP receiver, Grafana Tempo, Jaeger,
// otelcol, …) so multi-agent runs and LLM calls show up as distributed traces.
//
// Design (deliberately decoupled from the request path so it can NEVER break a
// user-facing call):
//   • A batch job, not inline instrumentation. It runs on the scheduler pass
//     (the same lease as retention/alerts), reads newly-finished rows since a
//     per-stream keyset cursor, and POSTs them as OTLP/HTTP JSON. If the
//     endpoint is unset it is a no-op, so default deployments are unaffected.
//   • Two streams become two shapes of trace:
//       - swarm_runs  → one distributed trace per run: a root span for the run
//         and a child span per swarm_run_step, nested by parent_step_id. This
//         is the multi-agent waterfall.
//       - execution_traces → one single-span trace per LLM call (playground,
//         saved agents, BI agent, KB, memory, embeddings — everything that
//         records a call), carrying OTel GenAI semantic-convention attributes.
//   • IDs are derived deterministically from row UUIDs (a UUID is exactly the
//     16 bytes an OTLP trace id needs), so re-sending a row produces identical
//     ids — delivery is at-least-once and a collector can dedupe on
//     (trace_id, span_id).
//   • Only span METADATA is exported (model, tokens, cost, status, timing,
//     node graph). Prompt/response bodies are never put on spans — the SELECTs
//     below do not fetch those columns at all, so there is nothing to leak
//     regardless of PERSIST_PROMPT_BODIES.
//
//     ONE EXCEPTION, which this comment used to claim did not exist:
//     error_message IS selected, on all three streams, and lands on the span
//     status. Provider errors quote the input that upset them often enough
//     ("Invalid content in messages[0].content: …", moderation refusals
//     echoing the prompt) that it is a real content path to a third party. It
//     is redacted and truncated — see safeStatusMessage — rather than
//     dropped, because an error with no message is a span nobody can debug.
//
// The collector endpoint is operator-configured trust (like the internal
// self-call origin), so it is intentionally NOT run through the SSRF guard —
// collectors normally live on a private/in-cluster address (otel-collector:4318).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { redactPII } from "@/utils/guardrails";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const BATCH_TRACES = 500; // execution_traces spans per tick
const BATCH_RUNS = 100; // swarm_runs (+ their steps) per tick
const EXPORT_LAG_MS = 10_000; // settle window: don't export rows newer than this
const POST_TIMEOUT_MS = 10_000;

// ── config ───────────────────────────────────────────────────────────────
export function otelExportEnabled(): boolean {
  return !!(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  );
}

/** Full traces URL: the explicit signal endpoint, else base + /v1/traces (OTel convention). */
function tracesEndpoint(): string | null {
  const explicit = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (explicit) return explicit;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, "") + "/v1/traces";
}

/** Parse OTEL_EXPORTER_OTLP_HEADERS ("k=v,k2=v2") — e.g. an API key for hosted collectors. */
function parseHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function serviceName(): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || "agentswarms";
}

// ── OTLP JSON building blocks ──────────────────────────────────────────────
type AttrVal =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };
type Attr = { key: string; value: AttrVal };
type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number; message?: string };
};

const hex = (uuid: string) => uuid.replace(/-/g, "").toLowerCase();
/** OTLP/JSON trace id: 16 bytes = 32 hex. A UUID is exactly 16 bytes. */
const traceIdOf = (uuid: string) => hex(uuid).slice(0, 32).padEnd(32, "0");
/** OTLP/JSON span id: 8 bytes = 16 hex. First half of the row's UUID. */
const spanIdOf = (uuid: string) => hex(uuid).slice(0, 16).padEnd(16, "0");

const sAttr = (k: string, v?: string | null): Attr[] =>
  v == null || v === "" ? [] : [{ key: k, value: { stringValue: String(v) } }];
const iAttr = (k: string, v?: number | null): Attr[] =>
  v == null ? [] : [{ key: k, value: { intValue: String(Math.trunc(v)) } }];
const dAttr = (k: string, v?: number | null): Attr[] =>
  v == null ? [] : [{ key: k, value: { doubleValue: Number(v) } }];

/** ms → uint64 nanoseconds, as a JSON string (numbers can't hold uint64). */
function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n).toString();
}
function statusCode(status: string): number {
  return status === "error" ? 2 : status === "success" ? 1 : 0; // 2 ERROR, 1 OK, 0 UNSET
}
/**
 * Longest error text put on an exported span.
 *
 * Provider errors are not bounded by anything on our side — some echo the whole
 * offending request back — and an unbounded status message both inflates the
 * OTLP payload and can exceed a collector's own attribute limits, which
 * silently drops the span rather than truncating it.
 */
const MAX_STATUS_MESSAGE = 500;

/**
 * The one place a span can carry text that came from outside.
 *
 * Every other field exported here is metadata by construction — the SELECTs
 * never fetch prompt, request_payload or response_payload, so there is nothing
 * to leak. `error_message` is the exception the header's claim did not cover:
 * provider errors routinely quote the input that upset them ("Invalid content
 * in messages[0].content: …", moderation refusals echoing the prompt), so it is
 * the one path by which user content could reach a third-party collector.
 *
 * Run through the SAME redactor the guardrails use rather than a second copy —
 * it masks emails, phone numbers, card and national-ID numbers, and the API-key
 * shapes, which is exactly what tends to be quoted back in an error.
 */
export function safeStatusMessage(message: string | null): string {
  const raw = (message ?? "").trim();
  if (!raw) return "error";
  const { text } = redactPII(raw.slice(0, MAX_STATUS_MESSAGE * 4));
  return text.length > MAX_STATUS_MESSAGE ? `${text.slice(0, MAX_STATUS_MESSAGE)}…` : text;
}

export function spanStatus(
  status: string,
  message: string | null,
): { code: number; message?: string } {
  const code = statusCode(status);
  return code === 2 ? { code, message: safeStatusMessage(message) } : { code };
}

// ── row shapes (the columns we select) ─────────────────────────────────────
interface LlmRow {
  id: string;
  created_at: string;
  parent_trace_id: string | null;
  llm_provider: string;
  llm_model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  status: string;
  error_message: string | null;
  agent_name: string;
  agent_id: string | null;
  user_id: string;
}
interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_message: string | null;
  swarm_id: string | null;
  swarm_name: string | null;
  step_count: number;
  error_count: number;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_latency_ms: number;
  user_id: string;
}
interface StepRow {
  id: string;
  run_id: string;
  parent_step_id: string | null;
  node_id: string;
  node_kind: string;
  node_label: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_message: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  user_id: string;
}

// ── span builders ──────────────────────────────────────────────────────────
function llmSpan(t: LlmRow): Span {
  const endMs = new Date(t.created_at).getTime();
  const startMs = endMs - (t.latency_ms || 0); // created_at ≈ end; back out latency for start
  // A child call (a tool round inside a chat turn) joins its PARENT's trace:
  // same trace id, parented under the parent's span — so a chat turn renders
  // as one distributed waterfall instead of scattered single-span traces.
  const rootId = t.parent_trace_id ?? t.id;
  return {
    traceId: traceIdOf(rootId),
    spanId: spanIdOf(t.id),
    ...(t.parent_trace_id ? { parentSpanId: spanIdOf(t.parent_trace_id) } : {}),
    name: `chat ${t.llm_model}`,
    kind: 3, // CLIENT — calls out to a model provider
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(endMs),
    attributes: [
      ...sAttr("gen_ai.operation.name", "chat"),
      ...sAttr("gen_ai.system", t.llm_provider),
      ...sAttr("gen_ai.request.model", t.llm_model),
      ...iAttr("gen_ai.usage.input_tokens", t.tokens_in),
      ...iAttr("gen_ai.usage.output_tokens", t.tokens_out),
      ...dAttr("agentswarms.cost_usd", t.cost_usd),
      ...sAttr("agentswarms.source", "llm_call"),
      ...sAttr("agentswarms.agent_name", t.agent_name),
      ...sAttr("agentswarms.agent_id", t.agent_id),
      ...sAttr("enduser.id", t.user_id),
    ],
    status: spanStatus(t.status, t.error_message),
  };
}

function runSpans(run: RunRow, steps: StepRow[]): Span[] {
  const traceId = traceIdOf(run.id);
  const rootSpanId = spanIdOf(run.id);
  const startMs = new Date(run.started_at).getTime();
  const endMs = run.finished_at
    ? new Date(run.finished_at).getTime()
    : startMs + (run.total_latency_ms || 0);
  const root: Span = {
    traceId,
    spanId: rootSpanId,
    name: `swarm ${run.swarm_name || run.swarm_id || "run"}`,
    kind: 1, // INTERNAL — server-side orchestration
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(endMs),
    attributes: [
      ...sAttr("agentswarms.source", "swarm_run"),
      ...sAttr("agentswarms.swarm_id", run.swarm_id),
      ...sAttr("agentswarms.swarm_name", run.swarm_name),
      ...iAttr("agentswarms.step_count", run.step_count),
      ...iAttr("agentswarms.error_count", run.error_count),
      ...dAttr("agentswarms.total_cost_usd", run.total_cost_usd),
      ...iAttr("gen_ai.usage.input_tokens", run.total_tokens_in),
      ...iAttr("gen_ai.usage.output_tokens", run.total_tokens_out),
      ...sAttr("enduser.id", run.user_id),
    ],
    status: spanStatus(run.status, run.error_message),
  };

  const stepSpans = steps.map<Span>((s) => {
    const sStartMs = new Date(s.started_at).getTime();
    const sEndMs = s.finished_at
      ? new Date(s.finished_at).getTime()
      : sStartMs + (s.latency_ms || 0);
    return {
      traceId,
      spanId: spanIdOf(s.id),
      // Nest under the parent step for subswarm/foreach children; else the run root.
      parentSpanId: s.parent_step_id ? spanIdOf(s.parent_step_id) : rootSpanId,
      name: `${s.node_kind}${s.node_label ? `:${s.node_label}` : ""}`,
      kind: s.llm_model ? 3 : 1, // model node → CLIENT, control node → INTERNAL
      startTimeUnixNano: nanos(sStartMs),
      endTimeUnixNano: nanos(sEndMs),
      attributes: [
        ...sAttr("agentswarms.source", "swarm_step"),
        ...sAttr("agentswarms.node_kind", s.node_kind),
        ...sAttr("agentswarms.node_id", s.node_id),
        ...sAttr("agentswarms.node_label", s.node_label),
        ...sAttr("gen_ai.system", s.llm_provider),
        ...sAttr("gen_ai.request.model", s.llm_model),
        ...iAttr("gen_ai.usage.input_tokens", s.tokens_in),
        ...iAttr("gen_ai.usage.output_tokens", s.tokens_out),
        ...dAttr("agentswarms.cost_usd", s.cost_usd),
        ...sAttr("enduser.id", s.user_id),
      ],
      status: spanStatus(s.status, s.error_message),
    };
  });

  return [root, ...stepSpans];
}

function wrap(spans: Span[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName() } },
            { key: "telemetry.sdk.name", value: { stringValue: "agentswarms" } },
            { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
          ],
        },
        scopeSpans: [{ scope: { name: "agentswarms.observability", version: "1" }, spans }],
      },
    ],
  };
}

async function postSpans(spans: Span[]): Promise<void> {
  if (spans.length === 0) return;
  const endpoint = tracesEndpoint();
  if (!endpoint) return;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...parseHeaders() },
    body: JSON.stringify(wrap(spans)),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OTLP export HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ── cursor (keyset watermark per stream) ───────────────────────────────────
type Cursor = { last_ts: string; last_id: string };

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    /schema cache|does not exist|could not find the table/i.test(error.message ?? "")
  );
}

/**
 * Read the stream cursor. On first sight (no row) initialize it to NOW so the
 * first export starts from "now forward" rather than backfilling all history
 * into the collector, and return null to skip this tick. Returns null (skip)
 * when the cursor table doesn't exist yet (pre-migration).
 */
async function loadCursor(stream: string): Promise<Cursor | null> {
  const { data, error } = await supabaseAdmin
    .from("otel_export_cursor")
    .select("last_ts,last_id")
    .eq("stream", stream)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  if (!data) {
    await supabaseAdmin
      .from("otel_export_cursor")
      .insert({ stream, last_ts: new Date().toISOString(), last_id: ZERO_UUID });
    return null;
  }
  return { last_ts: data.last_ts, last_id: data.last_id };
}

async function saveCursor(stream: string, ts: string, id: string): Promise<void> {
  await supabaseAdmin
    .from("otel_export_cursor")
    .update({ last_ts: ts, last_id: id, updated_at: new Date().toISOString() })
    .eq("stream", stream);
}

/** PostgREST keyset predicate: (tsCol, id) > (last_ts, last_id). */
function keyset(tsCol: string, c: Cursor): string {
  return `${tsCol}.gt.${c.last_ts},and(${tsCol}.eq.${c.last_ts},id.gt.${c.last_id})`;
}

// ── per-stream export ──────────────────────────────────────────────────────
async function exportLlmCalls(cutoffIso: string): Promise<void> {
  const c = await loadCursor("execution_traces");
  if (!c) return;
  const { data, error } = await supabaseAdmin
    .from("execution_traces")
    .select(
      "id,created_at,llm_provider,llm_model,tokens_in,tokens_out,cost_usd,latency_ms,status,error_message,agent_name,agent_id,user_id,parent_trace_id",
    )
    .lte("created_at", cutoffIso)
    .or(keyset("created_at", c))
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(BATCH_TRACES);
  if (error) throw error;
  const rows = (data ?? []) as unknown as LlmRow[];
  if (rows.length === 0) return;
  await postSpans(rows.map(llmSpan));
  const last = rows[rows.length - 1];
  await saveCursor("execution_traces", last.created_at, last.id);
}

async function exportSwarmRuns(cutoffIso: string): Promise<void> {
  const c = await loadCursor("swarm_runs");
  if (!c) return;
  const { data: runsData, error } = await supabaseAdmin
    .from("swarm_runs")
    .select(
      "id,started_at,finished_at,status,error_message,swarm_id,swarm_name,step_count,error_count,total_cost_usd,total_tokens_in,total_tokens_out,total_latency_ms,user_id",
    )
    .in("status", ["success", "error"])
    .not("finished_at", "is", null)
    .lte("finished_at", cutoffIso)
    .or(keyset("finished_at", c))
    .order("finished_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(BATCH_RUNS);
  if (error) throw error;
  const runs = (runsData ?? []) as unknown as RunRow[];
  if (runs.length === 0) return;

  const runIds = runs.map((r) => r.id);
  const { data: stepsData, error: sErr } = await supabaseAdmin
    .from("swarm_run_steps")
    .select(
      "id,run_id,parent_step_id,node_id,node_kind,node_label,started_at,finished_at,status,error_message,llm_provider,llm_model,tokens_in,tokens_out,cost_usd,latency_ms,user_id",
    )
    .in("run_id", runIds);
  if (sErr) throw sErr;

  const byRun = new Map<string, StepRow[]>();
  for (const s of (stepsData ?? []) as unknown as StepRow[]) {
    const arr = byRun.get(s.run_id);
    if (arr) arr.push(s);
    else byRun.set(s.run_id, [s]);
  }

  const spans: Span[] = [];
  for (const run of runs) spans.push(...runSpans(run, byRun.get(run.id) ?? []));
  await postSpans(spans);

  const last = runs[runs.length - 1];
  await saveCursor("swarm_runs", last.finished_at as string, last.id);
}

// ── entry point (called from the scheduler pass) ───────────────────────────
let running = false;

/**
 * Export one bounded batch per stream to the configured OTLP collector. No-op
 * when no endpoint is configured. Never throws — a failed POST leaves the
 * cursor unmoved so the batch is retried on the next pass (at-least-once). A
 * large backlog drains over several passes rather than in one long tick.
 */
export async function exportOtelTraces(): Promise<void> {
  if (!otelExportEnabled()) return;
  if (running) return; // don't overlap a slow previous pass within this process
  running = true;
  try {
    const cutoffIso = new Date(Date.now() - EXPORT_LAG_MS).toISOString();
    await exportSwarmRuns(cutoffIso);
    await exportLlmCalls(cutoffIso);
  } catch (e) {
    console.warn("[otel-export] failed:", e instanceof Error ? e.message : String(e));
  } finally {
    running = false;
  }
}

// Exposed for tests: build spans without touching the network or DB.
export const __test = { llmSpan, runSpans, wrap, traceIdOf, spanIdOf, nanos, keyset };
