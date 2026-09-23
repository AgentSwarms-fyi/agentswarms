// A swarm run that parked at an approval and was then resumed: one run, one
// id, one timeline.
//
// FOUND FROM THE SURVEY (R92). executeSwarmServer's `resume` option documents
// that the caller supplies the existing run id "so the timeline continues
// rather than forking", but the id never reached the tracer: every resume
// inserted a second swarm_runs row and nothing ever closed the parked one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tr = readFileSync("src/utils/observability/serverTracer.server.ts", "utf8");
const ex = readFileSync("src/utils/swarmExecute.server.ts", "utf8");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `missing anchor: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i);
  expect(j, `missing anchor: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};
const flat = (s: string) => s.replace(/\s+/g, " ");

const head = between(tr, "export async function createServerSwarmTracer(", "    return {");
const startStep = between(tr, "async startStep(args) {", "async finishStep(");
const finishStep = between(tr, "async finishStep(nodeId, args) {", "async recordEdge(");
const recordEdge = between(tr, "async recordEdge(args) {", "async finish(args) {");

describe("resuming a parked run", () => {
  it("reopens the run it was given instead of inserting another", () => {
    expect(head).toContain("resumeRunId?: string | null;");
    expect(flat(head)).toContain('.update({ status: "running", finished_at: null } as never)');
    expect(flat(head)).toContain('.eq("id", opts.resumeRunId)');
    expect(flat(head)).toContain('.eq("user_id", opts.userId)');
  });

  it("says so when the run cannot be reopened, and what that leaves", () => {
    expect(flat(head)).toContain("could not be reopened");
    expect(flat(head)).toContain("the parked one stays open");
  });

  it("carries the first half's steps, numbers and edges into the same run", () => {
    expect(flat(head)).toContain('.from("swarm_run_steps")');
    expect(flat(head)).toContain("stepIdByNode.set(s.node_id, s.id)");
    expect(flat(head)).toContain("totals.count += 1");
    expect(flat(head)).toContain('.from("swarm_run_edges")');
    expect(flat(head)).toContain("edgesSeen.add(");
  });

  it("leaves the step it parked ON open, so it is closed once, when it ends", () => {
    expect(flat(head)).toContain('if (s.status === "running") continue;');
    expect(flat(head)).toContain("carried.add(s.node_id)");
  });

  it("does not record a node, a step's numbers or an edge a second time", () => {
    expect(flat(startStep)).toContain("if (stepIdByNode.has(args.nodeId)) return;");
    expect(flat(finishStep)).toContain("if (carried.has(nodeId)) return;");
    expect(flat(recordEdge)).toContain("if (edgesSeen.has(edgeKey)) return;");
  });
});

describe("the executor's half of the promise", () => {
  it("hands the parked run's id to the tracer", () => {
    expect(flat(ex)).toContain("resumeRunId: opts.resume?.runId ?? null,");
  });

  it("does not open a second decision for a run it is continuing", () => {
    expect(flat(ex)).toContain("if (runId && !opts.resume) {");
  });
});
