// The shipped Support Copilot template, walked down each of its three routes.
//
// gatherInputsUnset.test.ts fixed the RUNTIME: an unset variable no longer
// reaches the model as a bare label. That stopped the garbled output but not
// the underlying mis-wiring, which is in the template's own graph.
//
// Three edges reach the approval node — router/"sensitive", gate/"no", and the
// account branch — and each route sets a different variable. On the sensitive
// route NEITHER of the two it listed exists, so gatherInputs fell back to the
// previous node's output. For that route the previous node is the ROUTER,
// whose output is the route label. The approver was being shown the word
// "sensitive" and asked to approve it. That text is not incidental: the
// runtime writes it to `approvals.description` and `payload.last_output`,
// which is literally what a human reads before clicking Approve.
//
// This drives the REAL gatherInputs against the REAL template — no copy of
// either — so a later edit to the graph that reintroduces the gap fails here.
import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";

import { gatherInputs, type SwarmNodeData } from "@/lib/swarmRuntime";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";

const template = SWARM_TEMPLATES.find((t) => t.id === "support-copilot")!;
const nodeById = (id: string) =>
  template.nodes.find((n) => n.id === id) as unknown as Node<SwarmNodeData>;

const REQUEST = "I was double charged and I want a refund, this is unacceptable.";

describe("the Support Copilot template is wired for every route it can take", () => {
  it("exists, with the three-way router this test assumes", () => {
    // Guard on the guard: if the template were renamed or the routes changed,
    // every assertion below would pass vacuously against a different graph.
    expect(template).toBeTruthy();
    const labels = template.edges.filter((e) => e.source === "router").map((e) => e.label);
    expect(new Set(labels)).toEqual(new Set(["product", "account", "sensitive"]));
    expect(template.edges.some((e) => e.source === "router" && e.target === "approval")).toBe(true);
  });

  it("the sensitive route shows the approver the customer's request", () => {
    // Only `input` is set — the product and account branches were skipped.
    // The fallback here is the router's output, which is what used to be shown.
    const out = gatherInputs(nodeById("approval"), { input: REQUEST }, "sensitive");
    expect(out).toBe(REQUEST);
    expect(out, "the approver is being shown the route label again").not.toBe("sensitive");
  });

  it("the low-confidence route shows the request AND the draft", () => {
    const out = gatherInputs(
      nodeById("approval"),
      { input: REQUEST, draft_answer: "Here is what the docs say…", context: "…" },
      "0.42",
    );
    expect(out).toContain(REQUEST);
    expect(out).toContain("Here is what the docs say");
    // Not the judge's score, which is the previous node's output on this route.
    expect(out).not.toBe("0.42");
  });

  it("the account route shows the request AND the account reply", () => {
    const out = gatherInputs(
      nodeById("approval"),
      { input: REQUEST, account_reply: "Open Billing → Invoices and…" },
      "unused",
    );
    expect(out).toContain(REQUEST);
    expect(out).toContain("Open Billing");
  });

  it("no route can reach the approval with nothing to approve", () => {
    // `input` is set by the entry node on every path, so the fallback branch
    // is now unreachable for this node. Stated as the property, not as three
    // examples, so a fourth route added later is covered too.
    const approval = nodeById("approval");
    expect(approval.data.inputs).toContain("input");
    const inputNode = template.nodes.find((n) => n.data.kind === "input");
    expect(inputNode?.data.outputVar, "the entry variable is not called `input`").toBe("input");
  });

  it("the output node can render an account reply directly", () => {
    // It listed approved_reply and draft_answer only, so an account answer
    // could only ever surface second-hand through the approval.
    const out = gatherInputs(nodeById("out"), { account_reply: "Open Billing → Invoices" }, "FB");
    expect(out).toBe("Open Billing → Invoices");
  });

  it("the output node still prefers the approved reply when there is one", () => {
    const out = gatherInputs(
      nodeById("out"),
      { approved_reply: "APPROVED TEXT", account_reply: "raw account text" },
      "FB",
    );
    // Both present ⇒ labelled form, with the approved one first as declared.
    expect(out.indexOf("approved_reply")).toBeLessThan(out.indexOf("account_reply"));
    expect(out).toContain("APPROVED TEXT");
  });
});
