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
// Still owner-login-only: `function` (custom JS — RCE risk in the server realm)
// and `a2a_remote` (needs the owner's JWT for the /api/a2a proxy).
import type { Node, Edge } from "@xyflow/react";
import {
  interpolate,
  resolveStatePath,
  gatherInputs,
  topoLevels,
  hasDoneSignal,
  type SwarmNodeData,
} from "@/lib/swarmRuntime";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createServerSwarmTracer } from "@/utils/observability/serverTracer.server";
import { runHttpNodeCore, runToolNodeCore, type ToolNodeParams } from "@/utils/swarmNodes.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";
import { internalRunSecret } from "@/utils/internalOrigin.server";
import { envInt } from "@/utils/rateLimit.server";

// Tool context for headless data tools: service-role client with scopeUserId
// set, which forces the loaders to restrict data to what the owner may read
// (own + public samples + IAM-shared).
function dataToolCtx(userId: string): AgentToolContext {
  return { userId, sb: supabaseAdmin as never, scopeUserId: userId };
}

export type ExecuteResult = {
  status: "success" | "error";
  output: string;
  error: string | null;
  runId: string | null;
};

type Ctx = Record<string, string>;

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
      if (!payload || payload === "[DONE]" || event !== "message") continue;
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
    const retries = Math.max(0, Math.min(d.retryCount ?? 0, 5));
    const delay = Math.max(0, Math.min(d.retryDelayMs ?? 1000, 30_000));
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

  // Inject the conversation history into every LLM node call (chat mode).
  const chat = (a: Parameters<typeof serverChat>[0]) =>
    withNodeRetry(a.node.data, () =>
      serverChat({ ...a, history: opts.history, signal: ac.signal }),
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

  const finish = async (status: "success" | "error", output: string, error: string | null) => {
    if (tracer) {
      await tracer.finish({ status, finalOutput: output || null, errorMessage: error });
    }
    return { status, output, error, runId };
  };

  try {
    const ctx: Ctx = { input: opts.input, ...(opts.initialState ?? {}) };
    let lastOutput = opts.input;
    const levels = topoLevels(nodes, edges);

    const outgoing = new Map<string, Edge[]>();
    const incoming = new Map<string, Edge[]>();
    edges.forEach((e) => {
      (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e);
      (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e);
    });
    const skipped = new Set<string>();
    const deadEdges = new Set<string>();
    const propagateSkip = (targets: string[]) => {
      const q = [...targets];
      while (q.length) {
        const nid = q.shift()!;
        const inc = incoming.get(nid) ?? [];
        if (inc.every((e) => skipped.has(e.source) || deadEdges.has(e.id))) {
          skipped.add(nid);
          for (const e of outgoing.get(nid) ?? []) if (!skipped.has(e.target)) q.push(e.target);
        }
      }
    };

    for (const level of levels) {
      for (const node of level) {
        // Fail fast between nodes rather than starting work we can't finish.
        if (expired()) throw deadlineError();
        const d = node.data;
        const kind = d.kind;
        const outVar = d.outputVar || `out_${node.id}`;
        let stepOutput: string | null = null;
        const write = (v: string) => {
          ctx[outVar] = v;
          lastOutput = v;
          stepOutput = v;
        };

        // Skipped by an upstream condition/router — record a skipped step so
        // the timeline shows the branch that was routed away.
        if (skipped.has(node.id)) {
          if (tracer) {
            await tracer.startStep({ nodeId: node.id, nodeLabel: d.label, nodeKind: kind });
            await tracer.finishStep(node.id, { status: "skipped" });
          }
          continue;
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
          for (const e of incoming.get(node.id) ?? []) {
            if (skipped.has(e.source) || deadEdges.has(e.id)) continue;
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
            continue;
          }
          if (kind === "output") {
            write(gatherInputs(node, ctx, lastOutput));
            continue;
          }
          if (kind === "set_var") {
            const written: Record<string, string> = {};
            for (const a of d.stateAssignments ?? []) {
              const key = (a.key || "").trim();
              if (!key) continue;
              const val = interpolate(a.value ?? "", ctx);
              ctx[key] = val;
              written[key] = val;
            }
            write(JSON.stringify(written));
            continue;
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
            continue;
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
            continue;
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
            continue;
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
            continue;
          }
          if (kind === "loop") {
            const max = Math.max(1, Math.min(d.maxIters ?? 3, 6));
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
            continue;
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
            continue;
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
            continue;
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
            const cap = Math.max(1, Math.min(d.maxIters ?? 25, 100));
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
            continue;
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
            const decision = /yes/i.test(out) ? "YES" : "NO";
            write(decision);
            const deadTargets: string[] = [];
            for (const e of outgoing.get(node.id) ?? []) {
              if (!e.label) continue;
              const live =
                (decision === "YES" && String(e.label).toLowerCase().trim() === "yes") ||
                (decision === "NO" && String(e.label).toLowerCase().trim() === "no");
              if (!live) {
                deadEdges.add(e.id);
                deadTargets.push(e.target);
              }
            }
            if (deadTargets.length) propagateSkip(deadTargets);
            continue;
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
              choices.find((c) => lower.includes(c.toLowerCase())) ??
              choices[0];
            write(picked);
            const deadTargets: string[] = [];
            for (const e of outEdges) {
              const live =
                typeof e.label === "string" &&
                e.label.trim().toLowerCase() === picked.toLowerCase();
              if (!live) {
                deadEdges.add(e.id);
                deadTargets.push(e.target);
              }
            }
            if (deadTargets.length) propagateSkip(deadTargets);
            continue;
          }
          if (kind === "approval") {
            if (opts.rejectApprovals) {
              throw new Error(
                `Stopped at human-approval step "${d.label}": this run has nobody to approve it. ` +
                  `That is the safe default. To let this swarm decide approvals on its own, turn ` +
                  `off "Reject approvals" on the API key or schedule — it will then auto-approve ` +
                  `every approval step.`,
              );
            }
            // auto-approve: pass the content through unchanged.
            write(gatherInputs(node, ctx, lastOutput));
            continue;
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
            continue;
          }
          if (kind === "subswarm") {
            if (depth >= 3) throw new Error("Execute Swarm nesting is too deep (max 3 levels).");
            const subId = d.subSwarmId;
            if (!subId) throw new Error("Execute Swarm node has no swarm selected.");
            const { data: sub } = await supabaseAdmin
              .from("swarms")
              .select("id, name, nodes, edges, user_id")
              .eq("id", subId)
              .maybeSingle();
            if (!sub || sub.user_id !== opts.userId) {
              throw new Error("Referenced swarm not found or not owned by you.");
            }
            const subResult = await executeSwarmServer({
              swarm: sub,
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
            continue;
          }
          if (kind === "function") {
            throw new Error(
              "Function (custom JS) nodes can't run in headless (API/scheduled) runs — arbitrary code isn't executed on the server. Run this swarm from the canvas.",
            );
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
          const isBranchNode = kind === "condition" || kind === "router";
          const canContinue =
            (d.onError ?? "fail") === "continue" &&
            !isBranchNode &&
            !ac.signal.aborted &&
            !expired();
          if (canContinue) {
            const fallback = d.errorFallback ?? "";
            ctx[outVar] = fallback;
            lastOutput = fallback;
            stepOutput = fallback;
          } else {
            throw stepErr;
          }
        } finally {
          if (tracer) {
            const meta = d as { model?: string; provider?: string };
            await tracer.finishStep(node.id, {
              status: stepError ? "error" : "success",
              output: stepError ? null : stepOutput,
              errorMessage: stepError,
              llmModel: meta.model ?? null,
              llmProvider: meta.provider ?? null,
              latencyMs: Date.now() - stepStartedAt,
            });
          }
        }
      }
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
