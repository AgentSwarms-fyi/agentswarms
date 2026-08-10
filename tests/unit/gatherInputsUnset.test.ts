// A variable that was never set must not reach the model as an empty label.
//
// gatherInputs used to render every named input as `name: value`, with `??  ""`
// for the ones that had no value. On a branching graph that is the normal case:
// a node downstream of a router lists inputs from several branches, and only
// the branch that ran produced anything.
//
// The shipped Support Copilot template hit it in the multi-turn chat. Routed to
// "sensitive", its approval node gathered draft_answer and account_reply — both
// from branches that did not run — and the customer-facing answer was:
//
//     approved_reply: draft_answer:
//
//     account_reply:
//
//     draft_answer:
//
// with flow state recording approved_reply = "draft_answer: \n\naccount_reply: ".
//
// The real function is exercised here, not a copy of its logic — and the
// headless executor imports this same function, so the two runtimes cannot
// drift on it.
import { describe, expect, it } from "vitest";
import { gatherInputs } from "@/lib/swarmRuntime";
import type { Node } from "@xyflow/react";
import type { SwarmNodeData } from "@/lib/swarmRuntime";

/** Minimal node carrying just the inputs list gatherInputs reads. */
function nodeWith(inputs?: string[]): Node<SwarmNodeData> {
  return {
    id: "n1",
    position: { x: 0, y: 0 },
    data: { kind: "agent", label: "n", ...(inputs ? { inputs } : {}) } as SwarmNodeData,
  } as Node<SwarmNodeData>;
}

describe("gatherInputs skips variables the run never set", () => {
  it("omits an unset variable instead of emitting a bare label", () => {
    const out = gatherInputs(nodeWith(["set_one", "never_set"]), { set_one: "hello" }, "FALLBACK");
    expect(out).toBe("hello");
    expect(out).not.toContain("never_set");
  });

  it("labels the ones that are set when several are", () => {
    const out = gatherInputs(
      nodeWith(["a", "b", "missing"]),
      { a: "first", b: "second" },
      "FALLBACK",
    );
    expect(out).toBe("a: first\n\nb: second");
    expect(out).not.toContain("missing");
  });

  it("falls back when NONE of the named inputs were set", () => {
    // The Support Copilot case exactly: every input belonged to a branch that
    // did not run. The previous output is a far better answer than a scaffold.
    const out = gatherInputs(
      nodeWith(["draft_answer", "account_reply"]),
      { route_router: "sensitive" },
      "the previous node's output",
    );
    expect(out).toBe("the previous node's output");
    expect(out).not.toMatch(/draft_answer:/);
  });

  it("treats whitespace-only as unset — it teaches the model nothing", () => {
    const out = gatherInputs(nodeWith(["blank", "real"]), { blank: "   \n ", real: "x" }, "FB");
    expect(out).toBe("x");
  });

  it("still returns the single named input directly, without a label", () => {
    expect(gatherInputs(nodeWith(["only"]), { only: "value" }, "FB")).toBe("value");
  });

  it("still falls back when the single named input is missing", () => {
    expect(gatherInputs(nodeWith(["only"]), {}, "FB")).toBe("FB");
  });

  it("still falls back when no inputs are declared at all", () => {
    expect(gatherInputs(nodeWith(undefined), { a: "x" }, "FB")).toBe("FB");
  });

  it("never emits a label with an empty value, whatever the mix", () => {
    // The property that was violated, stated directly.
    for (const ctx of [
      {},
      { a: "" },
      { a: "x" },
      { a: "x", b: "" },
      { a: "", b: "", c: "y" },
    ] as Record<string, string>[]) {
      const out = gatherInputs(nodeWith(["a", "b", "c"]), ctx, "FB");
      expect(out, `ctx=${JSON.stringify(ctx)}`).not.toMatch(/^\s*\w+:\s*$/m);
    }
  });
});
