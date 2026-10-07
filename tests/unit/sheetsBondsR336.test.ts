// Bond prices, yields and durations, accrued interest, odd periods and
// French depreciation (R336).
//
// FOUND IN R329's inventory: PRICE, YIELD, DURATION, MDURATION, ACCRINT,
// ODDFPRICE, ODDFYIELD, ODDLPRICE, ODDLYIELD, AMORDEGRC and AMORLINC were
// #NAME?. Each page's example (fetched verbatim from Microsoft's support site
// in R335) is a test. Where the pages leave a choice they settle it: DURATION
// times each cash flow from DSC/E, giving the page's 10.9191453, where the form
// LibreOffice uses (from YEARFRAC) gives 10.92157.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS, LIFTS } from "@/lib/sheets/formula/functions";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells: {} } }]);
const at = (f: string) => {
  const v = e.evaluateAt("s", 9, 9, f, { array: true }) as unknown;
  const one = Array.isArray(v) && v.length === 1 && v[0].length === 1 ? v[0][0] : v;
  return one && typeof one === "object" && "err" in (one as object)
    ? { err: (one as { err: string }).err }
    : one;
};
const near = (got: unknown, want: number, rel = 1e-9) => {
  expect(typeof got, JSON.stringify(got)).toBe("number");
  expect(Math.abs((got as number) / want - 1)).toBeLessThan(rel);
};

const NEW = [
  ...["PRICE", "YIELD", "DURATION", "MDURATION", "ACCRINT", "ODDFPRICE", "ODDFYIELD", "ODDLPRICE"],
  ...["ODDLYIELD", "AMORDEGRC", "AMORLINC"],
];

describe("each is known, has help, lifts, and goes into a file as it is", () => {
  it.each(NEW)("%s", (name) => {
    expect(FUNCTIONS[name]).toBeTypeOf("function");
    expect(FUNCTION_HELP[name]?.sig.startsWith(`${name}(`)).toBe(true);
    expect(FUNCTION_HELP[name]?.cat).toBe("Financial");
    expect(LIFTS.has(name)).toBe(true);
  });
  it("from Excel's Analysis ToolPak, with no _xlfn.", () => {
    expect(toFileFormula("=PRICE(A1,A2,0.05,0.06,100,2)+DURATION(A1,A2,0.05,0.06,2)")).toBe(
      "PRICE(A1,A2,0.05,0.06,100,2)+DURATION(A1,A2,0.05,0.06,2)",
    );
  });
});

describe("PRICE and YIELD", () => {
  it("the pages' examples", () => {
    // PRICE: $94.63 on the page.
    near(
      at("=PRICE(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 0.065, 100, 2, 0)"),
      94.63436162132213,
    );
    // YIELD: 0.065 on the page.
    near(at("=YIELD(DATE(2008,2,15), DATE(2016,11,15), 0.0575, 95.04287, 100, 2, 0)"), 0.065, 1e-6);
  });

  it("undo each other, over many periods and over one", () => {
    for (const [s, m] of [
      ["DATE(2008,2,15)", "DATE(2017,11,15)"],
      ["DATE(2008,2,15)", "DATE(2008,6,15)"],
      ["DATE(2010,12,31)", "DATE(2030,6,30)"],
    ])
      for (const b of [0, 1, 2, 3, 4]) {
        const pr = at(`=PRICE(${s}, ${m}, 0.0575, 0.065, 100, 2, ${b})`) as number;
        near(at(`=YIELD(${s}, ${m}, 0.0575, ${pr}, 100, 2, ${b})`), 0.065, 1e-10);
      }
  });

  it("one period to go is the page's simple-interest form", () => {
    // Settlement 15 Feb, maturity 15 Jun, semiannual 30/360: A 60, E 180.
    const c = (100 * 0.0575) / 2;
    const want = (c + 100) / ((0.065 / 2) * (120 / 180) + 1) - (c * 60) / 180;
    near(at("=PRICE(DATE(2008,2,15), DATE(2008,6,15), 0.0575, 0.065, 100, 2, 0)"), want);
  });

  it("a price above par is a yield below the coupon", () => {
    expect(
      at("=YIELD(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 105, 100, 2, 0)") as number,
    ).toBeLessThan(0.0575);
  });

  it.each([
    ["=PRICE(DATE(2008,2,15), DATE(2017,11,15), 0.0575, -0.01, 100, 2, 0)", "#NUM!"],
    ["=PRICE(DATE(2008,2,15), DATE(2017,11,15), -0.01, 0.065, 100, 2, 0)", "#NUM!"],
    ["=PRICE(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 0.065, 0, 2, 0)", "#NUM!"],
    ["=PRICE(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 0.065, 100, 3, 0)", "#NUM!"],
    ["=PRICE(DATE(2017,11,15), DATE(2008,2,15), 0.0575, 0.065, 100, 2, 0)", "#NUM!"],
    ["=YIELD(DATE(2008,2,15), DATE(2016,11,15), 0.0575, 0, 100, 2, 0)", "#NUM!"],
    ["=YIELD(DATE(2008,2,15), DATE(2016,11,15), -0.01, 95, 100, 2, 0)", "#NUM!"],
    ["=YIELD(DATE(2008,2,15), DATE(2016,11,15), 0.0575, 95, 100, 2, 5)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("DURATION and MDURATION", () => {
  it("the pages' examples", () => {
    // DURATION: 10.9191453 on the page.
    near(at("=DURATION(DATE(2018,7,1), DATE(2048,1,1), 0.08, 0.09, 2, 1)"), 10.9191453, 1e-8);
    // MDURATION: 5.736 on the page.
    near(at("=MDURATION(DATE(2008,1,1), DATE(2016,1,1), 0.08, 0.09, 2, 1)"), 5.735669813918838);
  });

  it("settling mid-period, each cash flow is DSC/E periods on", () => {
    // Both pages settle on a coupon date, where DSC/E is 1. From an independent
    // model of the same equation (scratch r336_model.py), not this code.
    near(
      at("=DURATION(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 0.065, 2, 0)"),
      7.416484696350572,
    );
  });

  it("MDURATION is DURATION over 1 + yld/frequency", () => {
    const d = at("=DURATION(DATE(2008,1,1), DATE(2016,1,1), 0.08, 0.09, 2, 1)") as number;
    near(at("=MDURATION(DATE(2008,1,1), DATE(2016,1,1), 0.08, 0.09, 2, 1)"), d / 1.045);
  });

  it("a zero-coupon bond's duration is its time to maturity", () => {
    // Ten years, 30/360, settlement on a coupon date.
    near(at("=DURATION(DATE(2010,1,1), DATE(2020,1,1), 0, 0.05, 2, 0)"), 10);
  });

  it.each([
    ["=DURATION(DATE(2018,7,1), DATE(2048,1,1), -0.08, 0.09, 2, 1)", "#NUM!"],
    ["=MDURATION(DATE(2008,1,1), DATE(2016,1,1), 0.08, -0.09, 2, 1)", "#NUM!"],
    ["=DURATION(DATE(2048,1,1), DATE(2018,7,1), 0.08, 0.09, 2, 1)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("ACCRINT", () => {
  const rest = "DATE(2008,8,31), DATE(2008,5,1), 0.1, 1000, 2, 0";
  it.each([
    [`=ACCRINT(DATE(2008,3,1), ${rest})`, 16.666667],
    [`=ACCRINT(DATE(2008,3,5), ${rest}, FALSE)`, 15.555556],
    [`=ACCRINT(DATE(2008,4,5), ${rest}, TRUE)`, 7.2222222],
  ])("the page's %s is %s", (f, want) => {
    expect(at(f)).toBeCloseTo(want, 6);
  });

  it("from issue, or with FALSE from the last coupon before settlement", () => {
    // Settlement 1 Nov 2008, past the first interest date: TRUE accrues from 1 March,
    // FALSE from the 31 August coupon. 30/360, semiannual, $1,000 at 10%.
    const t = "DATE(2008,3,1), DATE(2008,8,31), DATE(2008,11,1), 0.1, 1000, 2, 0";
    // The page's sum over quasi-coupon periods: 1 March to 31 August is a whole
    // period (180 of 180 days in US 30/360), then 61 of the next 180. LibreOffice
    // takes YEARFRAC instead, 240/360, and gives 66.667 here.
    near(at(`=ACCRINT(${t})`), ((1000 * 0.1) / 2) * (180 / 180 + 61 / 180));
    near(at(`=ACCRINT(${t}, FALSE)`), (1000 * 0.1 * 61) / 360);
  });

  it("par left out is $1,000", () => {
    expect(
      at("=ACCRINT(DATE(2008,3,1), DATE(2008,8,31), DATE(2008,5,1), 0.1, , 2, 0)"),
    ).toBeCloseTo(16.666667, 6);
  });

  it.each([
    ["=ACCRINT(DATE(2008,5,1), DATE(2008,8,31), DATE(2008,5,1), 0.1, 1000, 2, 0)", "#NUM!"],
    ["=ACCRINT(DATE(2008,3,1), DATE(2008,8,31), DATE(2008,5,1), 0, 1000, 2, 0)", "#NUM!"],
    ["=ACCRINT(DATE(2008,3,1), DATE(2008,8,31), DATE(2008,5,1), 0.1, 1000, 3, 0)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("odd first and last periods", () => {
  const first = "DATE(2008,11,11), DATE(2021,3,1), DATE(2008,10,15), DATE(2009,3,1)";
  it("the pages' examples", () => {
    // ODDFPRICE: $113.60 on the page.
    near(at(`=ODDFPRICE(${first}, 0.0785, 0.0625, 100, 2, 1)`), 113.59771747407883);
    // ODDFYIELD: 0.0772 on the page.
    near(at(`=ODDFYIELD(${first}, 0.0575, 84.5, 100, 2, 0)`), 0.0772, 1e-3);
    // ODDLPRICE: $99.88 on the page.
    near(
      at(
        "=ODDLPRICE(DATE(2008,2,7), DATE(2008,6,15), DATE(2007,10,15), 0.0375, 0.0405, 100, 2, 0)",
      ),
      99.87828601472134,
    );
    // ODDLYIELD: 0.04519 on the page.
    near(
      at(
        "=ODDLYIELD(DATE(2008,4,20), DATE(2008,6,15), DATE(2007,12,24), 0.0375, 99.875, 100, 2, 0)",
      ),
      0.04519,
      1e-3,
    );
  });

  it("each yield undoes its price", () => {
    const pr = at(`=ODDFPRICE(${first}, 0.0575, 0.0772, 100, 2, 0)`) as number;
    near(at(`=ODDFYIELD(${first}, 0.0575, ${pr}, 100, 2, 0)`), 0.0772, 1e-10);
    const lp = at(
      "=ODDLPRICE(DATE(2008,4,20), DATE(2008,6,15), DATE(2007,12,24), 0.0375, 0.05, 100, 2, 1)",
    ) as number;
    near(
      at(
        `=ODDLYIELD(DATE(2008,4,20), DATE(2008,6,15), DATE(2007,12,24), 0.0375, ${lp}, 100, 2, 1)`,
      ),
      0.05,
      1e-10,
    );
  });

  it("a long first period counts the whole quasi periods to the first coupon", () => {
    // Issued 1 March 2008, settled 1 April, first coupon 1 March 2009: two quasi
    // periods, settlement one whole period before the coupon. From the independent
    // model of the page's long-first equation.
    near(
      at(
        "=ODDFPRICE(DATE(2008,4,1), DATE(2021,3,1), DATE(2008,3,1), DATE(2009,3,1), 0.0785, 0.0625, 100, 2, 1)",
      ),
      113.91375287250213,
    );
  });

  it("a long first period meets the short one where they join", () => {
    // Issued exactly one period before the first coupon (short), and a day earlier (long).
    const short = at(
      "=ODDFPRICE(DATE(2008,11,11), DATE(2021,3,1), DATE(2008,9,1), DATE(2009,3,1), 0.0785, 0.0625, 100, 2, 1)",
    ) as number;
    const long = at(
      "=ODDFPRICE(DATE(2008,11,11), DATE(2021,3,1), DATE(2008,8,31), DATE(2009,3,1), 0.0785, 0.0625, 100, 2, 1)",
    ) as number;
    expect(Math.abs(short - long)).toBeLessThan(0.01);
  });

  it.each([
    // The dates must run issue, settlement, first coupon, maturity.
    [
      "=ODDFPRICE(DATE(2009,4,1), DATE(2021,3,1), DATE(2008,10,15), DATE(2009,3,1), 0.0785, 0.0625, 100, 2, 1)",
      "#NUM!",
    ],
    [
      "=ODDFPRICE(DATE(2008,10,1), DATE(2021,3,1), DATE(2008,10,15), DATE(2009,3,1), 0.0785, 0.0625, 100, 2, 1)",
      "#NUM!",
    ],
    [
      "=ODDFYIELD(DATE(2008,11,11), DATE(2021,3,1), DATE(2008,10,15), DATE(2009,3,1), 0.0575, 0, 100, 2, 0)",
      "#NUM!",
    ],
    [
      "=ODDLPRICE(DATE(2007,10,1), DATE(2008,6,15), DATE(2007,10,15), 0.0375, 0.0405, 100, 2, 0)",
      "#NUM!",
    ],
    [
      "=ODDLYIELD(DATE(2008,4,20), DATE(2008,6,15), DATE(2007,12,24), -0.01, 99.875, 100, 2, 0)",
      "#NUM!",
    ],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("French depreciation", () => {
  const asset = "2400, DATE(2008,8,19), DATE(2008,12,31), 300";
  it("the pages' examples", () => {
    expect(at(`=AMORDEGRC(${asset}, 1, 0.15, 1)`)).toBe(776);
    expect(at(`=AMORLINC(${asset}, 1, 0.15, 1)`)).toBe(360);
  });

  it("period 0 is the first period, prorated over its year fraction", () => {
    // 134 days of 2008's 366, at 2.5 × 15% (AMORDEGRC, rounded) or 15% (AMORLINC).
    expect(at(`=AMORDEGRC(${asset}, 0, 0.15, 1)`)).toBe(330);
    near(at(`=AMORLINC(${asset}, 0, 0.15, 1)`), (2400 * 0.15 * 134) / 366);
  });

  it("AMORLINC depreciates the cost less the salvage, and no more", () => {
    near(at(`=SUM(AMORLINC(${asset}, {0,1,2,3,4,5,6,7,8}, 0.15, 1))`), 2100);
    expect(at(`=AMORLINC(${asset}, 7, 0.15, 1)`)).toBe(0);
  });

  it.each([
    // A life (1/rate) the page refuses: 0 to 3 years, or 4 to 5.
    [`=AMORDEGRC(${asset}, 1, 0.45, 1)`, "#NUM!"],
    [`=AMORDEGRC(${asset}, 1, 0.22, 1)`, "#NUM!"],
    // The AMOR functions have no basis 2.
    [`=AMORDEGRC(${asset}, 1, 0.15, 2)`, "#NUM!"],
    [`=AMORLINC(${asset}, 1, 0.15, 2)`, "#NUM!"],
    [`=AMORLINC(${asset}, 1, 0, 1)`, "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});
