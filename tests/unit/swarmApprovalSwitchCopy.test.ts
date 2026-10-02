// What the Deploy dialog tells an operator the "Reject approvals" switch does,
// pinned to what the executor actually does at a human-approval gate.
//
// FOUND FROM THE SURVEY (R91). The warning said that turning the switch OFF
// made the swarm auto-approve every approval step and bypass human oversight.
// It is the other way round: ON throws at the gate, so nobody is ever asked;
// OFF parks the run with a checkpoint and puts the request in front of a
// person. Told the old story, the operator who wants human sign-off leaves ON,
// the one setting under which no human ever sees the request.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialog = readFileSync("src/components/swarms/SwarmDeployDialog.tsx", "utf8");
const ex = readFileSync("src/utils/swarmExecute.server.ts", "utf8");
const swarmDocs = readFileSync("src/routes/docs.swarms.tsx", "utf8");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `missing anchor: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i);
  expect(j, `missing anchor: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

// Flattened, so that re-wrapping this copy cannot silently drop a clause.
const flat = (s: string) => s.replace(/\s+/g, " ");

const warning = flat(between(dialog, "{approvalNodes.length > 0 && (", "{!swarmId ? ("));
const gate = between(ex, 'if (kind === "approval") {', "const pending = gatherInputs(");

describe("what the executor does at a human-approval gate", () => {
  it("rejectApprovals ON throws there, so nobody is ever asked", () => {
    expect(gate).toContain("if (opts.rejectApprovals) {");
    expect(gate).toContain("throw new Error(");
    expect(flat(gate)).toContain("this run has nobody to approve it");
  });

  it("and its own message says OFF is what parks the run for a person", () => {
    expect(flat(gate)).toContain('off "Reject approvals" on the API key or schedule');
    expect(flat(gate)).toContain("the run will then park");
    expect(flat(gate)).toContain("resume when someone approves it");
  });

  it("the OFF path parks with a checkpoint rather than approving anything", () => {
    expect(ex).toContain('return await finish("suspended", parked.pending, null);');
  });
});

describe("the Deploy dialog's warning about approval steps", () => {
  it("no longer claims OFF auto-approves, or that it bypasses oversight", () => {
    const claim = warning.slice(warning.indexOf("<p className="));
    expect(claim).not.toContain("<strong>auto-approve</strong>");
    expect(claim).not.toContain("human oversight is bypassed");
  });

  it("says ON ends the run at the step, with nobody asked", () => {
    expect(warning).toContain("ends it as an <strong>error</strong>");
    expect(warning).toContain("nobody is asked");
  });

  it("says OFF parks the run and waits for someone to decide", () => {
    expect(warning).toContain("OFF <strong>parks</strong> the run instead");
    expect(warning).toContain("lands in your approvals bell");
    expect(warning).toContain("once someone decides");
  });

  it("warns that a parked run answers a caller with suspended and no output", () => {
    expect(warning).toContain("status: suspended");
    expect(warning).toContain("needs its answer in one call");
  });
});

describe("the evaluations note in the swarms docs", () => {
  it("says auto-reject errors the case and that turning it off parks it", () => {
    const note = flat(
      between(swarmDocs, "Approval nodes are auto-rejected by default", "Each result links"),
    );
    expect(note).toContain("ends such a case with an error rather than a verdict");
    expect(note).toContain("does not approve them");
    expect(note).toContain("<C>suspended</C> and waits for a person");
  });
});
