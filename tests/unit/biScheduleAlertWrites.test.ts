// The BI schedule's clock and the alert's edge: a state write that failed
// is said, because `last_state` decides whether a person is told again and
// `next_run_at` decides whether the dashboard refreshes again.
//
// FOUND FROM THE SURVEY (R85). refresh.server.ts dropped four writes'
// errors; versions.server.ts dropped the restore's column-list write.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rf = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
const vs = readFileSync("src/utils/bi/versions.server.ts", "utf8");

describe("a BI alert's state", () => {
  it("says when the not-evaluated state could not be recorded", () => {
    expect(rf).toContain("const { error: partialErr } = await supabaseAdmin");
    expect(rf).toContain("the same notice will be sent again on the next check");
  });

  it("says when the checked state could not be recorded, either way", () => {
    expect(rf).toContain("const { error: stateErr } = await supabaseAdmin");
    expect(rf).toContain("it will notify again on the next check");
    expect(rf).toContain("even if it never cleared");
  });
});

describe("a BI schedule's clock", () => {
  it("is retried once and, failing twice, said to the owner with the cost", () => {
    expect((rf.match(/await stamp\(\)/g) ?? []).length).toBe(2);
    expect(rf).toContain("its next run could not be set after two attempts");
    expect(rf).toContain("It is still due, so the next sweep will refresh the dashboard again.");
    expect(rf).toContain('"Scheduled refresh could not record its next run"');
    expect(rf).toContain("It will keep refreshing every sweep until the schedule can be written.");
  });

  it("says when a prep flow's refresh could not be stamped", () => {
    expect(rf).toContain("const { error: flowErr } = await supabaseAdmin");
    expect(rf).toContain("the page shows the previous refresh until it is");
  });
});

describe("restoring a dataset version", () => {
  it("fails the restore when the column list could not be set", () => {
    expect(vs).toContain("const { error: schemaErr } = await supabaseAdmin");
    expect(vs).toContain("under the previous column list — restore it again");
    expect(vs.indexOf("if (schemaErr) {")).toBeLessThan(vs.indexOf("refreshDatasetMirror"));
    expect(vs).toContain("const { error: pruneErr } = await supabaseAdmin");
  });
});
