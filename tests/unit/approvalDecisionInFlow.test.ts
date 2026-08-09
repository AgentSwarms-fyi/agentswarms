// A human's approval decision has to be readable by the nodes after it.
//
// Approve-and-resume works: driven through the UI, a run parked at the gate,
// the inbox showed the amount, the cash-flow impact and the risk, Approve
// resumed it from that step without re-running the agent above, and the run
// completed. That whole mechanism is sound.
//
// What the run then said was wrong. The next node is a condition labelled
// "Approved?" asking "Did the approver let this proceed?" — and after a
// hand-approved run it answered NO, which became the swarm's FINAL OUTPUT.
//
// It could not have answered anything else. On approval the executor did
// `write(pending)` — the payload passes through unchanged — and nothing
// recorded the decision. So the condition was asked whether a human approved
// while being shown only a refund summary, which says nothing about it. It
// guessed.
//
// Rejection throws, so reaching a later node already implies approval. The fix
// makes that implication readable, and carries the approver's note, which is
// the part a branch might genuinely want to read ("approved, but cap it at
// $100").
//
// Asserted against the SOURCE because executing a swarm needs a live database,
// a checkpoint and a paid model call; the behaviour itself was verified by
// hand in the browser and is described above.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";

const executor = readFileSync(resolve("src/utils/swarmExecute.server.ts"), "utf8");
const clientRuntime = readFileSync(resolve("src/lib/swarmRuntime.ts"), "utf8");

/** The approval branch that runs when the human said yes. */
function approvedBranch(): string {
  const i = executor.indexOf("if (decision.approved) {");
  expect(i, "the approval branch moved; this test needs re-anchoring").toBeGreaterThan(0);
  return executor.slice(i, i + 1200);
}

describe("the approval decision reaches flow state", () => {
  it("records that it was approved, not just the payload", () => {
    const branch = approvedBranch();
    expect(branch).toContain("write(pending)");
    expect(branch).toMatch(/_approved`?,\s*"yes"/);
  });

  it("carries the approver's note when there is one", () => {
    expect(approvedBranch()).toMatch(/decision\.note/);
  });

  it("does the same in the CLIENT runtime the canvas uses", () => {
    // The canvas does not run swarmExecute.server — it runs swarmRuntime, and
    // the two must agree about what a node writes. Fixing only the server one
    // is exactly the mistake made here first: the code was correct, the test
    // was green, and re-running the template in the browser still answered NO
    // because the canvas never touched that file.
    const i = clientRuntime.indexOf('node.data.kind === "approval"');
    expect(i, "the client approval branch moved").toBeGreaterThan(0);
    // Wide enough to reach the write: the approval branch spans the approval
    // row insert, approver notification and the wait, before it writes.
    const branch = clientRuntime.slice(i, i + 6000);
    expect(branch).toMatch(/_approved`\]\s*=\s*"yes"/);
  });

  it("still fails the run on rejection", () => {
    // The decision variable must not turn a rejection into a branch someone
    // could accidentally route around.
    const i = executor.indexOf("Rejected at human-approval step");
    expect(i).toBeGreaterThan(0);
    const around = executor.slice(Math.max(0, i - 200), i);
    expect(around).toContain("throw new Error");
  });
});

describe("the shipped approval template branches on the decision", () => {
  const tpl = SWARM_TEMPLATES.find((t) => t.id === "approval-durability-check");

  it("exists", () => {
    expect(tpl).toBeTruthy();
  });

  it("reads the decision variable rather than guessing from prose", () => {
    const cond = (
      tpl!.nodes as { id: string; data?: { condition?: string; inputs?: string[] } }[]
    ).find((n) => n.id === "check");
    expect(cond, "the condition node is gone").toBeTruthy();
    expect(cond!.data!.inputs).toContain("approved_summary_approved");
    // The old wording asked a question the input could not answer.
    expect(cond!.data!.condition).not.toMatch(/Did the approver let this proceed/i);
  });
});
