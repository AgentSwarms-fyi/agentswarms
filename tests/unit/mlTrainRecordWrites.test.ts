// The training job's records: workers the job row could not take are
// stopped again, a version that could not be recorded fails the job that
// trained it, a promotion the model could not point at is said.
//
// FOUND FROM THE SURVEY (R79). train.server.ts had 9 writes that dropped
// their errors; the version's ready write among them left a "succeeded" job
// over a version "training" for ever.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/ml/train.server.ts", "utf8");
const between = (start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const startJob = between(
  "export async function startTrainingJob(",
  "export function mlErrorMessage(",
);
const markFailed = between(
  "async function markJobFailed(",
  "export async function appendMlPartialLogs(",
);
const outcome = between(
  "async function writeTrainOutcome(",
  "export async function finalizeMlJob(",
);
const cancel = src.slice(src.indexOf("export async function cancelMlJob("));

describe("starting a job", () => {
  it("stops the workers again when the job row could not take them", () => {
    expect(startJob).toContain("const { error: recErr } = await supabaseAdmin");
    const i = startJob.indexOf("if (recErr) {");
    expect(i).toBeGreaterThan(-1);
    const block = startJob.slice(i, startJob.indexOf("if (started.length < plan.shards) {"));
    expect(block).toContain("await stopSession(session)");
    expect(block).toContain("could not record them");
    expect(block.indexOf("await stopSession(session)")).toBeLessThan(
      block.indexOf("await markJobFailed("),
    );
  });
});

describe("a job's outcome", () => {
  it("records the version with one retry, and fails the job it cannot record", () => {
    expect((outcome.match(/await recordVersion\(\)/g) ?? []).length).toBe(2);
    expect(outcome).toContain("The model trained, but its version could not be recorded");
    const i = outcome.indexOf("if (versionErr) {", outcome.indexOf("setTimeout"));
    const block = outcome.slice(i, outcome.indexOf("if (model) {", i));
    expect(block).toContain('status: "failed"');
    expect(block).toContain("void notifyUser(job.user_id, {");
    expect(block).toContain("return;");
  });

  it("says when the model could not be pointed at the version it promoted", () => {
    expect(outcome).toContain("const { error: pointerErr } = await supabaseAdmin");
    expect(outcome).toContain("is marked production but the model's pointer could not be set");
  });
});

describe("a version left training", () => {
  it("is said when the failed or cancelled mark could not be written", () => {
    expect(markFailed).toContain("const { error: versionErr } = await supabaseAdmin");
    expect(markFailed).toContain("could not be marked failed");
    expect(cancel).toContain("const { error: versionErr } = await supabaseAdmin");
    expect(cancel).toContain("could not be marked cancelled");
  });
});
