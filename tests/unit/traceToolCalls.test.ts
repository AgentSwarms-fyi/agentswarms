// A chat turn's trace row records the tools it called (R354).
//
// FOUND FROM THE UI (R353). A Predictive Analyst turn, "List my ML models by
// name only. Use your tool.", called ml_list_models. Its trace on /traces had
// no Tool Calls section: /api/chat wrote `tool_calls: []` on every row, and the
// events were only in the request payload's `toolEvents`. The events below are
// that turn's, as the agent loop emits them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { traceToolCalls } from "@/lib/traceToolCalls";

const turn = [
  { type: "tool_call", name: "ml_list_models", args: "{}", id: "call_1" },
  {
    type: "tool_result",
    name: "ml_list_models",
    id: "call_1",
    ok: true,
    preview: '{"models":[{"name":"revenue_facts · groups"}]}',
  },
];

describe("what the trace row records as tool calls", () => {
  it("the turn's calls and results, in order", () => {
    expect(traceToolCalls(turn)).toEqual(turn);
  });

  it("nothing for a turn that called no tool", () => {
    expect(traceToolCalls(undefined)).toEqual([]);
    expect(traceToolCalls([])).toEqual([]);
    expect(traceToolCalls("x")).toEqual([]);
  });

  it("only the agent loop's events", () => {
    expect(traceToolCalls([null, "call", [turn[0]], { type: "cost" }, turn[1]])).toEqual([turn[1]]);
  });
});

describe("the chat route", () => {
  const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");

  it("writes the turn's tool events into tool_calls, as a body like the payload's", () => {
    expect(CHAT).toContain("tool_calls: bodyJson(traceToolCalls(safePayload.toolEvents)),");
    expect(CHAT).not.toMatch(/\n\s+tool_calls: \[\],\n\s+\};\n/);
  });

  it("the Traces page reads that column for its Tool Calls section", () => {
    const page = readFileSync("src/routes/_authenticated/traces.tsx", "utf8");
    expect(page).toContain(
      "{Array.isArray(selected.tool_calls) && selected.tool_calls.length > 0 && (",
    );
  });
});
