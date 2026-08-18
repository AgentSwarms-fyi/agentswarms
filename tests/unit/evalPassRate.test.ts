// The pass rate an evaluation run may display.
//
// Module 28 of the adversarial pass. MEASURED live with a run holding 0 of 12
// cases scored: the page rendered "0% pass" — a failing grade for work that
// had not been marked — while the avg-score card beside it correctly showed
// "—" for the same run. On a screen whose entire output is a verdict, the
// contradicting half that looked like data was the wrong one.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatPassRate, passRate } from "@/lib/evalPassRate";

describe("passRate", () => {
  it("computes the rate over scored cases", () => {
    expect(passRate(9, 12)).toBe(75);
    expect(passRate(12, 12)).toBe(100);
  });

  it("returns null when nothing has been scored", () => {
    // THE finding: a queued or just-started run has scored nothing, and
    // "nothing scored" is not zero.
    expect(passRate(0, 0)).toBeNull();
  });

  it("keeps a genuine zero sayable", () => {
    // Every scored case failed. That IS 0%, and must not be hidden behind the
    // same "—" the unscored run gets.
    expect(passRate(0, 12)).toBe(0);
  });

  it("refuses a negative or non-finite denominator", () => {
    expect(passRate(3, -1)).toBeNull();
    expect(passRate(3, Number.NaN)).toBeNull();
    expect(passRate(Number.NaN, 12)).toBeNull();
  });

  it("rounds to whole percents", () => {
    expect(passRate(1, 3)).toBe(33);
    expect(passRate(2, 3)).toBe(67);
  });
});

describe("formatPassRate", () => {
  it("renders an em dash for an unscored run", () => {
    expect(formatPassRate(0, 0)).toBe("—");
  });

  it("renders 0% for a run that scored and failed everything", () => {
    expect(formatPassRate(0, 12)).toBe("0%");
  });

  it("renders the percentage for a scored run", () => {
    expect(formatPassRate(9, 12)).toBe("75%");
  });
});

describe("evaluations page wiring (tripwires, limits stated)", () => {
  // Source tripwires, not behavioral proofs: this is a 1,000-line route
  // component driven by three Supabase reads and a live run poller, so
  // exercising it here would test mocks. All three exist because a mutation
  // run showed the exact defect each pins surviving every test above.
  const src = () => readFileSync(resolve("src/routes/_authenticated/evaluations.tsx"), "utf8");

  it("takes formatPassRate from the shared module, not a local redefinition", () => {
    // The mutation that survived redefined it locally with the old
    // `d > 0 ? … : 0` body, keeping every call site intact.
    expect(src()).toMatch(/import \{ formatPassRate \} from "@\/lib\/evalPassRate"/);
    expect(src()).not.toMatch(/const formatPassRate\s*=/);
  });

  it("records the first read error from the three list queries", () => {
    expect(src()).toMatch(/const firstError = d\.error \?\? r\.error \?\? s\.error/);
    expect(src()).toMatch(/setLoadError\(firstError\.message\)/);
  });

  it("shows the error branch above the empty state", () => {
    // JSX renders top-down: the empty claim must be unreachable while an
    // error is held. Same rule as the audit log's ordering tripwire.
    const s = src();
    const errorBranch = s.indexOf("loaded && loadError !== null &&");
    const emptyBranch = s.indexOf("loaded && loadError === null && datasets.length === 0");
    expect(errorBranch, "the error branch is gone").toBeGreaterThan(-1);
    expect(emptyBranch, "the empty state no longer defers to loadError").toBeGreaterThan(-1);
    expect(errorBranch).toBeLessThan(emptyBranch);
  });
});
