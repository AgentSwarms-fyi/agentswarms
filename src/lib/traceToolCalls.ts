// What a chat turn's trace row records as its tool calls (R354).
//
// /api/chat wrote `tool_calls: []` on every trace row. The turn's tool events
// went into the request payload's `toolEvents`, where only the raw JSON view
// showed them, while the Traces page's Tool Calls section, which reads the
// column, never appeared for a chat turn. A Predictive Analyst turn that
// called ml_list_models showed no tool call at all. The row now carries the
// events in the shape the page already reads: a `tool_call` with its JSON
// `args`, then a `tool_result` with `ok` and a preview.
import type { Json } from "@/integrations/supabase/types";

/** The turn's tool events as the trace's `tool_calls` column holds them: [] when there were none. */
export function traceToolCalls(toolEvents: unknown): Json {
  if (!Array.isArray(toolEvents)) return [];
  return toolEvents.filter(
    (e): e is Json =>
      typeof e === "object" &&
      e !== null &&
      !Array.isArray(e) &&
      ((e as { type?: unknown }).type === "tool_call" ||
        (e as { type?: unknown }).type === "tool_result"),
  );
}
