// The workflow runner: a run whose closing write failed is not "another
// replica closed it first" — it is retried, then said, never silently left
// running.
//
// FOUND FROM THE SURVEY. closeRun read `won` and nothing else, so a failed
// close returned without a word and the run stayed "running" for ever, the
// workflow's last status stayed "running", with no audit entry and no
// notification.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/workflows/run.server.ts", "utf8");
const closeRun = src.slice(
  src.indexOf("async function closeRun("),
  src.indexOf("export async function cancelWorkflowRun("),
);
const finishNode = src.slice(
  src.indexOf("async function finishNode("),
  src.indexOf("/** Write the run's outcome"),
);

describe("closeRun", () => {
  it("tells a failed close apart from a close another replica made", () => {
    expect(closeRun).toContain("let { data: won, error: closeErr } = await close();");
    expect(closeRun).toContain("if (closeErr) {");
    // The "another replica" return comes AFTER the error has been handled.
    expect(closeRun.indexOf("if (closeErr) {")).toBeLessThan(
      closeRun.indexOf("if (!won?.length) return; // another replica closed it first"),
    );
  });

  it("retries a failed close once before giving up", () => {
    expect((closeRun.match(/await close\(\)/g) ?? []).length).toBe(2);
    expect(closeRun).toContain("setTimeout(r, 1_000)");
  });

  it("says when a run could not be closed, with what a person needs", () => {
    expect(closeRun).toContain("could not be closed after two attempts");
    expect(closeRun).toContain("It will show as running until it is closed.");
  });

  it("keeps the error of the workflow's status stamp and still audits the close", () => {
    expect(closeRun).toContain("const { data: workflow, error: stampErr } = await supabaseAdmin");
    expect(closeRun).toContain("the workflow's last status could not be stamped");
    expect(closeRun.indexOf("if (stampErr) {")).toBeLessThan(closeRun.indexOf("auditEvent({"));
  });
});

describe("finishNode", () => {
  it("keeps the error of a node's final write and says so", () => {
    expect(finishNode).toContain("const { error: writeErr } = await supabaseAdmin");
    expect(finishNode).toContain("but its record could not be written");
  });
});
