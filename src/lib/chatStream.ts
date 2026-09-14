// What a headless swarm step records about the tools its agent called.
//
// The browser runtime reads /api/chat's SSE stream and keeps three things
// per node: the text, the `cost` event, and every `tool` event — which the
// canvas tracer writes to `swarm_run_steps.tool_calls`. The server executor
// read the same stream for text and cost and dropped every `tool` event on
// the floor, and its tracer had no field to put one in. Measured live
// (ADVERSARIAL_LOG R3): the same swarm, the same node, the same input — the
// canvas step carried `[{type:"tool_call", name:"ml_list_models"…},
// {type:"tool_result", ok:true…}]`; the scheduled step carried `[]` with the
// same output. So the Swarm Traces page showed a deployed run as if its
// agents never used a tool, on exactly the path where nobody was watching
// the canvas — and a claim like "I called the tool" could not be checked.
//
// This module is the stream reader and the tool-node event shape, pure, so
// a test can feed them bytes and read what comes out.
import { mlToolData } from "@/lib/mlToolResult";
import type { ToolEvent } from "@/utils/tools/loop.server";

export type ChatUsage = { model?: string; costUsd: number; tokensIn: number; tokensOut: number };

/** A tool node's result preview, the same length the agent loop keeps. */
export const TOOL_NODE_PREVIEW_CHARS = 400;

/**
 * Read an OpenAI-compatible SSE body to the assistant's text, handing the
 * platform's `cost` and `tool` events to the caller as they arrive. A
 * malformed event is telemetry and is skipped; it never ends the read.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  on: { usage?: (u: ChatUsage) => void; tool?: (e: ToolEvent) => void } = {},
): Promise<string> {
  const reader = body.getReader();
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
          on.usage?.({
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
      if (event === "tool") {
        // The same events the canvas records on its step (captureMeta →
        // toolCalls): a call and its result, with the result's preview.
        try {
          const e = JSON.parse(payload) as ToolEvent;
          if (e && (e.type === "tool_call" || e.type === "tool_result")) on.tool?.(e);
        } catch {
          /* telemetry only */
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

/**
 * A tool node's call, recorded in the shape the agent loop emits — one
 * `tool_call` and one `tool_result` — so the step reader on the Traces
 * page serves both without knowing which kind of node made the call. An
 * ML result carries the same person-readable `data` the Playground panel
 * gets, built here because the full result exists only at this point.
 */
export function toolNodeEvents(args: {
  id: string;
  name: string;
  args: Record<string, string>;
  result: { ok: true; result: string } | { ok: false; error: string };
}): ToolEvent[] {
  const body = args.result.ok ? args.result.result : args.result.error;
  const data = args.result.ok
    ? (mlToolData(args.name, args.result.result) ?? undefined)
    : undefined;
  return [
    { type: "tool_call", name: args.name, args: JSON.stringify(args.args), id: args.id },
    {
      type: "tool_result",
      name: args.name,
      id: args.id,
      ok: args.result.ok && data?.kind !== "error",
      preview: body.slice(0, TOOL_NODE_PREVIEW_CHARS),
      ...(data ? { data } : {}),
    },
  ];
}
