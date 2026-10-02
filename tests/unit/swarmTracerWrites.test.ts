// The swarm run's trace: a run that finished does not stay "running", and
// a step, edge or outcome the database refused is said rather than swallowed
// by a catch it never reaches.
//
// FOUND FROM THE SURVEY (R86). serverTracer.server.ts wrapped four writes in
// try/catch, and a supabase call answers with its error rather than throwing.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/observability/serverTracer.server.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const startStep = between("async startStep(args) {", "async finishStep(nodeId, args) {");
const finishStep = between("async finishStep(nodeId, args) {", "async recordEdge(args) {");
const recordEdge = between("async recordEdge(args) {", "async finish(args) {");
const finish = src.slice(src.indexOf("async finish(args) {"));

describe("the swarm tracer's writes", () => {
  it("reads the answer of the step insert and says a step it could not record", () => {
    expect(startStep).toContain("const { data, error: stepErr } = await supabaseAdmin");
    expect(startStep).toContain("its outcome and edges will be missing from the trace");
  });

  it("says a step whose outcome could not be written", () => {
    expect(finishStep).toContain("const { error: finishErr } = await supabaseAdmin");
    expect(finishStep).toContain("the timeline will show it running");
  });

  it("says an edge that could not be recorded", () => {
    expect(recordEdge).toContain("const { error: edgeErr } = await supabaseAdmin");
    expect(recordEdge).toContain("the graph will show the steps without it");
  });
});

describe("closing a swarm run", () => {
  it("retries the close once and says a run it could not close", () => {
    expect((finish.match(/await close\(\)/g) ?? []).length).toBe(2);
    expect(finish).toContain("could not be closed after two attempts");
    expect(finish).toContain("It will show as running until it is closed.");
  });
});
