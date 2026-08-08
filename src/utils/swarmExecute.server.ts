// Headless server-side swarm executor.
//
// The in-browser runtime (swarmRuntime.ts) can't run without a tab, so API-key
// and scheduled runs use this executor instead. It shares the pure graph
// helpers (topoLevels/interpolate/gatherInputs) with the client runtime, calls
// this app's own /api/chat internally (service secret + owner id) for LLM
// nodes, and calls the deterministic node cores directly.
//
// Supported nodes: input, agent, condition, router, loop, evaluate, foreach,
// extract, set_var, merge, http, retrieve, tool (incl. owner-scoped kb_search /
// sql_query), output, approval (auto-decided), subswarm.
// Owner-scoped data access: on headless runs the tool loaders run under the
// service-role client but with ctx.scopeUserId set, which restricts results to
// what the owner may read — their own tables/KBs, public samples, and
// IAM-shared resources (mirrors RLS); never another tenant's.
// Agent nodes may also use kb_search / sql_query directly: /api/chat's internal
// path caps their toolset to the headless-safe set and owner-scopes it.
// `function` (custom JS) runs in the JS SANDBOX SERVICE when one is deployed
// (JS_SANDBOX_URL) — never in this process, which holds the service-role key
// and provider credentials. Without that service it is refused, with a message
// saying how to enable it. Still owner-login-only: `a2a_remote` (needs the
// owner's JWT for the /api/a2a proxy).
import type { Node, Edge } from "@xyflow/react";
import {
  interpolate,
  resolveStatePath,
  gatherInputs,
  topoLevels,
  hasDoneSignal,
  decideYesNo,
  type SwarmNodeData,
} from "@/lib/swarmRuntime";
// Graph semantics live in ONE place, shared with the canvas runtime, so the
// deployed run can't quietly mean something different from the one you tested.
import {
  SkipTracker,
  canContinueOnError,
  clampIters,
  indexEdges,
  retryPolicyOf,
  FOREACH_DEFAULT_ITEMS,
  FOREACH_MAX_ITEMS,
  LOOP_DEFAULT_ITERS,
  LOOP_MAX_ITERS,
  MAX_SUBSWARM_DEPTH,
} from "@/lib/swarmGraph";
import { captureCheckpoint, restoreTracker, type SwarmCheckpoint } from "@/lib/swarmCheckpoint";
import { commitLevelWrites, type StagedWrites, type StateReducer } from "@/lib/swarmGraph";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from "@/utils/swarmCheckpoint.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createServerSwarmTracer } from "@/utils/observability/serverTracer.server";
import { runHttpNodeCore, runToolNodeCore, type ToolNodeParams } from "@/utils/swarmNodes.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";
import { internalRunSecret } from "@/utils/internalOrigin.server";
import {
  jsSandboxConfigured,
  runSandboxedServer,
  JS_SANDBOX_UNAVAILABLE,
} from "@/utils/jsSandbox.server";
import { coerceParams, missingRequired } from "@/lib/swarmComponents";
import { resolveDeployedGraph } from "@/lib/swarmPublish";
import { safeStringify } from "@/lib/sandbox/jsSandbox";
import { envInt } from "@/utils/rateLimit.server";

// Tool context for headless data tools: service-role client with scopeUserId
// set, which forces the loaders to restrict data to what the owner may read
// (own + public samples + IAM-shared).
function dataToolCtx(userId: string): AgentToolContext {
  return { userId, sb: supabaseAdmin as never, scopeUserId: userId };
}

export type ExecuteResult = {
  /**
   * "suspended" = parked at a human-approval node with a checkpoint. The run is
   * neither done nor failed; resumeSwarmRun continues it once a decision lands.
   */
  status: "success" | "error" | "suspended";
  output: string;
  error: string | null;
  runId: string | null;
};

type Ctx = Record<string, string>;

/**
 * How many nodes of one level may run at once.
 *
 * 4 is a compromise: enough that a fan-out of independent agent calls stops
 * being serial, low enough that a wide level does not trip a provider's rate
 * limit — which would turn a speed-up into a run failure.
 */
const LEVEL_CONCURRENCY = Math.max(1, envInt("SWARM_LEVEL_CONCURRENCY", 4));

const HEADLESS_SAFE_TOOLS = new Set([
  "web_search",
  "web_browse",
  "calculator",
  "datetime",
  "weather",
  "mcp_call_tool",
]);

// Data tools that read the owner's rows. Safe headless ONLY because the tool
// context carries scopeUserId, which forces the loaders to restrict results to
// what the owner may read — own + public samples + IAM-shared (see
// AgentToolContext.scopeUserId).
const HEADLESS_SCOPED_TOOLS = new Set(["sql_query", "kb_search"]);

// ── internal /api/chat call ─────────────────────────────────────────────────
async function serverChat(args: {
  origin: string;
  userId: string;
  node: Node<SwarmNodeData>;
  systemPrompt: string;
  userMessage: string;
  signal?: AbortSignal;
  // Chat mode: prior conversation turns replayed as leading messages.
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * Receives the turn's measured usage from /api/chat's `cost` event. The
   * browser runtime consumes the same event; without this the headless path
   * (deployed API, schedules, evals) recorded latency but zero tokens/cost.
   */
  onUsage?: (u: { model?: string; costUsd: number; tokensIn: number; tokensOut: number }) => void;
}): Promise<string> {
  const secret = internalRunSecret();
  if (!secret) {
    throw new Error("Server is missing INTERNAL_RUN_SECRET / SUPABASE_SERVICE_ROLE_KEY");
  }
  const d = args.node.data;
  // Pass the node's tools through as-is: /api/chat's internal path caps them to
  // the headless-safe set and owner-scopes the data tools (scopeUserId), so
  // agent-embedded kb_search / sql_query work without a user JWT.
  const enabledTools = Array.isArray(d.enabledTools) ? d.enabledTools : undefined;
  const res = await fetch(`${args.origin}/api/chat`, {
    method: "POST",
    signal: args.signal,
    headers: { "Content-Type": "application/json", "x-internal-run-secret": secret },
    body: JSON.stringify({
      internalUserId: args.userId,
      provider: d.provider || "openrouter",
      model: d.model || "google/gemini-3-flash-preview",
      systemPrompt: args.systemPrompt,
      temperature: typeof d.temperature === "number" ? d.temperature : 0.4,
      maxTokens: 8192,
      messages: [
        ...(args.history ?? []).map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: args.userMessage },
      ],
      enabledTools,
      toolConfigs: d.toolConfigs && typeof d.toolConfigs === "object" ? d.toolConfigs : undefined,
      guardrails:
        d.guardrails && typeof d.guardrails === "object" && Object.keys(d.guardrails).length > 0
          ? d.guardrails
          : undefined,
      // No memory in headless runs (no user-scoped store).
      memoryOverrides: { stm_enabled: false, ltm_enabled: false, ltm_scope: "none" },
    }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`chat failed [${res.status}]: ${txt.slice(0, 300)}`);
  }
  // Parse the OpenAI-compatible SSE stream → assistant text.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let event = "message";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        event = "message";
        continue;
      }
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      if (event === "cost") {
        try {
          const c = JSON.parse(payload) as {
            model?: string;
            costUsd?: number;
            tokensIn?: number;
            tokensOut?: number;
          };
          args.onUsage?.({
            model: c.model,
            costUsd: c.costUsd ?? 0,
            tokensIn: c.tokensIn ?? 0,
            tokensOut: c.tokensOut ?? 0,
          });
        } catch {
          /* telemetry only — never break the run */
        }
        continue;
      }
      if (event !== "message") continue;
      try {
        const p = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        const delta = p.choices?.[0]?.delta?.content ?? p.choices?.[0]?.message?.content ?? "";
        if (typeof delta === "string") text += delta;
      } catch {
        /* keep-alive */
      }
    }
  }
  return text.trim();
}

// Extract a JSON payload from an optionally fenced string.
function stripFence(s: string): string {
  const m = s.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

/**
 * Raise the approval request a parked run is waiting on.
 *
 * Deliberately the same row shape the canvas runtime writes, so one inbox shows
 * approvals from runs started anywhere — a run parked by a schedule at 3am and
 * one parked from the canvas look identical to the person deciding.
 *
 * Best-effort: if the row can't be written the run still parks, and its
 * checkpoint still allows a manual resume. Losing the notification is
 * recoverable; losing the run is not.
 */
async function createApprovalRequest(args: {
  userId: string;
  runId: string | null;
  node: Node<SwarmNodeData>;
  content: string;
}): Promise<void> {
  const d = args.node.data as SwarmNodeData & {
    avatar?: string;
    approvalTitle?: string;
    approvalRisk?: string;
    approverUserIds?: string[];
    approverGroupIds?: string[];
  };
  try {
    await supabaseAdmin.from("approvals").insert({
      user_id: args.userId,
      agent_name: d.label || "Approval gate",
      agent_avatar: d.avatar || "🛡️",
      action_type: "swarm_step",
      action_title: d.approvalTitle || `Approve step: ${d.label ?? "step"}`,
      description: args.content.slice(0, 1000),
      risk_level: d.approvalRisk || "medium",
      payload: { last_output: args.content.slice(0, 4000) },
      approver_user_ids: Array.isArray(d.approverUserIds) ? d.approverUserIds : [],
      approver_group_ids: Array.isArray(d.approverGroupIds) ? d.approverGroupIds : [],
      swarm_run_id: args.runId,
    } as never);
  } catch (e) {
    console.warn("[swarmExecute] could not create approval request:", (e as Error).message);
  }
}

// ── main executor ────────────────────────────────────────────────────────────
export async function executeSwarmServer(opts: {
  swarm: { id: string; name: string; nodes: unknown; edges: unknown };
  userId: string;
  origin: string;
  input: string;
  initialState?: Record<string, string>;
  // Chat mode (API): prior conversation turns replayed into every agent node.
  history?: { role: "user" | "assistant"; content: string }[];
  rejectApprovals: boolean;
  source: "api" | "schedule";
  depth?: number;
  /**
   * Absolute wall-clock deadline for the whole run. Nested Execute-Swarm nodes
   * inherit the parent's deadline so nesting can't multiply the budget.
   */
  deadlineAt?: number;
  /**
   * Resume an interrupted run instead of starting a fresh one. The caller
   * supplies the existing run id (so the timeline continues rather than
   * forking) and the state it had reached.
   */
  resume?: {
    runId: string;
    checkpoint: SwarmCheckpoint;
    /** The human's answer to the approval this run parked at. */
    decision?: { approved: boolean; note?: string };
  };
}): Promise<ExecuteResult> {
  const nodes = (Array.isArray(opts.swarm.nodes) ? opts.swarm.nodes : []) as Node<SwarmNodeData>[];
  const edges = (Array.isArray(opts.swarm.edges) ? opts.swarm.edges : []) as Edge[];
  const depth = opts.depth ?? 0;

  // Whole-run deadline. Without one, a hung provider or a long foreach/loop can
  // hold a worker (and the caller's connection) indefinitely. The signal is
  // threaded into every LLM call so an expiry actually cancels in-flight work
  // instead of just being noticed afterwards.
  const deadlineAt = opts.deadlineAt ?? Date.now() + envInt("SWARM_RUN_TIMEOUT_MS", 600_000);
  const ac = new AbortController();
  const msLeft = () => deadlineAt - Date.now();
  const timer = setTimeout(() => ac.abort(), Math.max(1, msLeft()));
  const expired = () => ac.signal.aborted || msLeft() <= 0;
  const deadlineError = () =>
    new Error(
      `Run exceeded its time budget (${Math.round(envInt("SWARM_RUN_TIMEOUT_MS", 600_000) / 1000)}s). ` +
        `Simplify the swarm or raise SWARM_RUN_TIMEOUT_MS.`,
    );

  // Per-node retry policy (mirrors the canvas runtime's runNodeWithPolicy).
  // Applied at the call layer rather than by replaying the node body, so the
  // node dispatch chain stays untouched. Transient upstream failures — a
  // provider 429/5xx, a flaky HTTP endpoint — are where retries actually pay
  // off, and every retryable node kind routes through one of these.
  const withNodeRetry = async <T>(d: SwarmNodeData, fn: () => Promise<T>): Promise<T> => {
    const { retries, delayMs: delay } = retryPolicyOf(d);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (expired()) throw deadlineError();
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        // Never burn retries on a deliberate cancellation or an expired budget.
        if (ac.signal.aborted || expired()) throw err;
        if (attempt < retries && delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  };

  // Measured usage per node id, summed across retries and multi-call nodes
  // (foreach/loop bodies). Drained when the node's step row is finished.
  const nodeUsage = new Map<
    string,
    { model?: string; costUsd: number; tokensIn: number; tokensOut: number }
  >();

  // Inject the conversation history into every LLM node call (chat mode), and
  // record what the call actually cost.
  const chat = (a: Parameters<typeof serverChat>[0]) =>
    withNodeRetry(a.node.data, () =>
      serverChat({
        ...a,
        history: opts.history,
        signal: ac.signal,
        onUsage: (u) => {
          const prev = nodeUsage.get(a.node.id) ?? { costUsd: 0, tokensIn: 0, tokensOut: 0 };
          nodeUsage.set(a.node.id, {
            model: u.model ?? prev.model,
            costUsd: prev.costUsd + u.costUsd,
            tokensIn: prev.tokensIn + u.tokensIn,
            tokensOut: prev.tokensOut + u.tokensOut,
          });
        },
      }),
    );

  // Record the run + per-node steps for observability (Recent runs / traces),
  // via the same tables the canvas tracer uses — so deployed-API and scheduled
  // runs get the full per-node timeline too. Only the top-level run is traced;
  // nested Execute-Swarm runs don't clutter the history. All best-effort.
  const tracer =
    depth === 0
      ? await createServerSwarmTracer({
          userId: opts.userId,
          swarmId: opts.swarm.id,
          swarmName: `${opts.swarm.name} (${opts.source})`,
          inputPrompt: opts.input,
          swarmSnapshot: { nodes, edges },
        })
      : null;
  const runId: string | null = tracer?.runId ?? null;

  const finish = async (
    status: "success" | "error" | "suspended",
    output: string,
    error: string | null,
  ) => {
    if (tracer) {
      // A suspended run is deliberately left open: its timeline continues when
      // the approval is decided, so it must not be closed off as finished.
      if (status === "suspended") {
        await supabaseAdmin
          .from("swarm_runs")
          .update({ status: "suspended", updated_at: new Date().toISOString() })
          .eq("id", runId!);
      } else {
        await tracer.finish({ status, finalOutput: output || null, errorMessage: error });
      }
    }
    // A TERMINAL run keeps no checkpoint — leaving one behind would let a
    // finished run be "resumed", re-running everything after the last node. A
    // suspended run keeps its checkpoint; that is the whole point of it.
    if (runId && depth === 0 && status !== "suspended") await clearCheckpoint(runId);
    return { status, output, error, runId };
  };

  try {
    // A resumed run starts from where it stopped, not from the top.
    const resumed = opts.resume?.checkpoint ?? null;
    const ctx: Ctx = resumed
      ? { ...resumed.ctx }
      : { input: opts.input, ...(opts.initialState ?? {}) };
    let lastOutput = resumed ? resumed.lastOutput : opts.input;
    // Nodes already executed, so a resume never re-runs one. Re-running an
    // agent call or an HTTP POST is not free and not idempotent.
    const completed = new Set<string>(resumed?.completedNodeIds ?? []);
    const levels = topoLevels(nodes, edges);

    const graph = indexEdges(edges);
    const { outgoing } = graph;
    // Routing decisions survive the interruption too. Without them a resumed
    // run would treat every branch as live and execute paths the condition had
    // already ruled out.
    const flow = resumed ? restoreTracker(graph, resumed) : new SkipTracker(graph);

    // Only a top-level run checkpoints. A nested Execute-Swarm run is part of
    // its parent's node and is resumed by re-running that node, not on its own.
    const durable = depth === 0 && Boolean(runId);
    const persist = async (suspendedNodeId?: string | null) => {
      if (!durable || !runId) return;
      await saveCheckpoint({
        runId,
        userId: opts.userId,
        source: opts.source,
        depth,
        checkpoint: captureCheckpoint({
          ctx,
          lastOutput,
          completed,
          flow,
          levelIndex,
          suspendedNodeId,
        }),
      });
    };

    let levelIndex = 0;
    // Branch decisions taken during a level, applied together afterwards.
    const pendingSkips: { deadEdgeIds: string[]; deadTargets: string[] }[] = [];
    // Set when a node in the current level hits an approval gate. Boxed so
    // TypeScript cannot narrow it to null: it is assigned inside runOneNode,
    // which control-flow analysis assumes may never be called.
    const suspension: { at: { nodeId: string; pending: string } | null } = { at: null };
    // Per-key merge rules, when a swarm declares them. Absent = "last wins",
    // which is exactly what sequential execution did.
    const stateReducers =
      (opts.swarm as { stateReducers?: Record<string, StateReducer> }).stateReducers ?? {};
    for (const level of levels) {
      const runOneNode = async (node: Node<SwarmNodeData>, staged: StagedWrites) => {
        // Fail fast between nodes rather than starting work we can't finish.
        if (expired()) throw deadlineError();
        // Already done in an earlier attempt of this run — its output is in ctx
        // and re-running it would repeat whatever side effect it had.
        if (completed.has(node.id)) return;
        const d = node.data;
        const kind = d.kind;
        const outVar = d.outputVar || `out_${node.id}`;
        let stepOutput: string | null = null;
        // Staged, not written. Nodes in a level run concurrently, so mutating
        // shared state here would make the result depend on which finished
        // first; the level commits in level order once everyone is done.
        const write = (v: string) => {
          staged.writes.push([outVar, v]);
          staged.output = v;
          stepOutput = v;
        };

        // Skipped by an upstream condition/router — record a skipped step so
        // the timeline shows the branch that was routed away.
        if (flow.isSkipped(node.id)) {
          if (tracer) {
            await tracer.startStep({ nodeId: node.id, nodeLabel: d.label, nodeKind: kind });
            await tracer.finishStep(node.id, { status: "skipped" });
          }
          return;
        }

        // Open a trace step and record the live incoming edges feeding it.
        const stepStartedAt = Date.now();
        if (tracer) {
          const stepInput = kind === "input" ? opts.input : gatherInputs(node, ctx, lastOutput);
          await tracer.startStep({
            nodeId: node.id,
            nodeLabel: d.label,
            nodeKind: kind,
            input: { prompt: stepInput },
          });
          for (const e of flow.liveIncoming(node.id)) {
            const payload = ctx[`out_${e.source}`] ?? "";
            await tracer.recordEdge({
              sourceNodeId: e.source,
              targetNodeId: e.target,
              payloadPreview: payload.slice(0, 500),
              bytes: payload.length,
            });
          }
        }

        let stepError: string | null = null;
        try {
          if (kind === "input") {
            write(opts.input);
            return;
          }
          if (kind === "output") {
            write(gatherInputs(node, ctx, lastOutput));
            return;
          }
          if (kind === "set_var") {
            const written: Record<string, string> = {};
            for (const a of d.stateAssignments ?? []) {
              const key = (a.key || "").trim();
              if (!key) continue;
              const val = interpolate(a.value ?? "", ctx);
              staged.writes.push([key, val]);
              written[key] = val;
            }
            write(JSON.stringify(written));
            return;
          }
          if (kind === "merge") {
            const names = d.inputs ?? [];
            const mode = d.mergeMode || "concat";
            const parse = (s: string): unknown => {
              try {
                return JSON.parse(s);
              } catch {
                return s;
              }
            };
            if (mode === "array") write(JSON.stringify(names.map((n) => parse(ctx[n] ?? ""))));
            else if (mode === "object")
              write(JSON.stringify(Object.fromEntries(names.map((n) => [n, parse(ctx[n] ?? "")]))));
            else if (mode === "first")
              write(ctx[names.find((n) => (ctx[n] ?? "").trim() !== "") ?? ""] ?? "");
            else
              write(
                names
                  .map((n) => ctx[n] ?? "")
                  .filter((v) => v.trim() !== "")
                  .join(d.mergeSeparator ?? "\n\n"),
              );
            return;
          }
          if (kind === "http") {
            const res = await withNodeRetry(d, async () => {
              const r = await runHttpNodeCore(opts.userId, {
                method: d.httpMethod || "GET",
                url: interpolate(d.httpUrl || "", ctx),
                headers: (d.httpHeaders ?? [])
                  .filter((h) => (h.key || "").trim())
                  .map((h) => ({ key: h.key, value: interpolate(h.value ?? "", ctx) })),
                body: d.httpBody ? interpolate(d.httpBody, ctx) : undefined,
                timeout_ms: d.httpTimeoutMs,
              });
              // Surface as a throw so the node's retry policy can act on it.
              if (!r.ok) throw new Error(`HTTP node failed: ${r.error}`);
              return r;
            });
            let out = res.body;
            const path = d.httpResponsePath?.trim();
            if (path) {
              const expr = path.startsWith("[") ? `__resp${path}` : `__resp.${path}`;
              const picked = resolveStatePath({ __resp: res.body }, expr);
              if (picked !== undefined) out = picked;
            }
            write(out);
            return;
          }
          if (kind === "tool") {
            const toolId = d.toolId;
            const isScoped = !!toolId && HEADLESS_SCOPED_TOOLS.has(toolId);
            if (!toolId || (!HEADLESS_SAFE_TOOLS.has(toolId) && !isScoped)) {
              throw new Error(
                `Tool "${toolId ?? "?"}" isn't available in headless runs yet (needs the owner's login). Supported: ${[...HEADLESS_SAFE_TOOLS, ...HEADLESS_SCOPED_TOOLS].join(", ")}.`,
              );
            }
            const args: Record<string, string> = {};
            for (const [k, v] of Object.entries(d.toolArgs ?? {}))
              args[k] = interpolate(String(v ?? ""), ctx);
            const params: ToolNodeParams = {
              tool_id: toolId as ToolNodeParams["tool_id"],
              args,
              knowledge_base_id: d.knowledgeBaseId ?? undefined,
              sql_tables: d.toolConfigs?.sql_table_names,
              mcp_servers: d.toolConfigs?.mcp_server_names,
              web_config: d.toolConfigs?.web_search || d.toolConfigs?.web_browse,
            };
            const res = await withNodeRetry(d, async () => {
              const r = await runToolNodeCore(dataToolCtx(opts.userId), params);
              if (!r.ok) throw new Error(`Tool node failed: ${r.error}`);
              return r;
            });
            write(res.result);
            return;
          }
          if (kind === "retrieve") {
            const kbId = d.knowledgeBaseId;
            if (!kbId) throw new Error("Retrieve node has no knowledge base selected.");
            const query = interpolate(d.retrieveQuery || "{{input}}", ctx);
            const res = await withNodeRetry(d, async () => {
              const r = await runToolNodeCore(dataToolCtx(opts.userId), {
                tool_id: "kb_search",
                args: { query, top_k: String(d.retrieveTopK ?? 5) },
                knowledge_base_id: kbId,
              });
              if (!r.ok) throw new Error(`Retrieve node failed: ${r.error}`);
              return r;
            });
            write(res.result);
            return;
          }
          if (kind === "loop") {
            const max = clampIters(d.maxIters, LOOP_DEFAULT_ITERS, LOOP_MAX_ITERS);
            const loopInput = gatherInputs(node, ctx, lastOutput);
            const loopPrompt = interpolate(d.systemPrompt || "{{input}}", {
              ...ctx,
              input: loopInput,
            });
            let result = "";
            for (let i = 0; i < max; i++) {
              result = await chat({
                origin: opts.origin,
                userId: opts.userId,
                node,
                systemPrompt: loopPrompt,
                userMessage: `Original input:\n${loopInput}\n\nPrevious attempt:\n${result || "(none)"}`,
              });
              if (hasDoneSignal(result)) break;
            }
            write(result);
            return;
          }
          if (kind === "evaluate") {
            const inputText = gatherInputs(node, ctx, lastOutput);
            const metrics = (d.evalMetrics ?? []).filter((m) => m.enabled);
            if (metrics.length === 0) throw new Error("Evaluate node has no enabled metrics.");
            const threshold = typeof d.evalPassThreshold === "number" ? d.evalPassThreshold : 0.7;
            const metricsBlock = metrics
              .map((m) => `- **${m.name}** (id: "${m.id}", weight: ${m.weight}): ${m.description}`)
              .join("\n");
            const ref = d.evalReferenceInput?.trim();
            const refBlock =
              ref && ctx[ref] ? `\n\n## Reference / Original Question\n${ctx[ref]}` : "";
            const rubric = d.evalRubric?.trim() ? `\n\n## Evaluation Rubric\n${d.evalRubric}` : "";
            const sys = `You are a strict, impartial LLM evaluation judge. Score the CANDIDATE OUTPUT against each metric on a 0.0–1.0 scale.\n\n## Metrics\n${metricsBlock}${rubric}\n\n## Output format\nReturn ONLY valid JSON — no fences:\n{\n  "metrics": {\n${metrics.map((m) => `    "${m.id}": { "score": <0.0-1.0>, "reason": "<why>" }`).join(",\n")}\n  },\n  "overall_score": <weighted average>,\n  "pass": <true if overall_score >= ${threshold}>,\n  "summary": "<2-3 sentences>"\n}`;
            const result = await chat({
              origin: opts.origin,
              userId: opts.userId,
              node,
              systemPrompt: sys,
              userMessage: `## Candidate Output\n${inputText}${refBlock}\n\nReturn the JSON scorecard.`,
            });
            write(stripFence(result));
            return;
          }
          if (kind === "extract") {
            const inputText = gatherInputs(node, ctx, lastOutput);
            const fields = (d.extractSchema ?? []).filter((f) => (f.name || "").trim());
            if (fields.length === 0) throw new Error("Extract node has no fields.");
            const fieldLines = fields
              .map((f) => `- "${f.name}" (${f.type})${f.description ? ": " + f.description : ""}`)
              .join("\n");
            const sys = `You extract structured data. Read the INPUT and return ONLY a JSON object with exactly these fields — no prose, no markdown fences:\n${fieldLines}\n\nUse null for any value you cannot find.`;
            const result = await chat({
              origin: opts.origin,
              userId: opts.userId,
              node,
              systemPrompt: sys,
              userMessage: `INPUT:\n${inputText}`,
            });
            write(stripFence(result));
            return;
          }
          if (kind === "foreach") {
            const srcName = d.foreachInput?.trim() || d.inputs?.[0] || "input";
            const raw = ctx[srcName] ?? lastOutput;
            let arr: unknown[];
            try {
              const parsed = JSON.parse(raw);
              arr = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
              arr = raw
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean);
            }
            const cap = clampIters(d.maxIters, FOREACH_DEFAULT_ITEMS, FOREACH_MAX_ITEMS);
            const itemVar = d.foreachItemVar?.trim() || "item";
            const results: unknown[] = [];
            for (let i = 0; i < Math.min(arr.length, cap); i++) {
              const item = arr[i];
              const itemStr = typeof item === "string" ? item : JSON.stringify(item);
              const bodyCtx = { ...ctx, [itemVar]: itemStr, index: String(i) };
              const out = await chat({
                origin: opts.origin,
                userId: opts.userId,
                node,
                systemPrompt: interpolate(d.systemPrompt || `Process: {{${itemVar}}}`, bodyCtx),
                userMessage: itemStr,
              });
              try {
                results.push(JSON.parse(out));
              } catch {
                results.push(out);
              }
            }
            write(JSON.stringify(results));
            return;
          }
          if (kind === "condition") {
            const judgeInput = gatherInputs(node, ctx, lastOutput);
            const out = await chat({
              origin: opts.origin,
              userId: opts.userId,
              node,
              systemPrompt: "You are a strict binary classifier. Reply only YES or NO.",
              userMessage: `${d.conditionPrompt || "Should we proceed?"}\n\nINPUT:\n${judgeInput}\n\nAnswer with a single word: YES or NO.`,
            });
            const decision = decideYesNo(out);
            if (!decision) {
              // Undecided rather than guessed — see decideYesNo. Throwing lets
              // retryCount re-ask instead of silently taking a branch.
              throw new Error(
                `Condition judge gave no clear YES/NO answer: ` +
                  `${out.trim().slice(0, 200) || "(empty)"}`,
              );
            }
            write(decision);
            const deadTargets: string[] = [];
            const deadEdgeIds: string[] = [];
            for (const e of outgoing.get(node.id) ?? []) {
              if (!e.label) continue;
              const live =
                (decision === "YES" && String(e.label).toLowerCase().trim() === "yes") ||
                (decision === "NO" && String(e.label).toLowerCase().trim() === "no");
              if (!live) {
                deadEdgeIds.push(e.id);
                deadTargets.push(e.target);
              }
            }
            // Staged: two conditions in one level would otherwise race on the
            // tracker, and propagateSkip's result depends on the state it sees.
            pendingSkips.push({ deadEdgeIds, deadTargets });
            return;
          }
          if (kind === "router") {
            const routerInput = gatherInputs(node, ctx, lastOutput);
            const outEdges = outgoing.get(node.id) ?? [];
            const choices = Array.from(
              new Set(
                outEdges
                  .filter((e) => typeof e.label === "string" && e.label.trim())
                  .map((e) => String(e.label).trim()),
              ),
            );
            if (choices.length === 0) throw new Error("Router node has no labeled outgoing edges.");
            const out = await chat({
              origin: opts.origin,
              userId: opts.userId,
              node,
              systemPrompt:
                "You are a strict routing classifier. Reply with exactly one route name from the provided list — no other text.",
              userMessage: `${d.routerPrompt || "Pick the single best route."}\n\nINPUT:\n${routerInput}\n\nAvailable routes:\n${choices.map((c) => `- ${c}`).join("\n")}\n\nReply with ONLY one route name.`,
            });
            const lower = out.trim().toLowerCase();
            const picked =
              choices.find((c) => c.toLowerCase() === lower) ??
              choices.find((c) => lower.includes(c.toLowerCase()));
            // Was choices[0], which silently sent the run down an arbitrary
            // branch and still reported success — potentially straight past an
            // approval gate. Throwing lets retryCount re-ask, and a genuinely
            // unroutable answer fails loudly instead of guessing.
            if (!picked) {
              throw new Error(
                `Router could not map the model's answer to a route. Expected one of ` +
                  `[${choices.join(", ")}], got: ${out.trim().slice(0, 200) || "(empty)"}`,
              );
            }
            write(picked);
            const deadTargets: string[] = [];
            const deadEdgeIds: string[] = [];
            for (const e of outEdges) {
              const live =
                typeof e.label === "string" &&
                e.label.trim().toLowerCase() === picked.toLowerCase();
              if (!live) {
                deadEdgeIds.push(e.id);
                deadTargets.push(e.target);
              }
            }
            // Staged: two conditions in one level would otherwise race on the
            // tracker, and propagateSkip's result depends on the state it sees.
            pendingSkips.push({ deadEdgeIds, deadTargets });
            return;
          }
          if (kind === "approval") {
            if (opts.rejectApprovals) {
              // Fail closed stays the default for unattended callers: an API
              // key or schedule with nobody watching must not park a run
              // forever waiting for a human who will never look.
              throw new Error(
                `Stopped at human-approval step "${d.label}": this run has nobody to approve it. ` +
                  `That is the safe default. To let this swarm wait for a real decision, turn ` +
                  `off "Reject approvals" on the API key or schedule — the run will then park ` +
                  `here and resume when someone approves it.`,
              );
            }
            const pending = gatherInputs(node, ctx, lastOutput);

            // Resuming INTO the node we parked at: the decision is in hand.
            const decision = opts.resume?.decision;
            if (resumed?.suspendedNodeId === node.id && decision) {
              if (decision.approved) {
                write(pending);
                return;
              }
              throw new Error(
                `Rejected at human-approval step "${d.label}"` +
                  (decision.note ? `: ${decision.note}` : "."),
              );
            }

            // First time here: park the run. The checkpoint is what makes this
            // possible — without it there would be nothing to come back to.
            await createApprovalRequest({
              userId: opts.userId,
              runId,
              node,
              content: pending,
            });
            // Recorded, not returned: this function now runs one node of a
            // level, so returning here would only end the node. The level
            // runner parks the whole run once the level settles.
            suspension.at = { nodeId: node.id, pending };
            return;
          }
          if (kind === "agent") {
            const out = await chat({
              origin: opts.origin,
              userId: opts.userId,
              node,
              systemPrompt: interpolate(d.systemPrompt || "You are a helpful assistant.", ctx),
              userMessage: gatherInputs(node, ctx, lastOutput),
            });
            write(out);
            return;
          }
          if (kind === "subswarm") {
            if (depth >= MAX_SUBSWARM_DEPTH) {
              throw new Error(
                `Execute Swarm nesting is too deep (max ${MAX_SUBSWARM_DEPTH} levels).`,
              );
            }
            const subId = d.subSwarmId;
            if (!subId) throw new Error("Execute Swarm node has no swarm selected.");
            const { data: sub } = await supabaseAdmin
              .from("swarms")
              .select(
                "id, name, nodes, edges, user_id, published_nodes, published_edges, published_at",
              )
              .eq("id", subId)
              .maybeSingle();
            if (!sub || sub.user_id !== opts.userId) {
              throw new Error("Referenced swarm not found or not owned by you.");
            }
            // A nested swarm resolves the same way as its parent: a headless
            // run must not pick up someone's in-progress edit of the child.
            const subGraph = resolveDeployedGraph(sub);
            const subResult = await executeSwarmServer({
              swarm: { id: sub.id, name: sub.name, nodes: subGraph.nodes, edges: subGraph.edges },
              userId: opts.userId,
              origin: opts.origin,
              input: gatherInputs(node, ctx, lastOutput),
              rejectApprovals: opts.rejectApprovals,
              source: opts.source,
              depth: depth + 1,
              // Inherit the parent's budget — nesting must not multiply it.
              deadlineAt,
            });
            if (subResult.status === "error")
              throw new Error(`Sub-swarm failed: ${subResult.error}`);
            write(subResult.output);
            return;
          }
          if (kind === "function") {
            // Custom code runs in the JS sandbox SERVICE, never in this
            // process: the app holds the service-role key and provider
            // credentials, so a snippet here would be one prototype-chain
            // trick away from all of it. The service is a separate container
            // with no secrets, no egress and a fresh realm per call.
            if (!(await jsSandboxConfigured())) throw new Error(JS_SANDBOX_UNAVAILABLE);
            const inputValue = gatherInputs(node, ctx, lastOutput);
            const snippet = (d.functionCode || "return ctx.input;").trim();
            const timeoutMs = Math.max(100, Math.min(d.functionTimeoutMs ?? 2000, 5000));
            const cParams = d.componentParams ?? [];
            const cValues = d.componentValues ?? {};
            if (cParams.length > 0) {
              const missing = missingRequired(cParams, cValues);
              if (missing.length > 0) {
                throw new Error(
                  `${d.componentName ?? "Component"} node is missing required parameter${
                    missing.length === 1 ? "" : "s"
                  }: ${missing.join(", ")}.`,
                );
              }
            }
            const result = await runSandboxedServer(
              snippet,
              {
                input: inputValue,
                vars: { ...ctx },
                params: cParams.length > 0 ? coerceParams(cParams, cValues) : {},
              },
              timeoutMs,
              ac.signal,
            );
            if (!result.ok) {
              const who = d.componentName ? `Component "${d.componentName}"` : "Function node";
              throw new Error(`${who} error: ${result.error}`);
            }
            write(safeStringify(result.value));
            return;
          }
          if (kind === "a2a_remote") {
            throw new Error(
              "A2A remote-agent nodes aren't available in headless runs yet — they need your login to authorize the remote call.",
            );
          }
          // Anything else we don't explicitly handle.
          throw new Error(
            `Node type "${kind}" isn't supported in headless (API/scheduled) runs yet. Run it from the canvas, or remove it from the deployed swarm.`,
          );
        } catch (stepErr) {
          stepError = stepErr instanceof Error ? stepErr.message : String(stepErr);
          // Honour the node's on-error policy, same as the canvas runtime.
          // "continue" writes the configured fallback and lets the run proceed;
          // "fail" (the default) aborts. A cancelled/expired run always aborts —
          // continuing past a deadline would defeat the budget.
          // A failed condition/router never selected a branch, so every
          // outgoing edge would still be live and BOTH paths would run — an
          // approval branch and its bypass, for example. There is no safe
          // "continue" past an unmade routing decision, so those always fail.
          const canContinue = canContinueOnError(
            { kind, onError: d.onError },
            { aborted: ac.signal.aborted, expired: expired() },
          );
          if (canContinue) {
            const fallback = d.errorFallback ?? "";
            staged.writes.push([outVar, fallback]);
            staged.output = fallback;
            stepOutput = fallback;
          } else {
            throw stepErr;
          }
        } finally {
          if (tracer) {
            const meta = d as { model?: string; provider?: string };
            const used = nodeUsage.get(node.id);
            nodeUsage.delete(node.id);
            await tracer.finishStep(node.id, {
              status: stepError ? "error" : "success",
              output: stepError ? null : stepOutput,
              errorMessage: stepError,
              llmModel: used?.model ?? meta.model ?? null,
              llmProvider: meta.provider ?? null,
              tokensIn: used?.tokensIn,
              tokensOut: used?.tokensOut,
              costUsd: used?.costUsd,
              latencyMs: Date.now() - stepStartedAt,
            });
          }
          // Checkpoint AFTER the node, in `finally`, so a node that failed but
          // was continued past (onError: continue) is still recorded as done —
          // otherwise a resume would re-run it and could fail differently.
          // A node parked at an approval is NOT complete: the resume has to
          // re-enter it to find the decision. Marking it done here would skip
          // it and carry on as if it had been approved.
          const parkedHere = suspension.at?.nodeId === node.id;
          if (!parkedHere && (!stepError || staged.writes.length > 0)) completed.add(node.id);
        }
      };

      // Run the level. Nodes in a level depend only on EARLIER levels, so they
      // are independent of each other and safe to overlap — that is what the
      // topological ordering buys. Bounded, because firing a whole level of
      // agent calls at one provider is the reliable way to get rate-limited.
      const stagedByNode: StagedWrites[] = level.map((n) => ({
        nodeId: n.id,
        writes: [],
        output: null,
      }));
      const failures: { index: number; error: unknown }[] = [];
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= level.length) return;
          try {
            await runOneNode(level[i], stagedByNode[i]);
          } catch (e) {
            // Collected, not thrown: throwing here would leave the other
            // in-flight nodes unobserved. The level rethrows in order below.
            failures.push({ index: i, error: e });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(LEVEL_CONCURRENCY, level.length) }, worker));

      // Commit in LEVEL ORDER, never completion order, so the run's result does
      // not depend on which model happened to reply first.
      const merged = commitLevelWrites(ctx, stagedByNode, stateReducers);
      if (merged.lastOutput !== null) lastOutput = merged.lastOutput;

      // Apply the branch decisions this level took, also in level order, so a
      // level containing two conditions kills the same edges every time.
      for (const pending of pendingSkips) {
        flow.killEdges(pending.deadEdgeIds);
        if (pending.deadTargets.length) flow.propagateSkip(pending.deadTargets);
      }
      pendingSkips.length = 0;

      // One failure fails the run — and deterministically the FIRST in level
      // order, so the same broken swarm reports the same error every time.
      if (failures.length > 0) {
        failures.sort((a, b) => a.index - b.index);
        throw failures[0].error;
      }

      levelIndex++;
      // Park AFTER committing: the other nodes in this level did real work, and
      // their results belong in the checkpoint the approver's decision resumes
      // from. Resumption replays the levels and skips whatever is in the
      // completed set — and the parked node is deliberately NOT in it, so the
      // resume re-enters that node and finds the decision waiting.
      const parked = suspension.at;
      if (parked) {
        await persist(parked.nodeId);
        return await finish("suspended", parked.pending, null);
      }
      // Checkpoint per level rather than per node: with a level committed
      // atomically, mid-level is not a state the run can resume from anyway.
      await persist();
    }

    return await finish("success", lastOutput, null);
  } catch (err) {
    // An expired deadline surfaces as a low-level AbortError from whichever
    // fetch was in flight — report the actual cause instead.
    const aborted =
      ac.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message)));
    const msg = aborted
      ? deadlineError().message
      : err instanceof Error
        ? err.message
        : String(err);
    return await finish("error", "", msg);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Continue an interrupted run from its checkpoint.
 *
 * The graph comes from the run's own snapshot rather than the swarm's current
 * definition: a swarm edited since the run started would otherwise resume into
 * a different graph, with a checkpoint describing nodes that may no longer
 * exist. The run finishes as the graph it began as.
 *
 * Returns null when there is nothing to resume — no such run, not the caller's,
 * already finished, or no checkpoint (a run that predates checkpointing, or one
 * whose checkpoint writes failed).
 */
export async function resumeSwarmRun(args: {
  runId: string;
  userId: string;
  origin: string;
  rejectApprovals?: boolean;
  /** The approver's answer, when resuming a run parked at an approval node. */
  decision?: { approved: boolean; note?: string };
}): Promise<ExecuteResult | null> {
  const { data: run } = await supabaseAdmin
    .from("swarm_runs")
    .select("id, user_id, swarm_id, swarm_name, swarm_snapshot, input_prompt, status")
    .eq("id", args.runId)
    .eq("user_id", args.userId)
    .maybeSingle();
  if (!run) return null;
  if (run.status === "success" || run.status === "error") return null;

  const checkpoint = await loadCheckpoint(args.runId, args.userId);
  if (!checkpoint) return null;

  const snapshot = (run.swarm_snapshot ?? {}) as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) return null;

  return executeSwarmServer({
    swarm: {
      id: run.swarm_id ?? "",
      name: run.swarm_name ?? "Swarm",
      nodes: snapshot.nodes,
      edges: Array.isArray(snapshot.edges) ? snapshot.edges : [],
    },
    userId: args.userId,
    origin: args.origin,
    input: run.input_prompt ?? "",
    rejectApprovals: args.rejectApprovals ?? false,
    source: "api",
    resume: { runId: args.runId, checkpoint, decision: args.decision },
  });
}
