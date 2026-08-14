// Scheduling an analysis. The risk is not that a refresh fails — a failure is
// visible. It is that a refresh quietly changes what the analysis MEANS: new
// numbers under prose written for the old ones, a what-if computed against
// last week left beside this week's measurements, or a verdict presented as
// covering work it never saw.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  analysisChanges,
  describeSchedule,
  pinnedSteps,
  refreshedTurn,
  runDigest,
  scheduleRefusal,
} from "@/lib/analystSchedule";
import type { AnalystStep, AnalystTurn } from "@/lib/aiAnalyst";

const step = (over: Partial<AnalystStep> = {}): AnalystStep => ({
  goal: "Headcount",
  sql: "SELECT SUM(headcount) AS total FROM hr",
  status: "done",
  columns: ["total"],
  rows: [{ total: 100 }],
  rowCount: 1,
  ...over,
});

const turn = (over: Partial<AnalystTurn> = {}): AnalystTurn => ({
  question: "What is headcount?",
  answer: "100 people (step 1).",
  status: "done",
  steps: [step()],
  ...over,
});

describe("what can be scheduled", () => {
  it("allows an ordinary finished analysis", () => {
    expect(scheduleRefusal(turn())).toBeNull();
  });

  it("refuses an analysis that stopped to ask a question", () => {
    const r = scheduleRefusal(turn({ clarify: "Which year?", status: "clarifying" }));
    expect(r).toContain("stopped to ask");
  });

  it("refuses an analysis that ran no queries", () => {
    expect(scheduleRefusal(turn({ steps: [] }))).toContain("no queries");
    expect(scheduleRefusal(turn({ steps: [step({ sql: "   " })] }))).toContain("no queries");
  });

  it("refuses when there is no analysis at all", () => {
    expect(scheduleRefusal(undefined)).toContain("Ask a question first");
  });

  it("pins only the steps that actually run SQL", () => {
    const t = turn({ steps: [step({ sql: undefined }), step({ goal: "B" })] });
    expect(pinnedSteps(t).map((s) => s.goal)).toEqual(["B"]);
  });
});

describe("folding fresh results back in", () => {
  it("replaces the numbers and nothing else", () => {
    const t = turn({
      steps: [step({ governed: { model: "hr_model" }, check: { verdict: "pass", note: "ok" } })],
    });
    const out = refreshedTurn(t, [{ columns: ["total"], rows: [{ total: 130 }], rowCount: 1 }]);
    expect(out.steps[0].rows).toEqual([{ total: 130 }]);
    // The things that make the number mean what it means must survive.
    expect(out.steps[0].sql).toBe(t.steps[0].sql);
    expect(out.steps[0].goal).toBe("Headcount");
    expect(out.steps[0].governed).toEqual({ model: "hr_model" });
    expect(out.steps[0].check).toEqual({ verdict: "pass", note: "ok" });
  });

  it("marks the findings stale rather than re-writing them", () => {
    // Re-synthesizing behind the reader's back puts a paragraph nobody judged
    // in front of them; leaving old prose unmarked is worse.
    const out = refreshedTurn(turn(), [
      { columns: ["total"], rows: [{ total: 130 }], rowCount: 1 },
    ]);
    expect(out.answerStale).toBe(true);
    expect(out.answer).toBe("100 people (step 1).");
  });

  it("DROPS a what-if computed against the previous numbers", () => {
    const t = turn({
      steps: [
        step({
          scenario: {
            changes: [],
            label: "Scenario — rate 0.1 → 0.15",
            sql: "SELECT 1",
            columns: ["total"],
            rows: [{ total: 90 }],
            delta: [],
          },
        }),
      ],
    });
    const out = refreshedTurn(t, [{ columns: ["total"], rows: [{ total: 130 }], rowCount: 1 }]);
    expect(out.steps[0].scenario).toBeUndefined();
  });

  it("keeps a human verdict — the SQL it judged did not change", () => {
    const t = turn({
      verification: {
        state: "verified",
        at: "2026-08-14T00:00:00.000Z",
        by: "rimo",
        fingerprint: "f",
      },
    });
    const out = refreshedTurn(t, [{ columns: ["total"], rows: [{ total: 130 }], rowCount: 1 }]);
    expect(out.verification).toEqual(t.verification);
  });

  it("aligns results with the SQL-bearing steps, not with every step", () => {
    // A step with no SQL consumes no result. Getting this wrong shifts every
    // subsequent step's numbers onto the wrong query — the worst possible
    // outcome, because nothing looks broken.
    const t = turn({
      steps: [
        step({ goal: "prose only", sql: undefined }),
        step({ goal: "A" }),
        step({ goal: "B" }),
      ],
    });
    const out = refreshedTurn(t, [
      { columns: ["total"], rows: [{ total: 11 }], rowCount: 1 },
      { columns: ["total"], rows: [{ total: 22 }], rowCount: 1 },
    ]);
    expect(out.steps[0].rows).toEqual([{ total: 100 }]); // untouched
    expect(out.steps[1].rows).toEqual([{ total: 11 }]);
    expect(out.steps[2].rows).toEqual([{ total: 22 }]);
  });

  it("records a step that failed this time", () => {
    const out = refreshedTurn(turn(), [{ error: "table gone" }]);
    expect(out.steps[0].error).toBe("table gone");
    expect(out.steps[0].status).toBe("error");
  });
});

describe("what changed, computed rather than narrated", () => {
  it("reports a single-row metric precisely", () => {
    const before = turn();
    const after = refreshedTurn(before, [
      { columns: ["total"], rows: [{ total: 130 }], rowCount: 1 },
    ]);
    const lines = analysisChanges(before, after);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("100 → 130");
    expect(lines[0]).toContain("+30");
    expect(lines[0]).toContain("30.0%");
  });

  it("says nothing when nothing moved", () => {
    const before = turn();
    const after = refreshedTurn(before, [
      { columns: ["total"], rows: [{ total: 100 }], rowCount: 1 },
    ]);
    expect(analysisChanges(before, after)).toEqual([]);
  });

  it("REFUSES a per-row claim on grouped results, reporting the count instead", () => {
    // Matching rows between runs is guesswork; a wrongly matched row produces
    // a fabricated finding that reads exactly like a real one.
    const before = turn({
      steps: [
        step({
          rows: [
            { region: "EMEA", total: 10 },
            { region: "AMER", total: 20 },
          ],
          rowCount: 2,
        }),
      ],
    });
    const after = refreshedTurn(before, [
      {
        columns: ["region", "total"],
        rows: [
          { region: "EMEA", total: 99 },
          { region: "AMER", total: 20 },
          { region: "APAC", total: 5 },
        ],
        rowCount: 3,
      },
    ]);
    const lines = analysisChanges(before, after);
    expect(lines).toEqual(["Headcount: 2 → 3 rows"]);
    expect(lines.join(" ")).not.toContain("EMEA");
  });

  it("stays silent on a grouped result whose row count held", () => {
    const before = turn({
      steps: [
        step({
          rows: [
            { r: "a", t: 1 },
            { r: "b", t: 2 },
          ],
          rowCount: 2,
        }),
      ],
    });
    const after = refreshedTurn(before, [
      {
        columns: ["r", "t"],
        rows: [
          { r: "a", t: 9 },
          { r: "b", t: 8 },
        ],
        rowCount: 2,
      },
    ]);
    expect(analysisChanges(before, after)).toEqual([]);
  });

  it("reports a step that failed", () => {
    const before = turn();
    const after = refreshedTurn(before, [{ error: "permission denied" }]);
    expect(analysisChanges(before, after)[0]).toContain("permission denied");
  });

  it("leaves a percentage out when the previous value was zero", () => {
    const before = turn({ steps: [step({ rows: [{ total: 0 }] })] });
    const after = refreshedTurn(before, [
      { columns: ["total"], rows: [{ total: 5 }], rowCount: 1 },
    ]);
    const line = analysisChanges(before, after)[0];
    expect(line).toContain("0 → 5");
    expect(line).not.toContain("%");
  });
});

describe("saying it in words", () => {
  it("describes each cadence", () => {
    expect(describeSchedule("hourly", 6, 1)).toBe("Every hour, on the hour");
    expect(describeSchedule("daily", 6, 1)).toBe("Every day at 06:00 UTC");
    expect(describeSchedule("weekly", 9, 1)).toBe("Every Monday at 09:00 UTC");
  });

  it("survives an out-of-range weekday or hour rather than printing undefined", () => {
    expect(describeSchedule("weekly", 9, 7)).toContain("Sunday");
    expect(describeSchedule("daily", 99, 0)).toContain("23:00");
  });

  it("says plainly when a run found nothing", () => {
    // A report that only ever arrives with news teaches people that silence
    // means "did not run".
    const d = runDigest("Headcount", []);
    expect(d.title).toContain("Refreshed");
    expect(d.body).toContain("nothing measurable changed");
  });

  it("leads with the changes when there are some", () => {
    const d = runDigest("Headcount", ["total: 100 → 130 (+30, 30.0%)"]);
    expect(d.title).toContain("What changed");
    expect(d.body).toContain("100 → 130");
  });
});

describe("the runner", () => {
  const srv = readFileSync("src/utils/analyst/schedule.server.ts", "utf8");

  it("refreshes the LATEST turn, not an earlier one", () => {
    // Earlier turns are the conversation's history. Re-running one rewrites an
    // answer nobody asked to refresh, and the reader has no way to notice.
    const fn = srv.slice(srv.indexOf("export async function refreshAnalysisServer"));
    const body = fn.slice(0, fn.indexOf("export async function processDueAnalyses"));
    expect(body).toContain("const index = turns.length - 1;");
  });

  it("advances next_run_at whatever happened", () => {
    // Inside the success path, a failing schedule re-runs the same broken
    // query on every tick and never recovers on its own.
    const loop = srv.slice(srv.indexOf("for (const s of due ?? [])"));
    const catchAt = loop.indexOf("} catch (e) {");
    const advanceAt = loop.indexOf("next_run_at: computeNextRun(");
    expect(catchAt).toBeGreaterThan(-1);
    expect(advanceAt).toBeGreaterThan(catchAt);
  });

  it("runs 'Run now' through the same function the scheduler uses", () => {
    // Two paths to the same feature is how a button that works ships beside a
    // schedule that does not.
    const fns = readFileSync("src/utils/analyst.functions.ts", "utf8");
    const runNow = fns.slice(fns.indexOf("export const analystRunNow"));
    expect(runNow).toContain("refreshAnalysisServer(data.thread_id)");
    expect(runNow).toContain("Only the author can refresh this analysis");
  });

  it("re-runs pinned SQL without calling a model", () => {
    // The whole point: no re-planning, so consecutive runs stay comparable —
    // and no 6am dependency on someone else's inference uptime.
    expect(srv).toContain("pinnedSteps(before)");
    expect(srv).not.toMatch(/runAnalystTurn|generateSql|\/api\/bi/);
  });
});
