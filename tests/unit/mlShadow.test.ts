// Comparing a candidate version against the one in production.
//
// The cases that matter are the ones where a careless comparison would report
// something confidently wrong: a regression compared for exact equality (0%
// agreement on two models nobody could tell apart), a candidate that is
// erroring being praised for the calls it did manage, and a verdict offered on
// a handful of rows.
import { describe, expect, it } from "vitest";

import {
  AGREEMENT_FLOOR,
  MIN_ROWS_FOR_VERDICT,
  REGRESSION_TOLERANCE,
  addComparison,
  agreementRate,
  compareAnswers,
  rowsAgree,
  rowsUntilVerdict,
  shadowVerdict,
  type MlShadowTotals,
} from "@/lib/mlShadow";

const pairs = (xs: [unknown, unknown][]) =>
  xs.map(([primary, candidate]) => ({ primary, candidate }));

describe("a classification either matches or it does not", () => {
  it("counts identical labels as agreement", () => {
    const c = compareAnswers(
      "classification",
      pairs([
        ["a", "a"],
        ["b", "b"],
        ["a", "b"],
      ]),
    );
    expect(c.rows).toBe(3);
    expect(c.agreed).toBe(2);
    expect(c.disagreed).toBe(1);
  });

  it('compares as strings, so 1 and "1" are the same class', () => {
    // The scorer returns whatever the label was in the training data, and a
    // round-trip through JSON does not preserve which of those it was.
    expect(rowsAgree("classification", 1, "1")).toBe(true);
    expect(rowsAgree("classification", "yes", "no")).toBe(false);
  });

  it("reports no mean difference, because the idea does not apply", () => {
    // A zero here would read as "identical" on a pair of labels that differ.
    const c = compareAnswers("classification", pairs([["a", "b"]]));
    expect(c.meanAbsoluteDifference).toBeNull();
  });

  it("keeps a few examples of what differed, not just a count", () => {
    const c = compareAnswers(
      "classification",
      pairs([
        ["a", "b"],
        ["a", "a"],
        ["c", "d"],
      ]),
    );
    expect(c.examples).toEqual([
      { index: 0, primary: "a", candidate: "b" },
      { index: 2, primary: "c", candidate: "d" },
    ]);
  });

  it("and caps them, because this rides on every mirrored request", () => {
    const many = pairs(
      Array.from({ length: 50 }, (_, i) => [`p${i}`, `c${i}`] as [unknown, unknown]),
    );
    expect(compareAnswers("classification", many).examples.length).toBeLessThanOrEqual(5);
  });
});

describe("a regression is compared by how far apart, not whether identical", () => {
  it("treats a negligible difference as agreement", () => {
    // Exact equality would report 0% agreement on two models nobody could
    // tell apart — the single most misleading number this page could show.
    expect(rowsAgree("regression", 100, 100.5)).toBe(true);
    expect(rowsAgree("regression", 100, 120)).toBe(false);
  });

  it("scales with the size of the number", () => {
    // A £2 gap on £4 is a different event from a £2 gap on £40,000.
    expect(rowsAgree("regression", 4, 6)).toBe(false);
    expect(rowsAgree("regression", 40_000, 40_002)).toBe(true);
  });

  it("uses the tolerance it documents", () => {
    const within = 100 * (1 + REGRESSION_TOLERANCE * 0.9);
    const beyond = 100 * (1 + REGRESSION_TOLERANCE * 1.1);
    expect(rowsAgree("regression", 100, within)).toBe(true);
    expect(rowsAgree("regression", 100, beyond)).toBe(false);
  });

  it("does not divide by zero when both are zero", () => {
    expect(rowsAgree("regression", 0, 0)).toBe(true);
    expect(rowsAgree("regression", 0, 1)).toBe(false);
  });

  it("reports the typical gap alongside the count", () => {
    const c = compareAnswers(
      "regression",
      pairs([
        [10, 12],
        [20, 20],
        [30, 34],
      ]),
    );
    expect(c.meanAbsoluteDifference).toBeCloseTo((2 + 0 + 4) / 3, 9);
  });

  it("reads a number that arrived as a string", () => {
    // The answer comes back through JSON from another process.
    expect(rowsAgree("regression", "100", 100)).toBe(true);
  });

  it("but an unreadable answer is NOT agreement", () => {
    // A candidate returning something the primary never would is exactly the
    // case worth catching, so it must not be waved through.
    expect(rowsAgree("regression", 100, null)).toBe(false);
    expect(rowsAgree("regression", 100, "n/a")).toBe(false);
    expect(rowsAgree("regression", 100, NaN)).toBe(false);
  });
});

describe("the verdict waits for enough traffic", () => {
  const base: MlShadowTotals = { requests: 0, rows: 0, agreed: 0, errors: 0 };

  it("says nothing on a handful of rows", () => {
    const v = shadowVerdict({ ...base, requests: 3, rows: 10, agreed: 10 });
    expect(v).toBe("waiting");
    expect(rowsUntilVerdict({ ...base, rows: 10 })).toBe(MIN_ROWS_FOR_VERDICT - 10);
  });

  it("and nothing at all before a single row", () => {
    expect(agreementRate(base)).toBeNull();
    expect(shadowVerdict(base)).toBe("waiting");
  });

  it("agrees once there is enough of it", () => {
    const rows = MIN_ROWS_FOR_VERDICT;
    expect(shadowVerdict({ requests: 20, rows, agreed: rows, errors: 0 })).toBe("agrees");
  });

  it("and differs when the two answer differently often enough", () => {
    const rows = 1000;
    const justUnder = Math.floor(rows * (AGREEMENT_FLOOR - 0.01));
    expect(shadowVerdict({ requests: 50, rows, agreed: justUnder, errors: 0 })).toBe("differs");
    const justOver = Math.ceil(rows * AGREEMENT_FLOOR);
    expect(shadowVerdict({ requests: 50, rows, agreed: justOver, errors: 0 })).toBe("agrees");
  });
});

describe("a failing candidate is not a well-agreeing one", () => {
  it("outranks agreement, however good the calls it managed were", () => {
    // Reporting 100% agreement on the requests it did answer, while it fails
    // one in five, is the most misleading thing this page could say.
    const v = shadowVerdict({ requests: 100, rows: 1000, agreed: 1000, errors: 20 });
    expect(v).toBe("failing");
  });

  it("tolerates the occasional blip rather than crying wolf", () => {
    // One failure in a hundred requests is a restart, not a broken model.
    const v = shadowVerdict({ requests: 100, rows: 1000, agreed: 1000, errors: 1 });
    expect(v).toBe("agrees");
  });

  it("and a single failure out of one request IS the whole story", () => {
    expect(shadowVerdict({ requests: 1, rows: 0, agreed: 0, errors: 1 })).toBe("failing");
  });
});

describe("running totals", () => {
  const base: MlShadowTotals = { requests: 0, rows: 0, agreed: 0, errors: 0 };

  it("add a comparison without re-deriving from history", () => {
    const one = addComparison(
      base,
      compareAnswers(
        "classification",
        pairs([
          ["a", "a"],
          ["a", "b"],
        ]),
      ),
    );
    expect(one).toEqual({ requests: 1, rows: 2, agreed: 1, errors: 0 });
    const two = addComparison(one, compareAnswers("classification", pairs([["x", "x"]])));
    expect(two).toEqual({ requests: 2, rows: 3, agreed: 2, errors: 0 });
    expect(agreementRate(two)).toBeCloseTo(2 / 3, 9);
  });

  it("a failed mirror counts as a request and an error, not as rows", () => {
    // Counting it as zero agreed rows would drag the agreement rate down and
    // report a DISAGREEMENT, which is a different thing from an outage.
    const t = addComparison({ requests: 5, rows: 50, agreed: 50, errors: 0 }, null);
    expect(t).toEqual({ requests: 6, rows: 50, agreed: 50, errors: 1 });
    expect(agreementRate(t)).toBe(1);
  });

  it("and never mutates what it was given", () => {
    const before = { ...base };
    addComparison(base, compareAnswers("classification", pairs([["a", "a"]])));
    expect(base).toEqual(before);
  });
});
