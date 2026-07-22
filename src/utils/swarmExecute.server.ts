// Headless server-side swarm executor.
//
// The in-browser runtime (swarmRuntime.ts) can't run without a tab, so API-key
// and scheduled runs use this executor instead. It shares the pure graph
// helpers (topoLevels/interpolate/gatherInputs) with the client runtime, calls
// this app's own /api/chat internally (service secret + owner id) for LLM
// nodes, and calls the deterministic node cores directly.
//
// v1 supported nodes: input, agent, condition, router, foreach, extract,
// set_var, merge, http, tool (non-RLS), output, approval (auto-decided).
// Not yet headless: loop, evaluate, retrieve, function, a2a, and the RLS-scoped
// tools (kb_search / sql_query) — they need the owner's JWT and error clearly.
import type { Node, Edge } from "@xyflow/react";
import {
  interpolate,
  resolveStatePath,
  gatherInputs,
  topoLevels,
  type SwarmNodeData,
} from "@/lib/swarmRuntime";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  runHttpNodeCore,
  runToolNodeCore,
  RLS_TOOL_IDS,
  type ToolNodeParams,
} from "@/utils/swarmNodes.server";

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

// ── internal /api/chat call ─────────────────────────────────────────────────
async function serverChat(args: {
  origin: string;
  userId: string;
  node: Node<SwarmNodeData>;
  systemPrompt: string;
  userMessage: string;
  signal?: AbortSignal;
}): Promise<string> {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Server is missing SUPABASE_SERVICE_ROLE_KEY");
  const d = args.node.data;
  // Strip RLS-scoped tools — there's no user JWT in a headless run.
  const enabledTools = Array.isArray(d.enabledTools)
    ? d.enabledTools.filter((t) => !RLS_TOOL_IDS.has(t))
    : undefined;
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
      messages: [{ role: "user", content: args.userMessage }],
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
  rejectApprovals: boolean;
  source: "api" | "schedule";
}): Promise<ExecuteResult> {
  const nodes = (Array.isArray(opts.swarm.nodes) ? opts.swarm.nodes : []) as Node<SwarmNodeData>[];
  const edges = (Array.isArray(opts.swarm.edges) ? opts.swarm.edges : []) as Edge[];

  // Record the run for observability (Recent runs / traces).
  let runId: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from("swarm_runs")
      .insert({
        user_id: opts.userId,
        swarm_id: opts.swarm.id,
        swarm_name: `${opts.swarm.name} (${opts.source})`,
        input_prompt: opts.input,
        swarm_snapshot: { nodes, edges } as never,
        status: "running",
      } as never)
      .select("id")
      .single();
    runId = data?.id ?? null;
  } catch {
    /* observability is best-effort */
  }

  const finish = async (status: "success" | "error", output: string, error: string | null) => {
    if (runId) {
      await supabaseAdmin
        .from("swarm_runs")
        .update({
          status,
          final_output: output || null,
          error_message: error,
          finished_at: new Date().toISOString(),
        } as never)
        .eq("id", runId)
        .then(undefined, () => undefined);
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
        if (skipped.has(node.id)) continue;
        const d = node.data;
        const kind = d.kind;
        const outVar = d.outputVar || `out_${node.id}`;
        const write = (v: string) => {
          ctx[outVar] = v;
          lastOutput = v;
        };

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
          const res = await runHttpNodeCore(opts.userId, {
            method: d.httpMethod || "GET",
            url: interpolate(d.httpUrl || "", ctx),
            headers: (d.httpHeaders ?? [])
              .filter((h) => (h.key || "").trim())
              .map((h) => ({ key: h.key, value: interpolate(h.value ?? "", ctx) })),
            body: d.httpBody ? interpolate(d.httpBody, ctx) : undefined,
            timeout_ms: d.httpTimeoutMs,
          });
          if (!res.ok) throw new Error(`HTTP node failed: ${res.error}`);
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
          if (!toolId || !HEADLESS_SAFE_TOOLS.has(toolId)) {
            throw new Error(
              `Tool "${toolId ?? "?"}" isn't available in headless runs yet (needs the owner's login). Supported: ${[...HEADLESS_SAFE_TOOLS].join(", ")}.`,
            );
          }
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(d.toolArgs ?? {}))
            args[k] = interpolate(String(v ?? ""), ctx);
          const params: ToolNodeParams = {
            tool_id: toolId as ToolNodeParams["tool_id"],
            args,
            mcp_servers: d.toolConfigs?.mcp_server_names,
            web_config: d.toolConfigs?.web_search || d.toolConfigs?.web_browse,
          };
          const res = await runToolNodeCore(
            { userId: opts.userId, sb: supabaseAdmin as never },
            params,
          );
          if (!res.ok) throw new Error(`Tool node failed: ${res.error}`);
          write(res.result);
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
          const result = await serverChat({
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
            const out = await serverChat({
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
          const out = await serverChat({
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
          const out = await serverChat({
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
              typeof e.label === "string" && e.label.trim().toLowerCase() === picked.toLowerCase();
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
              `Approval "${d.label}" auto-rejected (headless run configured to reject).`,
            );
          }
          // auto-approve: pass the content through unchanged.
          write(gatherInputs(node, ctx, lastOutput));
          continue;
        }
        if (kind === "agent") {
          const out = await serverChat({
            origin: opts.origin,
            userId: opts.userId,
            node,
            systemPrompt: interpolate(d.systemPrompt || "You are a helpful assistant.", ctx),
            userMessage: gatherInputs(node, ctx, lastOutput),
          });
          write(out);
          continue;
        }
        // Unsupported in headless v1.
        throw new Error(
          `Node type "${kind}" isn't supported in headless (API/scheduled) runs yet. Run it from the canvas, or remove it from the deployed swarm.`,
        );
      }
    }

    return await finish("success", lastOutput, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await finish("error", "", msg);
  }
}
