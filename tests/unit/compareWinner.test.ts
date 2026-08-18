// Who may be crowned "best" in the Prompt Compare table.
//
// Module 27 of the adversarial pass. MEASURED with three panels — two
// answering (2.0s, 2.7s) and one failing fast (0.1s, no content) — the FAILED
// model was highlighted green as the Response-time winner. A request that
// errors still records a duration, so failing quickly beat answering
// correctly, on a page built to help someone choose a model.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { comparisonCaveat, winnerIndex } from "@/lib/compareWinner";

const ok = (value: number | null) => ({ answered: true, value });
const failed = (value: number | null) => ({ answered: false, value });

describe("winnerIndex", () => {
  it("crowns the lowest value among panels that answered", () => {
    expect(winnerIndex([ok(2000), ok(2700), ok(1500)])).toBe(2);
  });

  it("never crowns a panel that did not answer, however fast it failed", () => {
    // THE finding: 0.1s of failure must not beat 2.0s of answering.
    expect(winnerIndex([ok(2000), ok(2700), failed(100)])).toBe(0);
  });

  it("ignores panels whose value could not be measured", () => {
    expect(winnerIndex([ok(null), ok(2700), ok(1500)])).toBe(2);
  });

  it("declares no winner when only one panel is comparable", () => {
    // A field of one has no winner: highlighting it presents "the only
    // measurable value" as "the best value".
    expect(winnerIndex([ok(2000), failed(100), ok(null)])).toBe(-1);
    expect(winnerIndex([ok(2000)])).toBe(-1);
  });

  it("declares no winner when nothing answered", () => {
    expect(winnerIndex([failed(100), failed(50)])).toBe(-1);
    expect(winnerIndex([])).toBe(-1);
  });

  it("breaks ties toward the first panel, deterministically", () => {
    expect(winnerIndex([ok(2000), ok(2000)])).toBe(0);
  });
});

describe("comparisonCaveat", () => {
  it("says nothing when every panel took part", () => {
    expect(comparisonCaveat([ok(2000), ok(2700)])).toBeNull();
  });

  it("names how many did not answer", () => {
    expect(comparisonCaveat([ok(2000), ok(2700), failed(100)])).toBe(
      "ranking excludes 1 did not answer",
    );
  });

  it("names how many answered but reported no figure", () => {
    expect(comparisonCaveat([ok(2000), ok(null)])).toBe("ranking excludes 1 reported no figure");
  });

  it("reports both kinds of exclusion together", () => {
    expect(comparisonCaveat([ok(2000), ok(null), failed(100)])).toBe(
      "ranking excludes 1 did not answer and 1 reported no figure",
    );
  });
});

describe("the page's answered predicate (tripwire)", () => {
  // Source tripwire, not a behavioral proof: ComparisonStats is a route-local
  // component fed by three live streaming panels, so exercising it here would
  // test mocks. It exists because a mutation run showed `answered = () => true`
  // — which restores the finding exactly — surviving every test above.
  it("treats an errored or empty panel as not having answered", () => {
    const src = readFileSync(resolve("src/routes/_authenticated/prompt-compare.tsx"), "utf8");
    expect(src).toMatch(
      /const answered = \(p: PanelState\) =>\s*!p\.error && p\.content\.trim\(\)\.length > 0/,
    );
    // and the winners must be computed through the helper, not a raw minIdx
    expect(src).toMatch(/winnerIndex\(/);
  });
});
