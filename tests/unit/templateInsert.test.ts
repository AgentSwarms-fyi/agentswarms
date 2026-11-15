// References picked from a list, not typed (R495).
//
// A swarm node's prompt, URL or body can read `{{name}}`; a report footer can
// read `{{page}}`. The editors now offer those names in a menu and put the
// picked one at the cursor. What the menu offers has to be what the runtime
// will actually find, or picking from it is as wrong as typing a guess: a
// swarm node is offered the run's own values and the outputs of the steps that
// lead into it, not every step on the canvas (one that runs later, or on
// another branch, has not set anything yet), and a report band is offered the
// tokens the export replaces, no more.
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";

import { insertAtCaret } from "@/hooks/use-insert-at-caret";
import { REPORT_TOKENS, substituteTokens } from "@/lib/biReports";
import { interpolate, type SwarmNodeData } from "@/lib/swarmRuntime";
import { swarmTemplateVars, swarmVarNames } from "@/lib/swarmTemplateVars";

function node(id: string, data: Partial<SwarmNodeData>): Node<SwarmNodeData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { label: id, kind: "agent", ...data } as SwarmNodeData,
  };
}
const edge = (source: string, target: string): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
});

describe("putting a reference at the cursor", () => {
  it("inserts at the cursor and puts the cursor after it", () => {
    const el = { selectionStart: 6, selectionEnd: 6 };
    expect(insertAtCaret(el, "Hello world", "{{input}}")).toEqual({
      value: "Hello {{input}}world",
      caret: 15,
    });
  });

  it("replaces a selection", () => {
    const el = { selectionStart: 6, selectionEnd: 11 };
    expect(insertAtCaret(el, "Hello world", "{{input}}").value).toBe("Hello {{input}}");
  });

  it("appends when there is no field, or the cursor is past the end", () => {
    expect(insertAtCaret(null, "abc", "{{x}}")).toEqual({ value: "abc{{x}}", caret: 8 });
    expect(insertAtCaret({ selectionStart: 99, selectionEnd: 99 }, "abc", "!").value).toBe("abc!");
  });
});

describe("what a swarm node is offered", () => {
  const nodes = [
    node("in", {
      kind: "input",
      inputFields: [{ name: "ticket", label: "Ticket text", type: "text" }],
    }),
    node("research", { kind: "agent", label: "Researcher", outputVar: "research" }),
    node("gate", { kind: "approval", label: "Manager", outputVar: "gate" }),
    node("vars", {
      kind: "set_var",
      label: "Remember",
      outputVar: "vars",
      stateAssignments: [{ key: "region", value: "{{input}}" }],
    }),
    node("pull", {
      kind: "extract",
      label: "Pull fields",
      outputVar: "fields",
      extractSchema: [{ name: "amount", type: "number" }],
    }),
    node("writer", { kind: "agent", label: "Writer", outputVar: "draft" }),
    node("later", { kind: "agent", label: "Later", outputVar: "later_out" }),
    node("side", { kind: "agent", label: "Other branch", outputVar: "side_out" }),
  ];
  const edges = [
    edge("in", "research"),
    edge("research", "gate"),
    edge("gate", "vars"),
    edge("vars", "pull"),
    edge("pull", "writer"),
    edge("writer", "later"),
    edge("in", "side"),
  ];
  const vars = swarmTemplateVars(nodes, edges, "writer");
  const names = vars.map((v) => v.name);

  it("offers the run's input and start-form fields", () => {
    expect(names.slice(0, 2)).toEqual(["input", "ticket"]);
    expect(vars.find((v) => v.name === "ticket")?.detail).toContain("Ticket text");
  });

  it("offers every upstream output, nearest first, with what each step adds", () => {
    expect(names.filter((n) => !["input", "ticket"].includes(n))).toEqual([
      "fields",
      "fields.amount",
      "vars",
      "region",
      "gate",
      "gate_approved",
      "research",
    ]);
  });

  it("does not offer a step that runs later, or on another branch", () => {
    expect(names).not.toContain("later_out");
    expect(names).not.toContain("side_out");
    expect(names).not.toContain("draft"); // its own output
  });

  it("offers a For Each its item and index, but not as variables to read whole", () => {
    const fe = [...nodes, node("each", { kind: "foreach", foreachItemVar: "row" })];
    const v = swarmTemplateVars(fe, [...edges, edge("research", "each")], "each");
    expect(v.slice(0, 2).map((x) => x.name)).toEqual(["row", "index"]);
    expect(swarmVarNames(v)).toEqual(["input", "ticket", "research"]);
  });

  it("names a step without an output variable the way the canvas does", () => {
    const v = swarmTemplateVars(
      [node("a", { kind: "agent" }), node("c", { kind: "condition" }), node("b", {})],
      [edge("a", "c"), edge("c", "b")],
      "b",
    );
    expect(v.map((x) => x.name)).toEqual(["input", "cond_c", "out_a"]);
  });

  it("walks a cycle once", () => {
    const v = swarmTemplateVars(
      [node("a", { outputVar: "a" }), node("b", { outputVar: "b" })],
      [edge("a", "b"), edge("b", "a")],
      "b",
    );
    expect(v.map((x) => x.name)).toEqual(["input", "a"]);
  });

  it("offers names the runtime resolves", () => {
    const ctx = {
      input: "hi",
      research: "notes",
      fields: JSON.stringify({ amount: 42 }),
      region: "EMEA",
    };
    for (const n of ["input", "research", "fields.amount", "region"]) {
      expect(interpolate(`{{${n}}}`, ctx), n).not.toBe(`{{${n}}}`);
    }
  });
});

describe("what a report band is offered", () => {
  it("every token the menu offers is one the export replaces", () => {
    const ctx = { page: 2, pages: 5, title: "Q3", date: "2026-11-15", time: "09:00" };
    for (const { token } of REPORT_TOKENS) {
      expect(substituteTokens(`{{${token}}}`, ctx), token).toBe(String(ctx[token]));
    }
    expect(REPORT_TOKENS.map((t) => t.token).sort()).toEqual(Object.keys(ctx).sort());
  });
});
