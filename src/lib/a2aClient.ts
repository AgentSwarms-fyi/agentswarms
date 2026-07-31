// Real client for the A2A (Agent-to-Agent) protocol.
// Spec: https://a2a-protocol.org — JSON-RPC 2.0 over HTTP(S) with optional SSE.
//
// This is wire-compatible with any A2A-compliant server (Google ADK, LangGraph
// A2A wrappers, CrewAI A2A, custom implementations). It implements the methods
// AgentSwarms actually uses:
//   - Agent Card discovery (GET /.well-known/agent-card.json)
//   - message/send  (synchronous JSON-RPC call, returns final Task)
//   - message/stream (SSE stream of TaskStatusUpdate / TaskArtifactUpdate)
//
// All actual network I/O goes through the /api/a2a server proxy because:
//   1) Browsers can't reliably hit arbitrary 3rd-party A2A servers (CORS).
//   2) We want SSRF protection for invoke calls.
//   3) Auth headers should be forwarded server-side, not from JS.
//
// This file contains pure types + small fetch wrappers around our proxy.

// ───────────────────── Types from the A2A spec ─────────────────────

/** Skill advertised by an agent. Cards usually list 1+ skills. */
export interface AgentSkill {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** Capability flags an agent declares. */
export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

/** The Agent Card published at /.well-known/agent-card.json. */
export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  protocolVersion?: string;
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  provider?: { organization?: string; url?: string };
}

/** A message Part — text/file/data. We use text only for swarm chaining. */
export type Part =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | { kind: "file"; file: { name?: string; mimeType?: string; uri?: string; bytes?: string } }
  | { kind: "data"; data: Record<string, unknown> };

export interface A2AMessage {
  role: "user" | "agent";
  parts: Part[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  kind?: "message";
}

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: A2AMessage[];
  kind?: "task";
}

// SSE event shapes
export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  final?: boolean;
  kind: "status-update";
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  kind: "artifact-update";
}

// ───────────────────── Helpers ─────────────────────

/** Concatenate text parts into a single string. */
export function partsToText(parts: Part[] | undefined): string {
  if (!parts) return "";
  return parts
    .map((p) => (p.kind === "text" ? p.text : p.kind === "data" ? JSON.stringify(p.data) : ""))
    .filter(Boolean)
    .join("\n");
}

/** Extract the agent's final answer text from a Task. */
export function taskToText(task: Task): string {
  // Prefer artifacts (the canonical "outputs"); fall back to the status message.
  const fromArtifacts = (task.artifacts ?? [])
    .map((a) => partsToText(a.parts))
    .filter(Boolean)
    .join("\n\n");
  if (fromArtifacts) return fromArtifacts;
  if (task.status?.message) return partsToText(task.status.message.parts);
  return "";
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a user → agent text message from an arbitrary string. */
export function buildUserMessage(text: string, contextId?: string): A2AMessage {
  return {
    role: "user",
    parts: [{ kind: "text", text }],
    messageId: newId("msg"),
    contextId,
    kind: "message",
  };
}

// ───────────────────── Calls (through our /api/a2a proxy) ─────────────────────

export interface DiscoverResult {
  ok: boolean;
  card?: AgentCard;
  error?: string;
}

/**
 * Fetches the Agent Card via our server-side proxy. Always goes through
 * /api/a2a?action=discover — the proxy applies SSRF protection and CORS.
 */
export async function fetchAgentCard(opts: {
  endpoint: string;
  authToken?: string; // user's Supabase access token
}): Promise<DiscoverResult> {
  try {
    const r = await fetch("/api/a2a?action=discover", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}),
      },
      body: JSON.stringify({ endpoint: opts.endpoint }),
    });
    const j = (await r.json().catch(() => ({}))) as { card?: AgentCard; error?: string };
    if (!r.ok) return { ok: false, error: j.error || `Discovery failed (${r.status})` };
    if (!j.card) return { ok: false, error: "Proxy returned no agent card" };
    return { ok: true, card: j.card };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface InvokeOptions {
  endpoint: string;
  message: A2AMessage;
  /** Forward this header value as `Authorization` to the remote A2A server. */
  remoteAuthHeader?: string;
  /** Optional skill id to attach to the message metadata. */
  skillId?: string;
  /** Use SSE streaming (message/stream); requires server card to declare it. */
  stream?: boolean;
  /** User's Supabase access token (for our /api/a2a proxy auth). */
  authToken?: string;
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  onStatus?: (state: TaskState, statusText?: string) => void;
}

export interface InvokeResult {
  ok: boolean;
  text?: string;
  task?: Task;
  error?: string;
}

/**
 * Invokes a remote A2A agent through our proxy. If `stream: true`, parses the
 * SSE response and emits text deltas via onToken; otherwise waits for the
 * final Task and returns its concatenated artifact text.
 */
export async function invokeAgent(opts: InvokeOptions): Promise<InvokeResult> {
  const body = {
    endpoint: opts.endpoint,
    message: opts.message,
    skillId: opts.skillId,
    remoteAuthHeader: opts.remoteAuthHeader,
    stream: !!opts.stream,
  };

  let resp: Response;
  try {
    resp = await fetch("/api/a2a?action=invoke", {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return { ok: false, error: `A2A invoke failed [${resp.status}]: ${txt.slice(0, 400)}` };
  }

  // Non-streaming branch — proxy returns a JSON Task or Message.
  if (!opts.stream) {
    const j = (await resp.json().catch(() => ({}))) as {
      task?: Task;
      message?: A2AMessage;
      error?: string;
    };
    if (j.error) return { ok: false, error: j.error };
    // Direct Message reply (some A2A servers respond with a Message instead
    // of a Task — e.g. the Hello World sample agent).
    if (j.message) {
      return { ok: true, text: partsToText(j.message.parts) };
    }
    if (!j.task) return { ok: false, error: "Proxy returned no task or message" };
    if (j.task.status?.state === "failed" || j.task.status?.state === "rejected") {
      return {
        ok: false,
        error: partsToText(j.task.status.message?.parts) || `Remote task ${j.task.status.state}`,
      };
    }
    if (j.task.status?.state === "input-required") {
      return {
        ok: false,
        error:
          "Remote agent needs more info: " +
          (partsToText(j.task.status.message?.parts) || "(no clarifying message provided)"),
      };
    }
    return { ok: true, task: j.task, text: taskToText(j.task) };
  }

  // Streaming branch — proxy re-streams the upstream SSE.
  if (!resp.body) return { ok: false, error: "Streaming response had no body" };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let lastTask: Task | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        // A2A SSE frames are JSON-RPC responses: { jsonrpc, id, result: <event> }
        const parsed = JSON.parse(payload) as {
          result?: TaskStatusUpdateEvent | TaskArtifactUpdateEvent | Task;
          error?: { message?: string };
        };
        if (parsed.error) {
          return { ok: false, error: parsed.error.message || "Remote JSON-RPC error" };
        }
        const ev = parsed.result;
        if (!ev) continue;

        // Direct Message frame (some servers reply with a Message instead of Task events).
        const evAny = ev as { kind?: string; parts?: Part[]; role?: string };
        if (evAny.kind === "message" && Array.isArray(evAny.parts)) {
          const chunk = partsToText(evAny.parts);
          if (chunk) {
            const delta = chunk.slice(accumulated.length);
            if (delta) {
              accumulated += delta;
              opts.onToken?.(delta);
            } else if (!accumulated) {
              accumulated = chunk;
              opts.onToken?.(chunk);
            }
          }
          continue;
        }

        // Plain Task object (some servers send a final Task instead of an event)
        if (
          (ev as Task).kind === "task" ||
          ((ev as Task).status && (ev as Task).id && !(ev as { kind?: string }).kind)
        ) {
          lastTask = ev as Task;
          const t = taskToText(lastTask);
          if (t && t !== accumulated) {
            const delta = t.slice(accumulated.length);
            accumulated = t;
            if (delta) opts.onToken?.(delta);
          }
          continue;
        }

        if ((ev as TaskArtifactUpdateEvent).kind === "artifact-update") {
          const a = (ev as TaskArtifactUpdateEvent).artifact;
          const chunk = partsToText(a.parts);
          if (chunk) {
            accumulated += chunk;
            opts.onToken?.(chunk);
          }
        } else if ((ev as TaskStatusUpdateEvent).kind === "status-update") {
          const s = (ev as TaskStatusUpdateEvent).status;
          opts.onStatus?.(s.state, partsToText(s.message?.parts));
          if (s.state === "failed" || s.state === "rejected") {
            return {
              ok: false,
              error: partsToText(s.message?.parts) || `Remote task ${s.state}`,
            };
          }
          if (s.state === "input-required") {
            return {
              ok: false,
              error:
                "Remote agent needs more info: " +
                (partsToText(s.message?.parts) || "(no clarifying message)"),
            };
          }
        }
      } catch {
        /* swallow keep-alives / malformed frames */
      }
    }
  }

  return {
    ok: true,
    task: lastTask,
    text: accumulated.trim(),
  };
}
