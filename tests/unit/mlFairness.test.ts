// Comparing how a model treats groups.
//
// The expected numbers come from tests/fixtures/fairnessMetrics.json, computed
// by pandas groupby in tests/fixtures/fairnessMetrics.gen.py — a different
// implementation by a different route. The arithmetic here is simple enough
// that checking it against my own arithmetic would prove only that it equals
// itself, and these numbers can end up in a compliance report.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FOUR_FIFTHS,
  MIN_GROUP_FOR_VERDICT,
  fairnessResult,
  fairnessVerdict,
  groupOutcomeSql,
  selectionSql,
  validateFairnessConfig,
  type MlGroupCount,
  type MlGroupOutcome,
} from "@/lib/mlFairness";

const ORACLE = JSON.parse(readFileSync("tests/fixtures/fairnessMetrics.json", "utf8")) as {
  cases: {
    name: string;
    favourable: string;
    counts: MlGroupCount[];
    outcomes: MlGroupOutcome[];
    expected: {
      groups: {
        group: string;
        n: number;
        selection_rate: number | null;
        true_positive_rate: number | null;
        false_positive_rate: number | null;
        accuracy: number | null;
      }[];
      disparate_impact: number | null;
      equal_opportunity_gap: number | null;
      lowest_group: string | null;
    };
  }[];
};

const scored = { schema: "ml", table: "scored" };
const outcome = {
  schema: "analytics",
  table: "decisions",
  key_columns: ["application_id"],
  outcome_column: "final_decision",
};

describe("the numbers agree with an independent implementation", () => {
  it("has fixtures, so an empty file cannot pass", () => {
    expect(ORACLE.cases.length).toBeGreaterThanOrEqual(4);
  });

  it.each(ORACLE.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const got = fairnessResult("region", c.counts, c.outcomes, c.favourable);
    expect(got.groups.length).toBe(c.expected.groups.length);
    for (const want of c.expected.groups) {
      const mine = got.groups.find((g) => g.group === want.group);
      expect(mine, `group ${want.group} is missing`).toBeTruthy();
      expect(mine!.n).toBe(want.n);
      for (const k of [
        "selection_rate",
        "true_positive_rate",
        "false_positive_rate",
        "accuracy",
      ] as const) {
        if (want[k] === null) expect(mine![k], `${want.group}.${k}`).toBeNull();
        else expect(mine![k], `${want.group}.${k}`).toBeCloseTo(want[k]!, 10);
      }
    }
    if (c.expected.disparate_impact === null) expect(got.disparate_impact).toBeNull();
    else expect(got.disparate_impact!).toBeCloseTo(c.expected.disparate_impact, 10);
    if (c.expected.equal_opportunity_gap === null) expect(got.equal_opportunity_gap).toBeNull();
    else expect(got.equal_opportunity_gap!).toBeCloseTo(c.expected.equal_opportunity_gap, 10);
    expect(got.lowest_group).toBe(c.expected.lowest_group);
  });

  it("reports both questions, because one hides the other", () => {
    // The case this whole feature exists for: identical selection rates, and
    // the model still far worse at one group. A check that measured only the
    // rate would call this even and be wrong in the way that matters.
    const c = ORACLE.cases.find((x) => x.name === "equal rates, unequal errors")!;
    const got = fairnessResult("region", c.counts, c.outcomes, c.favourable);
    expect(got.disparate_impact!).toBeGreaterThan(FOUR_FIFTHS);
    expect(fairnessVerdict(got, FOUR_FIFTHS)).toBe("even");
    expect(got.equal_opportunity_gap!).toBeGreaterThan(0.2);
  });

  it("reports a small group but never lets it decide", () => {
    // A rate over five people swings 20% when one changes. Judging on that
    // produces alarms out of arithmetic, and one false alarm is enough for
    // somebody to switch the check off for good.
    const c = ORACLE.cases.find((x) => x.name === "tiny group")!;
    const got = fairnessResult("region", c.counts, c.outcomes, c.favourable);
    expect(got.groups.map((g) => g.group)).toContain("B");
    expect(got.groups.find((g) => g.group === "B")!.n).toBeLessThan(MIN_GROUP_FOR_VERDICT);
    expect(got.disparate_impact, "a 5-row group must not drive the ratio").toBeNull();
    expect(fairnessVerdict(got, FOUR_FIFTHS)).toBe("unmeasurable");
  });

  it("treats an unrecorded value as its own group", () => {
    // "We did not record this" is a group, and often the interesting one.
    const c = ORACLE.cases.find((x) => x.name === "missing group")!;
    const got = fairnessResult("region", c.counts, c.outcomes, c.favourable);
    expect(got.groups.map((g) => g.group)).toContain("(not recorded)");
  });

  it("has nothing to say about one group on its own", () => {
    const c = ORACLE.cases.find((x) => x.name === "single group")!;
    const got = fairnessResult("region", c.counts, c.outcomes, c.favourable);
    expect(got.disparate_impact).toBeNull();
    expect(fairnessVerdict(got, FOUR_FIFTHS)).toBe("unmeasurable");
  });
});

describe("the statements", () => {
  it("counts the favourable prediction per group", () => {
    const sql = selectionSql(scored, "region", "approved");
    expect(sql).toContain("GROUP BY 1");
    expect(sql).toContain("'approved'");
    expect(sql).toMatch(/coalesce\(CAST\("region" AS VARCHAR\), '\(not recorded\)'\)/);
  });

  it("keeps a NULL group instead of dropping it", () => {
    // Dropping it would quietly exclude exactly the people whose attribute
    // nobody collected.
    expect(selectionSql(scored, "region", "approved")).toContain("(not recorded)");
    expect(groupOutcomeSql(scored, outcome, "region", "approved")).toContain("(not recorded)");
  });

  it("asks for no selection rate when no favourable label is named", () => {
    // Which outcome is the good one is a fact about the world. A platform that
    // guessed would put its guess in a compliance report.
    const sql = selectionSql(scored, "region", null);
    expect(sql).toContain("0 AS selected");
  });

  it("escapes a label with a quote in it", () => {
    expect(selectionSql(scored, "region", "it's fine")).toContain("'it''s fine'");
  });

  it("inner-joins the outcomes, like an evaluation does", () => {
    const sql = groupOutcomeSql(scored, outcome, "region", "approved");
    expect(sql).toContain(" JOIN ");
    expect(sql).not.toMatch(/LEFT\s+JOIN/i);
    expect(sql).toContain('a."final_decision" IS NOT NULL');
    expect(sql).toContain('p."application_id" = a."application_id"');
  });

  it("caps the groups, so free text cannot become a report", () => {
    expect(selectionSql(scored, "region", "approved")).toMatch(/LIMIT \d+/);
    expect(groupOutcomeSql(scored, outcome, "region", "approved")).toMatch(/LIMIT \d+/);
  });
});

describe("configuration", () => {
  it("accepts a plain one", () => {
    expect(
      validateFairnessConfig({ sensitive_columns: ["region"], favourable_label: "approved" }),
    ).toBeNull();
  });

  it.each([
    [[], /at least one column/i],
    [["a", "a"], /named twice/i],
    [["drop table x"], /not a column name/i],
  ])("refuses %j", (cols, why) => {
    expect(
      validateFairnessConfig({ sensitive_columns: cols as string[], favourable_label: null }),
    ).toMatch(why);
  });
});

describe("the word attached to a ratio", () => {
  it("says review rather than unfair, because that is not a computable fact", () => {
    const r = {
      column: "region",
      groups: [],
      disparate_impact: 0.5,
      equal_opportunity_gap: null,
      lowest_group: "B",
    };
    expect(fairnessVerdict(r, FOUR_FIFTHS)).toBe("review");
    expect(fairnessVerdict({ ...r, disparate_impact: 0.9 }, FOUR_FIFTHS)).toBe("even");
    expect(fairnessVerdict({ ...r, disparate_impact: null }, FOUR_FIFTHS)).toBe("unmeasurable");
  });

  it("uses four fifths as a default, not as a law", () => {
    expect(FOUR_FIFTHS).toBe(0.8);
    const r = {
      column: "region",
      groups: [],
      disparate_impact: 0.7,
      equal_opportunity_gap: null,
      lowest_group: "B",
    };
    // A deployment may hold itself to more than the guideline.
    expect(fairnessVerdict(r, 0.6)).toBe("even");
    expect(fairnessVerdict(r, 0.9)).toBe("review");
  });
});
