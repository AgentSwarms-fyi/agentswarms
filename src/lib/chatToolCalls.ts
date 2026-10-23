// The tool calls an /api/chat answer made, one row per call (R347).
//
// /api/chat runs the tools itself and reports each call and its result as an
// `event: tool` block ahead of the answer's text (ToolEvent). The Data
// Catalog's SQL Chat read the stream with a reader of its own that looked for
// a `tool_result` property no event has, so the chips it draws for each call
// never appeared: a question answered by running SQL showed no SQL at all.
// The page now reads the stream with readChatStream and folds its tool events
// here.
import type { ToolEvent } from "@/utils/tools/loop.server";

export type ChatToolCall = {
  id: string;
  name: string;
  /** The arguments as the model sent them; {} when they were not a JSON object. */
  args: Record<string, unknown>;
  /** "running" until its result arrives; "none" when the answer ended without one. */
  status: "running" | "ok" | "error" | "none";
  /** The start of the result, as the agent loop keeps it (400 characters). */
  preview: string;
};

/** The calls so far, with one more event folded in. */
export function withToolEvent(calls: ChatToolCall[], e: ToolEvent): ChatToolCall[] {
  if (e.type === "tool_call") {
    return [
      ...calls,
      { id: e.id, name: e.name, args: argsObject(e.args), status: "running", preview: "" },
    ];
  }
  const status = e.ok ? "ok" : "error";
  const at = calls.findIndex((c) => c.id === e.id && c.status === "running");
  if (at < 0) return [...calls, { id: e.id, name: e.name, args: {}, status, preview: e.preview }];
  return calls.map((c, i) => (i === at ? { ...c, status, preview: e.preview } : c));
}

/** The answer has ended, so a call still running never got its result. */
export function settledToolCalls(calls: ChatToolCall[]): ChatToolCall[] {
  return calls.map((c) => (c.status === "running" ? { ...c, status: "none" } : c));
}

function argsObject(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
