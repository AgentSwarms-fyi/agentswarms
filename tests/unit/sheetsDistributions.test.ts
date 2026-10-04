// The distributions a grid answered #NAME? for (R262), each checked against a
// closed form, an identity or a round trip — computed here, so no check rests
// on a remembered decimal. Three were NOT taken from formula.js because it
// gets them wrong: GAMMA (off in the ninth digit), the legacy LOGNORMDIST (it
// answered the density; Excel's old function is cumulative) and the legacy
// TINV (it answered -0).
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import type { Value } from "@/lib/sheets/formula/values";

const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells: {} } }]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const n = (f: string): number => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return (Array.isArray(v) ? (v as unknown[][])[0][0] : v) as number;
};
const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
const C = (a: number, b: number) => fact(a) / (fact(b) * fact(a - b));
const TIGHT = 12;

describe("closed forms", () => {
  it("EXPON.DIST and EXPONDIST", () => {
    expect(n("=EXPON.DIST(0.2,10,TRUE)")).toBeCloseTo(1 - Math.exp(-2), TIGHT);
    expect(n("=EXPON.DIST(0.2,10,FALSE)")).toBeCloseTo(10 * Math.exp(-2), TIGHT);
    expect(n("=EXPONDIST(0.2,10,TRUE)")).toBeCloseTo(1 - Math.exp(-2), TIGHT);
  });

  it("POISSON.DIST and POISSON", () => {
    expect(n("=POISSON.DIST(2,5,FALSE)")).toBeCloseTo((Math.exp(-5) * 25) / 2, TIGHT);
    expect(n("=POISSON.DIST(2,5,TRUE)")).toBeCloseTo(Math.exp(-5) * (1 + 5 + 12.5), TIGHT);
    expect(n("=POISSON(2,5,TRUE)")).toBeCloseTo(Math.exp(-5) * (1 + 5 + 12.5), TIGHT);
  });

  it("WEIBULL.DIST", () => {
    expect(n("=WEIBULL.DIST(105,20,100,TRUE)")).toBeCloseTo(
      1 - Math.exp(-Math.pow(1.05, 20)),
      TIGHT,
    );
    expect(n("=WEIBULL(105,20,100,TRUE)")).toBeCloseTo(1 - Math.exp(-Math.pow(1.05, 20)), TIGHT);
  });

  it("HYPGEOM.DIST and NEGBINOM.DIST are counting", () => {
    const pmf = (C(8, 1) * C(12, 3)) / C(20, 4);
    expect(n("=HYPGEOM.DIST(1,4,8,20,FALSE)")).toBeCloseTo(pmf, TIGHT);
    expect(n("=HYPGEOMDIST(1,4,8,20)")).toBeCloseTo(pmf, TIGHT);
    const nb = C(14, 4) * Math.pow(0.25, 5) * Math.pow(0.75, 10);
    expect(n("=NEGBINOM.DIST(10,5,0.25,FALSE)")).toBeCloseTo(nb, TIGHT);
    expect(n("=NEGBINOMDIST(10,5,0.25)")).toBeCloseTo(nb, TIGHT);
  });

  it("a chi-square with 2 df is an exponential; a gamma with shape 1 too", () => {
    expect(n("=CHISQ.DIST(3,2,TRUE)")).toBeCloseTo(1 - Math.exp(-1.5), TIGHT);
    expect(n("=CHISQ.DIST(3,2,FALSE)")).toBeCloseTo(0.5 * Math.exp(-1.5), TIGHT);
    expect(n("=CHISQ.DIST.RT(3,2)")).toBeCloseTo(Math.exp(-1.5), TIGHT);
    expect(n("=CHIDIST(3,2)")).toBeCloseTo(Math.exp(-1.5), TIGHT);
    expect(n("=GAMMA.DIST(2,1,3,TRUE)")).toBeCloseTo(1 - Math.exp(-2 / 3), TIGHT);
    expect(n("=GAMMADIST(2,1,3,TRUE)")).toBeCloseTo(1 - Math.exp(-2 / 3), TIGHT);
  });

  it("BETA.DIST, F.DIST and LOGNORM.DIST by identity", () => {
    expect(n("=BETA.DIST(0.3,1,1,TRUE)")).toBeCloseTo(0.3, TIGHT); // uniform
    expect(n("=BETA.DIST(0.5,2,3,FALSE)")).toBeCloseTo(12 * 0.5 * 0.25, TIGHT); // x(1-x)^2 / B(2,3)
    expect(n("=BETADIST(2,8,10,1,3)")).toBeCloseTo(n("=BETA.DIST(0.5,8,10,TRUE)"), TIGHT); // rescaled to [1,3]
    // NOT symmetric about the middle of [1,3]: the case above came out right
    // with formula.js's BETADIST by coincidence, reading 1 as the cumulative
    // flag and 3 as the lower bound. This one does not.
    expect(n("=BETADIST(2.5,8,10,1,3)")).toBeCloseTo(n("=BETA.DIST(0.75,8,10,TRUE)"), TIGHT);
    expect(n("=F.DIST(1,2,2,TRUE)")).toBeCloseTo(0.5, TIGHT); // x / (1 + x) when d1 = d2 = 2
    expect(n("=F.DIST.RT(1,2,2)")).toBeCloseTo(0.5, TIGHT);
    expect(n("=FDIST(1,2,2)")).toBeCloseTo(0.5, TIGHT);
    expect(n("=LOGNORM.DIST(EXP(1),1,1,TRUE)")).toBeCloseTo(0.5, TIGHT); // ln x at the mean
  });

  it("the small ones", () => {
    expect(n("=FISHER(0.5)")).toBeCloseTo(0.5 * Math.log(3), TIGHT);
    expect(n("=FISHERINV(FISHER(0.5))")).toBeCloseTo(0.5, TIGHT);
    expect(n("=PHI(0)")).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), TIGHT);
    expect(n("=GAUSS(0)")).toBe(0);
    expect(n("=STANDARDIZE(42,40,1.5)")).toBeCloseTo(2 / 1.5, TIGHT);
    expect(n("=COMBINA(4,3)")).toBe(C(6, 3));
    expect(n("=PERMUTATIONA(3,2)")).toBe(9);
    expect(n("=GAMMALN(5)")).toBeCloseTo(Math.log(24), TIGHT);
    expect(n("=GAMMALN.PRECISE(5)")).toBeCloseTo(Math.log(24), TIGHT);
  });
});

describe("inverses go back where they came from", () => {
  it.each([
    ["CHISQ.INV(CHISQ.DIST(3,4,TRUE),4)", 3],
    ["CHISQ.INV.RT(CHISQ.DIST.RT(3,4),4)", 3],
    ["CHIINV(CHIDIST(3,4),4)", 3],
    ["GAMMA.INV(GAMMA.DIST(2.5,2,3,TRUE),2,3)", 2.5],
    ["GAMMAINV(GAMMA.DIST(2.5,2,3,TRUE),2,3)", 2.5],
    ["BETA.INV(BETA.DIST(0.4,2,3,TRUE),2,3)", 0.4],
    ["BETAINV(BETA.DIST(0.4,2,3,TRUE),2,3)", 0.4],
    ["F.INV(F.DIST(1.7,5,9,TRUE),5,9)", 1.7],
    ["F.INV.RT(F.DIST.RT(1.7,5,9),5,9)", 1.7],
    ["FINV(FDIST(1.7,5,9),5,9)", 1.7],
    ["LOGNORM.INV(LOGNORM.DIST(4,1.2,0.5,TRUE),1.2,0.5)", 4],
    ["LOGINV(LOGNORM.DIST(4,1.2,0.5,TRUE),1.2,0.5)", 4],
  ])("%s", (f, x) => {
    expect(n(`=${f}`)).toBeCloseTo(x, 9);
  });

  it("T.INV: with 2 df the CDF is 1/2 + t / (2 sqrt(t^2 + 2)), so 0.75 is sqrt(2/3)", () => {
    expect(n("=T.INV(0.75,2)")).toBeCloseTo(Math.sqrt(2 / 3), TIGHT);
    expect(n("=T.INV.2T(0.5,2)")).toBeCloseTo(Math.sqrt(2 / 3), TIGHT);
    // formula.js's own TINV answered -0 here.
    expect(n("=TINV(0.5,2)")).toBeCloseTo(Math.sqrt(2 / 3), TIGHT);
  });

  it("BINOM.INV: the smallest k whose CDF reaches 0.75 (CDF(3) = 42/64, CDF(4) = 57/64)", () => {
    expect(n("=BINOM.INV(6,0.5,0.75)")).toBe(4);
    expect(n("=CRITBINOM(6,0.5,0.75)")).toBe(4);
  });

  it("CONFIDENCE: the half-width z * sd / sqrt(n)", () => {
    const z = n("=NORM.S.INV(0.975)");
    expect(n("=CONFIDENCE.NORM(0.05,2.5,50)")).toBeCloseTo((z * 2.5) / Math.sqrt(50), TIGHT);
    expect(n("=CONFIDENCE(0.05,2.5,50)")).toBeCloseTo((z * 2.5) / Math.sqrt(50), TIGHT);
    expect(n("=CONFIDENCE.T(0.05,1,50)")).toBeCloseTo(
      n("=T.INV.2T(0.05,49)") / Math.sqrt(50),
      TIGHT,
    );
  });
});

describe("where formula.js was wrong", () => {
  it("GAMMA to the last digit: Gamma(1/2) is the square root of pi", () => {
    // Twelve places: exp(GAMMALN) is good to ~1e-13; formula.js's GAMMA was
    // off by 5e-9 (1.7724538559), which this fails by four orders of magnitude.
    expect(n("=GAMMA(0.5)")).toBeCloseTo(Math.sqrt(Math.PI), 12);
    expect(n("=GAMMA(5)")).toBeCloseTo(24, 12);
    expect(n("=GAMMA(-0.5)")).toBeCloseTo(-2 * Math.sqrt(Math.PI), 12); // reflection
    expect(plain(e.evaluateAt("s", 9, 9, "=GAMMA(-1)", { array: true }))).toEqual({
      err: "#NUM!",
    });
  });

  it("the legacy LOGNORMDIST is cumulative, as Excel's is", () => {
    // formula.js answered the density, 0.186.
    expect(n("=LOGNORMDIST(4,1.2,0.5)")).toBeCloseTo(n("=LOGNORM.DIST(4,1.2,0.5,TRUE)"), TIGHT);
    expect(n("=LOGNORMDIST(4,1.2,0.5)")).toBeGreaterThan(0.6);
  });
});
