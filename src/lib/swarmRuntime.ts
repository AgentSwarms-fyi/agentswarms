// In-browser swarm orchestrator.
// Executes a graph of agent / control-flow nodes by topologically sorting them
// and calling /api/chat for each agent. Variables flow along edges through a
// shared `context` map keyed by each node's `outputVar`.
//
// Nodes supported:
//   - input        : seed value for the run (provided by user at start)
//   - agent        : LLM call via /api/chat (streamed; text accumulated)
//   - condition    : LLM-judged boolean route — chooses one outgoing edge by label
//   - loop         : re-runs the agent body until a check passes or max_iters
//   - approval     : pauses execution until the user resolves an approval row
//   - evaluate     : LLM-as-a-judge eval node — scores upstream output on configurable
//                    metrics (faithfulness, relevancy, completeness, etc.) against a
//                    rubric and returns a structured JSON scorecard.
//   - output       : terminal node; final value displayed
//
// IMPORTANT: keep this client-only. It uses fetch() against /api/chat and the
// browser supabase client.

import { supabase } from "@/integrations/supabase/client";
import type { Node, Edge } from "@xyflow/react";
import { buildUserMessage, invokeAgent, type AgentCard } from "@/lib/a2aClient";
import { runSandboxed, safeStringify } from "@/lib/sandbox/jsSandbox";
import { isImageModelId } from "@/lib/providerSupport";

// Match data URIs and common http(s) image URLs in arbitrary text. Used to
// detect when an upstream node's output contains an image so the next node
// can receive it as an image_url part for editing or vision analysis instead
// of as a giant pasted-text data URL.
const IMAGE_URL_RE_GLOBAL =
  /(data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)"'<>]*)?)/gi;

// Pull out ALL image URLs from a string and return both the cleaned text
// (with image URLs and any wrapping markdown image syntax stripped) and the
// list of unique image URLs found. Used to forward upstream-generated images
// to vision-capable agents as proper image_url parts instead of burying them
// as multi-hundred-KB base64 strings inside the text prompt — which both blows
// past token limits and prevents the model from actually "seeing" the image.
function extractAllImageUrls(text: string): { cleaned: string; images: string[] } {
  if (!text) return { cleaned: "", images: [] };
  const images: string[] = [];
  const seen = new Set<string>();
  // First, capture and remove full markdown image syntax: ![alt](url)
  let cleaned = text.replace(
    /!\[[^\]]*\]\((data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)"'<>]*)?)\)/gi,
    (_m, url: string) => {
      if (!seen.has(url)) {
        seen.add(url);
        images.push(url);
      }
      return "[image attached as vision input]";
    },
  );
  // Then, catch any bare URLs/data-URIs not wrapped in markdown.
  cleaned = cleaned.replace(IMAGE_URL_RE_GLOBAL, (m: string) => {
    if (!seen.has(m)) {
      seen.add(m);
      images.push(m);
    }
    return "[image attached as vision input]";
  });
  return { cleaned: cleaned.trim(), images };
}

export type SwarmNodeKind =
  | "input"
  | "agent"
  | "condition"
  | "router"
  | "loop"
  | "approval"
  | "evaluate"
  | "output"
  | "a2a_remote"
  | "function";

// The curated set of tool ids a swarm node can opt into. Mirrors
// `TOOLABLE_IDS` in registry.server.ts. Kept as plain string union here so
// the client doesn't pull in a server-only module.
export type SwarmToolId =
  | "kb_search"
  | "kb_graph_search"
  | "web_search"
  | "web_browse"
  | "n8n_run_workflow"
  | "mcp_call_tool"
  | "calculator"
  | "datetime"
  | "weather"
  | "sql_query";

// Per-node tool configuration. Mirrors the server's ToolConfigs shape.
export type SwarmToolConfigs = {
  web_search?: { provider?: string; api_key?: string };
  web_browse?: { provider?: string; api_key?: string };
  n8n_workflow_ids?: string[];
  mcp_server_names?: string[];
  // Allow-list of CSV-derived data table names the sql_query tool may read.
  // Empty / undefined = every table the user can see.
  sql_table_names?: string[];
};

// Per-node guardrails — same shape the agent builder writes under
// agents.tools.guardrails. The server merges these OVER the linked agent's
// saved guardrails, so a swarm node can be stricter than its source agent.
// Kept as a Partial<> here because every field is optional (only the toggles
// the user actually changed need to ride along on the wire).
export type SwarmGuardrails = {
  enableInputFilters?: boolean;
  enableOutputFilters?: boolean;
  blockPII?: boolean;
  blockProfanity?: boolean;
  maxInputLength?: number;
  topicRestrictions?: string;
  allowedTopics?: string;
  blockedPatterns?: string;
  enableCitationCheck?: boolean;
  enableHallucinationFilter?: boolean;
  contentSafetyLevel?: "off" | "low" | "medium" | "high";
};

export type SwarmNodeData = {
  label: string;
  kind: SwarmNodeKind;
  // agent
  systemPrompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  knowledgeBaseId?: string | null;
  agentId?: string | null;
  // tools — when present, only these tool ids are exposed to this node's LLM call
  enabledTools?: SwarmToolId[];
  // Skill library attachments — sample skill ids (string keys) and/or
  // user-owned agent_skills row ids (uuids). Forwarded to /api/chat which
  // resolves them and prepends a "## Skills available to you" block.
  skillIds?: string[];
  // per-tool configuration (provider+key for web tools, allow-lists for n8n/MCP)
  toolConfigs?: SwarmToolConfigs;
  // per-node guardrails (optional). Server merges over the linked agent's
  // saved guardrails so a node can be stricter than its source agent.
  guardrails?: SwarmGuardrails;
  // Per-node memory configuration. `ltm_scope`:
  //   "agent" — share LTM with the agent's normal sessions (default).
  //   "swarm" — isolate to this swarm run (uses swarm_run_id as conv key).
  //   "none"  — disable LTM for this node.
  memory?: {
    stm_enabled?: boolean;
    stm_window_messages?: number;
    ltm_enabled?: boolean;
    ltm_scope?: "agent" | "swarm" | "none";
  };
  // i/o
  inputs?: string[]; // names of variables this node reads from context
  outputVar?: string; // name of the variable this node writes to context
  // condition
  conditionPrompt?: string; // a question whose YES/NO answer chooses the edge
  // router — N-way intelligent router. The LLM picks one of the outgoing
  // edge labels; matching branch runs, others are skipped via deadEdges.
  routerPrompt?: string;
  // loop
  maxIters?: number;
  // approval
  approvalTitle?: string;
  approvalRisk?: "low" | "medium" | "high";
  approvalTimeoutMs?: number; // 0 or undefined = no timeout
  // a2a_remote — delegates to a remote A2A-compliant agent server
  a2aEndpoint?: string;
  a2aAgentCard?: AgentCard;
  a2aSkillId?: string;
  a2aAuthHeader?: string;
  a2aStreaming?: boolean;
  // function — sandboxed JavaScript transformation of the upstream value.
  // The code receives `ctx` ({ input, vars }) and must `return` a value.
  // Executed in-browser via runSandboxed() with a hard 2s timeout.
  functionCode?: string;
  functionTimeoutMs?: number;
  // evaluate — LLM-as-a-judge scoring node
  evalMetrics?: EvalMetricConfig[];
  evalRubric?: string; // free-form rubric the judge must follow
  evalCustomInstructions?: string; // additional user instructions for the judge
  evalPassThreshold?: number; // 0–1; overall score must meet this to "pass"
  evalReferenceInput?: string; // variable name holding the original question/context
  // visual / runtime
  avatar?: string;
  status?: "idle" | "running" | "done" | "error" | "waiting" | "skipped";
  lastOutput?: string;
  [key: string]: unknown;
};

// Evaluation metric configuration for evaluate nodes.
export type EvalMetricConfig = {
  id: string;
  name: string;
  enabled: boolean;
  weight: number; // 0–1; used to compute weighted overall score
  description: string; // short description of what this metric checks
};

// Canonical eval metrics — mirrors industry-standard RAGAS/DeepEval axes.
export const DEFAULT_EVAL_METRICS: EvalMetricConfig[] = [
  {
    id: "faithfulness",
    name: "Faithfulness",
    enabled: true,
    weight: 0.3,
    description:
      "Are all claims in the answer grounded in the provided context? Catches hallucinations.",
  },
  {
    id: "answer_relevancy",
    name: "Answer Relevancy",
    enabled: true,
    weight: 0.25,
    description: "Does the answer actually address the question asked, or is it tangential?",
  },
  {
    id: "completeness",
    name: "Completeness",
    enabled: true,
    weight: 0.2,
    description:
      "Does the answer cover all parts of the question? Catches partial/truncated answers.",
  },
  {
    id: "coherence",
    name: "Coherence",
    enabled: true,
    weight: 0.15,
    description: "Is the answer logically structured, clear, and easy to follow?",
  },
  {
    id: "harmlessness",
    name: "Harmlessness",
    enabled: false,
    weight: 0.1,
    description: "Is the answer free of harmful, biased, or toxic content?",
  },
];

export type SwarmRunEvent =
  | { type: "node_start"; nodeId: string }
  | { type: "node_token"; nodeId: string; token: string }
  | { type: "node_done"; nodeId: string; output: string }
  | { type: "node_skipped"; nodeId: string; reason?: string }
  | { type: "node_error"; nodeId: string; error: string }
  | { type: "node_warning"; nodeId: string; warning: string }
  | { type: "loop_iteration_start"; nodeId: string; iteration: number; maxIterations: number }
  | {
      type: "loop_iteration_done";
      nodeId: string;
      iteration: number;
      output: string;
      done: boolean;
    }
  | {
      type: "node_usage";
      nodeId: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      model: string;
    }
  | { type: "approval_pending"; nodeId: string; approvalId: string }
  | { type: "run_done"; finalOutput: string }
  | { type: "run_error"; error: string };

export type SwarmRunOptions = {
  initialInput: string;
  onEvent: (e: SwarmRunEvent) => void;
  signal?: AbortSignal;
  tracer?: import("@/utils/observability/tracer").SwarmTracer | null;
};

// Topologically order nodes into LEVELS — each level contains nodes whose
// dependencies are all in previous levels. Nodes within the same level can
// execute in parallel. Cycles (other than explicit `loop` self-edges) raise.
function topoLevels(nodes: Node<SwarmNodeData>[], edges: Edge[]): Node<SwarmNodeData>[][] {
  const incoming = new Map<string, Set<string>>();
  nodes.forEach((n) => incoming.set(n.id, new Set()));
  edges.forEach((e) => {
    if (e.source === e.target) return; // ignore loop self-edges for ordering
    incoming.get(e.target)?.add(e.source);
  });
  const levels: Node<SwarmNodeData>[][] = [];
  const remaining = new Map(nodes.map((n) => [n.id, n]));
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((n) => (incoming.get(n.id)?.size ?? 0) === 0);
    if (ready.length === 0) {
      throw new Error("Swarm has a cycle that isn't a loop self-edge");
    }
    levels.push(ready);
    for (const n of ready) {
      remaining.delete(n.id);
      // remove this node from others' incoming sets
      incoming.forEach((set) => set.delete(n.id));
    }
  }
  return levels;
}

// Substitute {{var}} placeholders in a template with values from the context.
function interpolate(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
    return ctx[name] ?? `{{${name}}}`;
  });
}

function hasDoneSignal(output: string): boolean {
  return output.split(/\r?\n/).some((line) => /^\s*DONE[.!]?\s*$/i.test(line));
}

// Pulls a string output from the upstream context — falls back to the latest
// output if no inputs are declared.
function gatherInputs(
  node: Node<SwarmNodeData>,
  ctx: Record<string, string>,
  fallback: string,
): string {
  const names = node.data.inputs ?? [];
  if (names.length === 0) return fallback;
  // Single input: return the raw value directly (no "key: val" prefix)
  if (names.length === 1) {
    return ctx[names[0]] ?? fallback;
  }
  return names.map((n) => `${n}: ${ctx[n] ?? ""}`).join("\n\n");
}

// Stream a chat completion through /api/chat. Returns the final assistant text
// and emits per-token events via onToken.
//
// `swarmRunId` is used as a synthetic conversation id when the node's memory
// scope is "swarm" — that way STM (rolling summary + scratchpad) persists
// across multiple nodes within a single execution but is isolated from the
// agent's normal chat sessions.
// Default per-node timeout: 240 seconds. Tool-calling agents (SQL, RAG)
// can legitimately need >2 min when the model issues several tool calls
// before finalizing.
const DEFAULT_NODE_TIMEOUT_MS = 240_000;

// Per-node cost is computed from the centralized pricing table so swarms and
// /api/chat always agree. The SSE stream forwards a `cost` event on completion
// which the tracer prefers; this helper is the fallback when no event arrives.
import { estimateTextCost as _estimateTextCost } from "@/utils/observability/pricing";
export function estimateNodeCost(model: string, tokensIn: number, tokensOut: number): number {
  return _estimateTextCost(model, tokensIn, tokensOut);
}

// Prefer the server's human-readable `message` (e.g. the IAM
// "model_not_allowed" explanation) over raw JSON in node error banners.
function extractChatError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    return parsed.message || parsed.error || body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

async function callAgent(
  node: Node<SwarmNodeData>,
  userMessage: string,
  onToken: (t: string) => void,
  signal?: AbortSignal,
  swarmRunId?: string,
  onUsage?: (u: { tokensIn: number; tokensOut: number }) => void,
  onMeta?: (m: {
    toolEvent?: unknown;
    citations?: unknown[];
    memoryUsed?: unknown;
    cost?: { model?: string; costUsd: number; tokensIn: number; tokensOut: number };
  }) => void,
  onThinking?: (t: string) => void,
): Promise<string> {
  // Combine user-level abort signal with a per-node timeout so hung calls
  // don't block the swarm forever.
  const timeoutSignal = AbortSignal.timeout(DEFAULT_NODE_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  // Resolve memory wiring for this node:
  //   - "agent" (default): no override; chat.ts uses the agent's saved config.
  //   - "swarm": isolate to this run — pass swarm_run_id as conversation key,
  //              and force ltm_scope so chat.ts still records LTM under the
  //              agent (caller can disable per-node).
  //   - "none":  ltm off entirely for this node.
  const mem = node.data.memory;
  const ltmScope = mem?.ltm_scope ?? "agent";
  const memoryOverrides:
    | {
        stm_enabled?: boolean;
        stm_window_messages?: number;
        ltm_enabled?: boolean;
        ltm_scope?: "agent" | "swarm" | "none";
      }
    | undefined = mem
    ? {
        ...(typeof mem.stm_enabled === "boolean" ? { stm_enabled: mem.stm_enabled } : {}),
        ...(typeof mem.stm_window_messages === "number"
          ? { stm_window_messages: mem.stm_window_messages }
          : {}),
        ...(typeof mem.ltm_enabled === "boolean" ? { ltm_enabled: mem.ltm_enabled } : {}),
        ltm_scope: ltmScope,
      }
    : undefined;
  // Use swarm run id as conversation key only when the user opted into a
  // swarm-scoped memory; otherwise leave undefined so the chat route
  // creates an ephemeral context just for this single call.
  const conversationId = ltmScope === "swarm" && swarmRunId ? swarmRunId : undefined;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const provider = node.data.provider || "openrouter";
  const model = node.data.model || "google/gemini-3-flash-preview";

  // Forward upstream-generated images as proper image_url parts to ANY model
  // that can consume them — not just image-gen models. Gemini Pro / Flash and
  // other vision-capable text models need the image as a real attachment to
  // actually "see" it. Sending a multi-hundred-KB base64 string as text both
  // blows past token limits (which is why the Brand Vision Reviewer in the
  // Ad Campaign swarm was returning empty output) and prevents true vision
  // analysis. We strip the image URL out of the prompt text and re-attach it
  // as a structured part.
  let messagesPayload: Array<{
    role: "user";
    content:
      | string
      | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  }>;
  const { cleaned: textWithoutImages, images: upstreamImages } = extractAllImageUrls(userMessage);
  if (upstreamImages.length > 0) {
    const parts: Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    > = [];
    if (textWithoutImages) parts.push({ type: "text", text: textWithoutImages });
    for (const url of upstreamImages) parts.push({ type: "image_url", image_url: { url } });
    // Ensure at least one text part so image-gen models receive a prompt even
    // when the upstream message was image-only.
    if (parts.length === upstreamImages.length) {
      parts.unshift({
        type: "text",
        text: isImageModelId(model)
          ? "Edit / regenerate based on the attached image(s)."
          : "Analyze the attached image(s) in the context above.",
      });
    }
    messagesPayload = [{ role: "user", content: parts }];
  } else {
    messagesPayload = [{ role: "user", content: userMessage }];
  }

  let resp = await fetch("/api/chat", {
    method: "POST",
    signal: combinedSignal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      provider,
      model,
      systemPrompt: node.data.systemPrompt || "",
      temperature: typeof node.data.temperature === "number" ? node.data.temperature : 0.4,
      maxTokens: 8192,
      messages: messagesPayload,
      agentId: node.data.agentId || undefined,
      // Per-node KB id (e.g. swarm template referencing a shared sample KB
      // without a saved agent). Server merges with whatever the agent itself
      // has configured.
      knowledgeBaseIds: node.data.knowledgeBaseId ? [node.data.knowledgeBaseId] : undefined,
      // Per-node tool allow-list. Undefined → server returns the user's full
      // configured toolset; an empty array → tools disabled for this node.
      enabledTools: Array.isArray(node.data.enabledTools) ? node.data.enabledTools : undefined,
      // Per-node skill library attachments — server resolves and prepends.
      skillIds:
        Array.isArray(node.data.skillIds) && node.data.skillIds.length > 0
          ? node.data.skillIds
          : undefined,
      // Per-node tool configuration (provider+key for web tools, allow-lists
      // for n8n/MCP). Server merges this over the agent's saved configs.
      toolConfigs:
        node.data.toolConfigs && typeof node.data.toolConfigs === "object"
          ? node.data.toolConfigs
          : undefined,
      // Per-node guardrails — merged OVER the linked agent's saved guardrails.
      // Sent only when the user actually configured something for this node.
      guardrails:
        node.data.guardrails &&
        typeof node.data.guardrails === "object" &&
        Object.keys(node.data.guardrails).length > 0
          ? node.data.guardrails
          : undefined,
      // Memory wiring — see comment at top of callAgent for semantics.
      conversationId,
      memoryOverrides,
    }),
  });

  // Retry once on transient 5xx / 502 gateway errors before giving up.
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => "");
    const is5xx = resp.status >= 500 && resp.status < 600;
    if (is5xx) {
      await new Promise((r) => setTimeout(r, 2000));
      const retry = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          provider,
          model,
          systemPrompt: node.data.systemPrompt || "",
          temperature: typeof node.data.temperature === "number" ? node.data.temperature : 0.4,
          maxTokens: 8192,
          messages: messagesPayload,
          agentId: node.data.agentId || undefined,
          knowledgeBaseIds: node.data.knowledgeBaseId ? [node.data.knowledgeBaseId] : undefined,
          enabledTools: Array.isArray(node.data.enabledTools) ? node.data.enabledTools : undefined,
          skillIds:
            Array.isArray(node.data.skillIds) && node.data.skillIds.length > 0
              ? node.data.skillIds
              : undefined,
          toolConfigs:
            node.data.toolConfigs && typeof node.data.toolConfigs === "object"
              ? node.data.toolConfigs
              : undefined,
          guardrails:
            node.data.guardrails &&
            typeof node.data.guardrails === "object" &&
            Object.keys(node.data.guardrails).length > 0
              ? node.data.guardrails
              : undefined,
          conversationId,
          memoryOverrides,
        }),
        signal: combinedSignal,
      });
      if (retry.ok && retry.body) {
        resp = retry;
      } else {
        const retryTxt = await retry.text().catch(() => "");
        throw new Error(
          `Agent call failed after retry [${retry.status}]: ${extractChatError(retryTxt)}`,
        );
      }
    } else {
      throw new Error(`Agent call failed [${resp.status}]: ${extractChatError(txt)}`);
    }
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let currentEvent = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        currentEvent = "message";
        continue;
      }
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (currentEvent === "tool" && onMeta) {
          onMeta({ toolEvent: parsed });
          continue;
        }
        if (currentEvent === "citations" && onMeta) {
          onMeta({ citations: (parsed as { citations?: unknown[] }).citations ?? [] });
          continue;
        }
        if (currentEvent === "memory_used" && onMeta) {
          onMeta({ memoryUsed: parsed });
          continue;
        }
        if (currentEvent === "cost" && onMeta) {
          const c = parsed as {
            model?: string;
            costUsd?: number;
            tokensIn?: number;
            tokensOut?: number;
          };
          onMeta({
            cost: {
              model: c.model,
              costUsd: c.costUsd ?? 0,
              tokensIn: c.tokensIn ?? 0,
              tokensOut: c.tokensOut ?? 0,
            },
          });
          continue;
        }
        const p = parsed as {
          choices?: {
            delta?: {
              content?: string;
              reasoning?: string;
              reasoning_content?: string;
              thinking?: string;
            };
            message?: { content?: string; reasoning?: string; reasoning_content?: string };
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
          };
        };
        const delta = p.choices?.[0]?.delta?.content ?? p.choices?.[0]?.message?.content ?? "";
        if (typeof delta === "string" && delta) {
          assistantText += delta;
          onToken(delta);
        }
        const reasoning =
          p.choices?.[0]?.delta?.reasoning ??
          p.choices?.[0]?.delta?.reasoning_content ??
          p.choices?.[0]?.delta?.thinking ??
          p.choices?.[0]?.message?.reasoning ??
          p.choices?.[0]?.message?.reasoning_content ??
          "";
        if (typeof reasoning === "string" && reasoning && onThinking) {
          onThinking(reasoning);
        }
        if (p.usage && onUsage) {
          const tokensIn = p.usage.prompt_tokens ?? p.usage.input_tokens ?? 0;
          const tokensOut = p.usage.completion_tokens ?? p.usage.output_tokens ?? 0;
          if (tokensIn || tokensOut) onUsage({ tokensIn, tokensOut });
        }
      } catch {
        /* keep-alives */
      }
    }
  }
  return assistantText.trim();
}

// Wait until an approval row transitions out of "pending" (poll every 2s).
// If timeoutMs is set and >0, rejects with a timeout error after that duration.
async function waitForApproval(
  approvalId: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<"approved" | "rejected"> {
  const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : null;
  for (;;) {
    if (signal?.aborted) throw new Error("Run aborted");
    if (deadline !== null && Date.now() >= deadline) {
      throw new Error(
        `Approval timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s — no response received.`,
      );
    }
    const { data } = await supabase
      .from("approvals")
      .select("status")
      .eq("id", approvalId)
      .maybeSingle();
    if (data?.status === "approved") return "approved";
    if (data?.status === "rejected") return "rejected";
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function runSwarm(
  nodes: Node<SwarmNodeData>[],
  edges: Edge[],
  opts: SwarmRunOptions,
): Promise<void> {
  const { initialInput, onEvent: rawOnEvent, signal, tracer } = opts;
  // Stable id for the entire run — used as a synthetic conversation key for
  // any node that opts into "swarm-scoped" memory so STM/scratchpad persists
  // across nodes within this single execution.
  const swarmRunId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `swarm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Wrap onEvent so tracer (if any) sees every node lifecycle event.
  // Uses node_start to open a step and node_done/node_error to close it.
  const stepInputByNode = new Map<string, string>();
  const nodeById = new Map<string, Node<SwarmNodeData>>();
  const usageByNode = new Map<string, { tokensIn: number; tokensOut: number }>();
  const toolCallsByNode = new Map<string, unknown[]>();
  const ragChunksByNode = new Map<string, unknown[]>();
  const memoryUsedByNode = new Map<string, unknown[]>();
  const thinkingByNode = new Map<string, string>();
  const costByNode = new Map<
    string,
    { model?: string; costUsd: number; tokensIn: number; tokensOut: number }
  >();
  const onEvent: (e: SwarmRunEvent) => void = (e) => {
    try {
      if (tracer) {
        if (e.type === "node_start") {
          const n = nodeById.get(e.nodeId);
          tracer.startStep({
            nodeId: e.nodeId,
            nodeLabel: n?.data.label,
            nodeKind: n?.data.kind,
            agentId: (n?.data as { agentId?: string } | undefined)?.agentId ?? null,
            input: { prompt: stepInputByNode.get(e.nodeId) ?? null },
          });
        } else if (e.type === "node_done") {
          const n = nodeById.get(e.nodeId);
          const u = usageByNode.get(e.nodeId);
          const serverCost = costByNode.get(e.nodeId);
          const model =
            serverCost?.model || (n?.data as { model?: string } | undefined)?.model || "";
          const tokensIn = u?.tokensIn ?? 0;
          const tokensOut = u?.tokensOut ?? 0;
          tracer.finishStep(e.nodeId, {
            status: "success",
            output: e.output,
            thinking: thinkingByNode.get(e.nodeId) || null,
            llmProvider: (n?.data as { provider?: string } | undefined)?.provider,
            llmModel: model,
            tokensIn,
            tokensOut,
            costUsd: serverCost?.costUsd ?? estimateNodeCost(model, tokensIn, tokensOut),
            toolCalls: toolCallsByNode.get(e.nodeId) ?? [],
            ragChunks: ragChunksByNode.get(e.nodeId) ?? [],
            memoryUsed: memoryUsedByNode.get(e.nodeId) ?? [],
          });
        } else if (e.type === "node_error") {
          tracer.finishStep(e.nodeId, {
            status: "error",
            errorMessage: e.error,
            thinking: thinkingByNode.get(e.nodeId) || null,
            toolCalls: toolCallsByNode.get(e.nodeId) ?? [],
            ragChunks: ragChunksByNode.get(e.nodeId) ?? [],
            memoryUsed: memoryUsedByNode.get(e.nodeId) ?? [],
          });
        } else if (e.type === "approval_pending") {
          tracer.finishStep(e.nodeId, { status: "awaiting_approval" });
        }
      }
    } catch {
      /* tracer never breaks the run */
    }
    rawOnEvent(e);
    // After a node completes, surface its token/cost usage as a discrete event
    // so the UI can show a live meter. The tracer above already consumed this
    // same data; here we forward it straight to the UI (not back through the
    // tracer) once per finished node.
    if (e.type === "node_done") {
      const u = usageByNode.get(e.nodeId);
      const serverCost = costByNode.get(e.nodeId);
      const tokensIn = serverCost?.tokensIn ?? u?.tokensIn ?? 0;
      const tokensOut = serverCost?.tokensOut ?? u?.tokensOut ?? 0;
      if (tokensIn || tokensOut) {
        const n = nodeById.get(e.nodeId);
        const model = serverCost?.model || (n?.data as { model?: string } | undefined)?.model || "";
        rawOnEvent({
          type: "node_usage",
          nodeId: e.nodeId,
          tokensIn,
          tokensOut,
          costUsd: serverCost?.costUsd ?? estimateNodeCost(model, tokensIn, tokensOut),
          model,
        });
      }
    }
  };
  const captureUsage = (nodeId: string) => (u: { tokensIn: number; tokensOut: number }) => {
    const prev = usageByNode.get(nodeId) ?? { tokensIn: 0, tokensOut: 0 };
    usageByNode.set(nodeId, {
      tokensIn: prev.tokensIn + u.tokensIn,
      tokensOut: prev.tokensOut + u.tokensOut,
    });
  };
  const captureThinking = (nodeId: string) => (t: string) => {
    const prev = thinkingByNode.get(nodeId) ?? "";
    thinkingByNode.set(nodeId, prev + t);
  };
  const captureMeta =
    (nodeId: string) =>
    (m: {
      toolEvent?: unknown;
      citations?: unknown[];
      memoryUsed?: unknown;
      cost?: { model?: string; costUsd: number; tokensIn: number; tokensOut: number };
    }) => {
      if (m.toolEvent) {
        const arr = toolCallsByNode.get(nodeId) ?? [];
        arr.push(m.toolEvent);
        toolCallsByNode.set(nodeId, arr);
      }
      if (m.citations && Array.isArray(m.citations)) {
        const arr = ragChunksByNode.get(nodeId) ?? [];
        ragChunksByNode.set(nodeId, arr.concat(m.citations));
      }
      if (m.memoryUsed) {
        const arr = memoryUsedByNode.get(nodeId) ?? [];
        arr.push(m.memoryUsed);
        memoryUsedByNode.set(nodeId, arr);
      }
      if (m.cost) {
        const prev = costByNode.get(nodeId);
        const next = prev
          ? {
              model: m.cost.model || prev.model,
              costUsd: prev.costUsd + m.cost.costUsd,
              tokensIn: prev.tokensIn + m.cost.tokensIn,
              tokensOut: prev.tokensOut + m.cost.tokensOut,
            }
          : m.cost;
        costByNode.set(nodeId, next);
        // Server's token counts are authoritative; reflect them in usage too
        // so timeline metrics match the cost.
        if (next.tokensIn || next.tokensOut) {
          usageByNode.set(nodeId, { tokensIn: next.tokensIn, tokensOut: next.tokensOut });
        }
      }
    };
  try {
    const levels = topoLevels(nodes, edges);
    const ctx: Record<string, string> = { input: initialInput };
    let lastOutput = initialInput;
    nodes.forEach((n) => nodeById.set(n.id, n));

    // Track nodes that should be skipped because a condition routed away
    const skippedNodes = new Set<string>();

    const outgoingEdges = new Map<string, Edge[]>();
    edges.forEach((e) => {
      const arr = outgoingEdges.get(e.source) || [];
      arr.push(e);
      outgoingEdges.set(e.source, arr);
    });
    const incomingEdges = new Map<string, Edge[]>();
    edges.forEach((e) => {
      const arr = incomingEdges.get(e.target) || [];
      arr.push(e);
      incomingEdges.set(e.target, arr);
    });

    const deadEdges = new Set<string>();

    function propagateSkip(deadTargets: string[]) {
      const queue = [...deadTargets];
      while (queue.length > 0) {
        const nid = queue.shift()!;
        const inc = incomingEdges.get(nid) || [];
        const allIncomingDead = inc.every(
          (e: Edge) => skippedNodes.has(e.source) || deadEdges.has(e.id),
        );
        if (allIncomingDead) {
          skippedNodes.add(nid);
          const out = outgoingEdges.get(nid) || [];
          for (const e of out) {
            if (!skippedNodes.has(e.target)) queue.push(e.target);
          }
        }
      }
    }

    // Process each topological level. Within a level, nodes are independent
    // of each other (all dependencies are in prior levels), so we can
    // execute them in parallel with Promise.all for a significant speedup
    // on fan-out patterns (e.g. 4 parallel analysts → 1 synthesizer).
    for (const level of levels) {
      if (signal?.aborted) throw new Error("Run aborted");

      // Helper to execute a single node — extracted so we can call it from
      // both sequential and parallel paths.
      const executeNode = async (node: Node<SwarmNodeData>) => {
        if (signal?.aborted) throw new Error("Run aborted");

        if (skippedNodes.has(node.id)) {
          if (tracer)
            tracer.startStep({
              nodeId: node.id,
              nodeLabel: node.data.label,
              nodeKind: node.data.kind,
            });
          if (tracer) tracer.finishStep(node.id, { status: "skipped" });
          onEvent({
            type: "node_skipped",
            nodeId: node.id,
            reason: "condition routed away",
          });
          return;
        }

        // Capture resolved input + record incoming edges for the trace canvas.
        const resolvedInput =
          node.data.kind === "input" ? initialInput : gatherInputs(node, ctx, lastOutput);
        stepInputByNode.set(node.id, resolvedInput);
        if (tracer) {
          const incoming = incomingEdges.get(node.id) || [];
          for (const e of incoming) {
            if (skippedNodes.has(e.source) || deadEdges.has(e.id)) continue;
            const upstreamVar = `out_${e.source}`;
            const payload = ctx[upstreamVar] ?? "";
            tracer.recordEdge({
              sourceNodeId: e.source,
              targetNodeId: e.target,
              payloadPreview: typeof payload === "string" ? payload.slice(0, 500) : "",
              bytes: typeof payload === "string" ? payload.length : 0,
            });
          }
        }

        onEvent({ type: "node_start", nodeId: node.id });

        if (node.data.kind === "input") {
          const v = node.data.outputVar || "input";
          ctx[v] = initialInput;
          lastOutput = initialInput;
          onEvent({ type: "node_done", nodeId: node.id, output: initialInput });
          return;
        }

        if (node.data.kind === "output") {
          const finalText = gatherInputs(node, ctx, lastOutput);
          const v = node.data.outputVar || `out_${node.id}`;
          ctx[v] = finalText;
          lastOutput = finalText;
          onEvent({ type: "node_done", nodeId: node.id, output: finalText });
          return;
        }

        if (node.data.kind === "approval") {
          const { data: userData } = await supabase.auth.getUser();
          if (!userData.user) throw new Error("Not signed in");
          const approvalContent = gatherInputs(node, ctx, lastOutput);
          const { data: created, error } = await supabase
            .from("approvals")
            .insert({
              user_id: userData.user.id,
              agent_name: node.data.label || "Approval gate",
              agent_avatar: node.data.avatar || "🛡️",
              action_type: "swarm_step",
              action_title: node.data.approvalTitle || `Approve step: ${node.data.label}`,
              description: approvalContent.slice(0, 1000),
              risk_level: node.data.approvalRisk || "medium",
              payload: { last_output: approvalContent.slice(0, 4000) },
            })
            .select("id")
            .single();
          if (error || !created) throw new Error(error?.message || "Could not create approval");
          onEvent({ type: "approval_pending", nodeId: node.id, approvalId: created.id });
          const decision = await waitForApproval(created.id, signal, node.data.approvalTimeoutMs);
          if (decision === "rejected") {
            throw new Error("Approval rejected");
          }
          const v = node.data.outputVar || `out_${node.id}`;
          ctx[v] = approvalContent;
          lastOutput = approvalContent;
          onEvent({ type: "node_done", nodeId: node.id, output: approvalContent });
          return;
        }

        if (node.data.kind === "condition") {
          const judgeInput = gatherInputs(node, ctx, lastOutput);
          const prompt =
            (node.data.conditionPrompt || "Should we proceed?") +
            `\n\nINPUT:\n${judgeInput}\n\nAnswer with a single word: YES or NO.`;
          const judgement = await callAgent(
            {
              ...node,
              data: {
                ...node.data,
                systemPrompt: "You are a strict binary classifier. Reply only YES or NO.",
              },
            },
            prompt,
            (tok) => onEvent({ type: "node_token", nodeId: node.id, token: tok }),
            signal,
            swarmRunId,
            captureUsage(node.id),
            captureMeta(node.id),
            captureThinking(node.id),
          );
          const decision = /yes/i.test(judgement) ? "YES" : "NO";
          const v = node.data.outputVar || `cond_${node.id}`;
          ctx[v] = decision;
          lastOutput = decision;
          onEvent({ type: "node_done", nodeId: node.id, output: decision });

          const condOutEdges = outgoingEdges.get(node.id) || [];
          const unlabeled = condOutEdges.filter((e) => !e.label);
          if (unlabeled.length > 0) {
            onEvent({
              type: "node_warning",
              nodeId: node.id,
              warning: `${unlabeled.length} outgoing edge${unlabeled.length > 1 ? "s are" : " is"} missing a YES/NO label and will never be followed. Open the edge inspector and add a label.`,
            });
          }
          const deadTargets: string[] = [];
          for (const e of condOutEdges) {
            if (!e.label) continue;
            const edgeLabel = String(e.label).toLowerCase().trim();
            const isLive =
              (decision === "YES" && edgeLabel === "yes") ||
              (decision === "NO" && edgeLabel === "no");
            if (!isLive) {
              deadEdges.add(e.id);
              deadTargets.push(e.target);
            }
          }
          if (deadTargets.length > 0) {
            propagateSkip(deadTargets);
          }
          return;
        }

        if (node.data.kind === "router") {
          const routerInput = gatherInputs(node, ctx, lastOutput);
          const routerOutEdges = outgoingEdges.get(node.id) || [];
          // Build the list of choices from the outgoing edge labels.
          // Unlabeled edges are not valid routes — surface a warning.
          const labeled = routerOutEdges.filter(
            (e) => typeof e.label === "string" && e.label.trim().length > 0,
          );
          const unlabeled = routerOutEdges.length - labeled.length;
          const choices = Array.from(new Set(labeled.map((e) => String(e.label).trim())));
          if (unlabeled > 0) {
            onEvent({
              type: "node_warning",
              nodeId: node.id,
              warning: `${unlabeled} outgoing edge${unlabeled > 1 ? "s are" : " is"} missing a route label and will never be followed. Label each edge with a route name (e.g. math, writer, code).`,
            });
          }
          if (choices.length === 0) {
            throw new Error(
              "Router node has no labeled outgoing edges. Add at least one outgoing edge with a label.",
            );
          }
          const routeList = choices.map((c) => `- ${c}`).join("\n");
          const prompt =
            (node.data.routerPrompt || "Pick the single best route for the user's request.") +
            `\n\nINPUT:\n${routerInput}\n\nAvailable routes:\n${routeList}\n\nReply with ONLY one route name from the list above. No prose, no punctuation.`;
          const judgement = await callAgent(
            {
              ...node,
              data: {
                ...node.data,
                systemPrompt:
                  "You are a strict routing classifier. Reply with exactly one route name from the provided list — no other text.",
              },
            },
            prompt,
            (tok) => onEvent({ type: "node_token", nodeId: node.id, token: tok }),
            signal,
            swarmRunId,
            captureUsage(node.id),
            captureMeta(node.id),
            captureThinking(node.id),
          );
          // Resolve the LLM reply to a known choice — exact match first,
          // then case-insensitive, then "contains" fallback. If nothing
          // matches, default to the first choice and emit a warning.
          const raw = String(judgement).trim();
          const lower = raw.toLowerCase();
          let picked = choices.find((c) => c === raw);
          if (!picked) picked = choices.find((c) => c.toLowerCase() === lower);
          if (!picked) picked = choices.find((c) => lower.includes(c.toLowerCase()));
          if (!picked) {
            onEvent({
              type: "node_warning",
              nodeId: node.id,
              warning: `Router reply "${raw.slice(0, 60)}" didn't match any route; defaulting to "${choices[0]}".`,
            });
            picked = choices[0];
          }
          const v = node.data.outputVar || `route_${node.id}`;
          ctx[v] = picked;
          lastOutput = picked;
          onEvent({ type: "node_done", nodeId: node.id, output: picked });

          const deadTargets: string[] = [];
          for (const e of routerOutEdges) {
            const edgeLabel = typeof e.label === "string" ? e.label.trim() : "";
            const isLive = !!edgeLabel && edgeLabel.toLowerCase() === picked.toLowerCase();
            if (!isLive) {
              deadEdges.add(e.id);
              deadTargets.push(e.target);
            }
          }
          if (deadTargets.length > 0) {
            propagateSkip(deadTargets);
          }
          return;
        }

        if (node.data.kind === "loop") {
          const max = Math.max(1, Math.min(node.data.maxIters ?? 3, 6));
          const loopInput = gatherInputs(node, ctx, lastOutput);
          const loopPrompt = interpolate(node.data.systemPrompt || "{{input}}", {
            ...ctx,
            input: loopInput,
          });
          let result = "";
          for (let i = 0; i < max; i++) {
            onEvent({
              type: "loop_iteration_start",
              nodeId: node.id,
              iteration: i + 1,
              maxIterations: max,
            });
            const composed = `${loopPrompt}\n\nOriginal input:\n${loopInput}\n\nPrevious attempt:\n${result || "(none)"}`;
            result = await callAgent(
              node,
              composed,
              (tok) => onEvent({ type: "node_token", nodeId: node.id, token: tok }),
              signal,
              swarmRunId,
              captureUsage(node.id),
              captureMeta(node.id),
              captureThinking(node.id),
            );
            const done = hasDoneSignal(result);
            onEvent({
              type: "loop_iteration_done",
              nodeId: node.id,
              iteration: i + 1,
              output: result,
              done,
            });
            if (done) break;
          }
          const v = node.data.outputVar || `out_${node.id}`;
          ctx[v] = result;
          lastOutput = result;
          onEvent({ type: "node_done", nodeId: node.id, output: result });
          return;
        }

        if (node.data.kind === "a2a_remote") {
          const endpoint = (node.data.a2aEndpoint || "").trim();
          if (!endpoint) {
            throw new Error(
              "A2A node missing endpoint URL — open the inspector and click Discover.",
            );
          }
          const userText = gatherInputs(node, ctx, lastOutput);
          const { data: sessionData } = await supabase.auth.getSession();
          const authToken = sessionData.session?.access_token;
          const wantsStream =
            !!node.data.a2aStreaming && !!node.data.a2aAgentCard?.capabilities?.streaming;
          const result = await invokeAgent({
            endpoint,
            message: buildUserMessage(userText),
            skillId: node.data.a2aSkillId,
            remoteAuthHeader: node.data.a2aAuthHeader,
            stream: wantsStream,
            authToken,
            signal,
            onToken: (chunk) => onEvent({ type: "node_token", nodeId: node.id, token: chunk }),
          });
          if (!result.ok) {
            throw new Error(result.error || "Remote A2A agent invocation failed");
          }
          const out = (result.text || "").trim();
          const v = node.data.outputVar || `out_${node.id}`;
          ctx[v] = out;
          lastOutput = out;
          onEvent({ type: "node_done", nodeId: node.id, output: out });
          return;
        }

        if (node.data.kind === "function") {
          const inputValue = gatherInputs(node, ctx, lastOutput);
          const code = (node.data.functionCode || "return ctx.input;").trim();
          const timeoutMs = Math.max(100, Math.min(node.data.functionTimeoutMs ?? 2000, 5000));
          const result = await runSandboxed(
            code,
            { input: inputValue, vars: { ...ctx } },
            timeoutMs,
          );
          if (!result.ok) {
            throw new Error(`Function node error: ${result.error}`);
          }
          const outStr = safeStringify(result.value);
          if (outStr) {
            onEvent({ type: "node_token", nodeId: node.id, token: outStr });
          }
          const v = node.data.outputVar || `out_${node.id}`;
          ctx[v] = outStr;
          lastOutput = outStr;
          onEvent({ type: "node_done", nodeId: node.id, output: outStr });
          return;
        }

        if (node.data.kind === "evaluate") {
          const inputText = gatherInputs(node, ctx, lastOutput);
          const metrics = (node.data.evalMetrics ?? []).filter((m) => m.enabled);
          if (metrics.length === 0) {
            throw new Error(
              "Evaluate node has no enabled metrics — open the inspector and enable at least one.",
            );
          }
          const metricsBlock = metrics
            .map((m) => `- **${m.name}** (id: "${m.id}", weight: ${m.weight}): ${m.description}`)
            .join("\n");
          const referenceVar = node.data.evalReferenceInput?.trim();
          const referenceContext =
            referenceVar && ctx[referenceVar]
              ? `\n\n## Reference / Original Question\n${ctx[referenceVar]}`
              : "";
          const rubric = node.data.evalRubric?.trim()
            ? `\n\n## Evaluation Rubric\n${node.data.evalRubric}`
            : "";
          const custom = node.data.evalCustomInstructions?.trim()
            ? `\n\n## Additional Instructions\n${node.data.evalCustomInstructions}`
            : "";
          const threshold =
            typeof node.data.evalPassThreshold === "number" ? node.data.evalPassThreshold : 0.7;

          const evalSystemPrompt = `You are a strict, impartial LLM evaluation judge. Your job is to score the CANDIDATE OUTPUT against the provided metrics using a 0.0–1.0 scale.

## Metrics to evaluate
${metricsBlock}
${rubric}${custom}

## Output format
You MUST return a valid JSON object with this exact structure — no markdown fences, no extra text:
{
  "metrics": {
${metrics.map((m) => `    "${m.id}": { "score": <0.0-1.0>, "reason": "<1-2 sentence justification>" }`).join(",\n")}
  },
  "overall_score": <weighted average of above scores>,
  "pass": <true if overall_score >= ${threshold}>,
  "summary": "<2-3 sentence overall assessment>"
}

Be precise. Ground every score in specific evidence from the candidate output. A score of 1.0 means perfect; 0.0 means complete failure on that axis.`;

          const evalUserMessage = `## Candidate Output to Evaluate
${inputText}${referenceContext}

Evaluate the candidate output above against each metric and return the JSON scorecard.`;

          const evalNode: Node<SwarmNodeData> = {
            ...node,
            data: {
              ...node.data,
              systemPrompt: evalSystemPrompt,
              provider: node.data.provider || "openrouter",
              model: node.data.model || "openai/gpt-5",
              temperature: typeof node.data.temperature === "number" ? node.data.temperature : 0.1,
            },
          };

          const result = await callAgent(
            evalNode,
            evalUserMessage,
            (tok) => onEvent({ type: "node_token", nodeId: node.id, token: tok }),
            signal,
            swarmRunId,
            captureUsage(node.id),
            captureMeta(node.id),
            captureThinking(node.id),
          );

          let cleanResult = result;
          const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch) cleanResult = jsonMatch[1].trim();
          try {
            JSON.parse(cleanResult);
          } catch {
            cleanResult = result;
          }

          const v = node.data.outputVar || `eval_${node.id}`;
          ctx[v] = cleanResult;
          lastOutput = cleanResult;
          onEvent({ type: "node_done", nodeId: node.id, output: cleanResult });
          return;
        }

        // Default: agent node
        const userMsg = node.data.systemPrompt
          ? interpolate(`{{__user__}}`, { ...ctx, __user__: gatherInputs(node, ctx, lastOutput) })
          : gatherInputs(node, ctx, lastOutput);
        const out = await callAgent(
          node,
          userMsg,
          (tok) => onEvent({ type: "node_token", nodeId: node.id, token: tok }),
          signal,
          swarmRunId,
          captureUsage(node.id),
          captureMeta(node.id),
          captureThinking(node.id),
        );
        const v = node.data.outputVar || `out_${node.id}`;
        ctx[v] = out;
        lastOutput = out;
        onEvent({ type: "node_done", nodeId: node.id, output: out });
      }; // end executeNode

      // Condition/router nodes modify skippedNodes/deadEdges which affect later nodes
      // in the same level, so they must run sequentially. For levels with only
      // agent/function/a2a/eval nodes, run in parallel.
      const hasCondition = level.some(
        (n) => n.data.kind === "condition" || n.data.kind === "router",
      );
      const hasApproval = level.some((n) => n.data.kind === "approval");

      if (hasCondition || hasApproval || level.length === 1) {
        // Sequential: conditions/approvals need ordered side-effects
        for (const node of level) {
          try {
            await executeNode(node);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            onEvent({ type: "node_error", nodeId: node.id, error: msg });
            throw err;
          }
        }
      } else {
        // Parallel: all nodes in this level are independent
        const results = await Promise.allSettled(
          level.map(async (node) => {
            try {
              await executeNode(node);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              onEvent({ type: "node_error", nodeId: node.id, error: msg });
              throw err;
            }
          }),
        );
        const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        if (failures.length === 1) {
          throw failures[0].reason;
        } else if (failures.length > 1) {
          const messages = failures.map(
            (f, i) =>
              `[${i + 1}] ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`,
          );
          throw new Error(`${failures.length} parallel nodes failed:\n${messages.join("\n")}`);
        }
      }

      // After the level completes, update lastOutput to the latest ctx value
      // from this level (for the next level's fallback). Pick the last node
      // in the level that wrote to ctx.
      for (const node of level) {
        const v = node.data.outputVar || `out_${node.id}`;
        if (ctx[v] !== undefined && !skippedNodes.has(node.id)) {
          lastOutput = ctx[v];
        }
      }
    }

    onEvent({ type: "run_done", finalOutput: lastOutput });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onEvent({ type: "run_error", error: msg });
  }
}
