// Securities: coupons, discounts, Treasury bills and fractional dollars
// (R335), and YEARFRAC on the same day counts.
//
// FOUND IN R329's inventory: COUPDAYBS, COUPDAYS, COUPDAYSNC, COUPNCD,
// COUPNUM, COUPPCD, DISC, INTRATE, PRICEDISC, RECEIVED, YIELDDISC, ACCRINTM,
// PRICEMAT, YIELDMAT, TBILLEQ, TBILLPRICE, TBILLYIELD, DOLLARDE and DOLLARFR
// were #NAME?. FOUND IN R335, comparing the new day counts with the YEARFRAC
// already registered (formula.js's) over 3,300 spans: that one ignored
// European 30/360's 31st rule and counted a 366-day year for any span ending
// on January 29th.
//
// The page examples are verbatim from each function's page on Microsoft's
// support site, fetched for this round.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS, LIFTS } from "@/lib/sheets/formula/functions";
import { dateSerial } from "@/lib/sheets/formula/values";
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
/** To 9 significant digits, or exactly when the page prints a whole number. */
const same = (got: unknown, want: number) => {
  expect(typeof got, JSON.stringify(got)).toBe("number");
  if (Number.isInteger(want)) expect(got).toBeCloseTo(want, 9);
  else expect(Math.abs((got as number) / want - 1)).toBeLessThan(1e-9);
};

const NEW = [
  ...["COUPDAYBS", "COUPDAYS", "COUPDAYSNC", "COUPNCD", "COUPNUM", "COUPPCD", "DISC", "INTRATE"],
  ...["PRICEDISC", "RECEIVED", "YIELDDISC", "ACCRINTM", "PRICEMAT", "YIELDMAT", "TBILLEQ"],
  ...["TBILLPRICE", "TBILLYIELD", "DOLLARDE", "DOLLARFR"],
];

describe("each is known, has help, and goes into a file as it is", () => {
  it.each(NEW)("%s", (name) => {
    expect(FUNCTIONS[name]).toBeTypeOf("function");
    expect(FUNCTION_HELP[name]?.sig.startsWith(`${name}(`)).toBe(true);
    expect(FUNCTION_HELP[name]?.cat).toBe("Financial");
    expect(LIFTS.has(name)).toBe(true);
  });
  it("from Excel's Analysis ToolPak, so with no _xlfn.", () => {
    expect(toFileFormula("=COUPNUM(A1,A2,2,1)+TBILLEQ(A1,A2,0.09)")).toBe(
      "COUPNUM(A1,A2,2,1)+TBILLEQ(A1,A2,0.09)",
    );
  });
});

describe("the coupon schedule", () => {
  const terms = "DATE(2011,1,25), DATE(2011,11,15), 2, 1";
  it.each([
    [`=COUPDAYBS(${terms})`, 71],
    [`=COUPDAYS(${terms})`, 181],
    [`=COUPDAYSNC(${terms})`, 110],
    [`=COUPNCD(${terms})`, dateSerial(2011, 5, 15)],
    [`=COUPPCD(${terms})`, dateSerial(2010, 11, 15)],
    ["=COUPNUM(DATE(2007,1,25), DATE(2008,11,15), 2, 1)", 4],
  ])("the page's %s is %s", (f, want) => {
    expect(at(f)).toBe(want);
  });

  it("30/360 counts the same period as 180 days", () => {
    expect(at("=COUPDAYS(DATE(2011,1,25), DATE(2011,11,15), 2, 0)")).toBe(180);
    expect(at("=COUPDAYBS(DATE(2011,1,25), DATE(2011,11,15), 2, 0)")).toBe(70);
    expect(at("=COUPDAYSNC(DATE(2011,1,25), DATE(2011,11,15), 2, 0)")).toBe(110);
    expect(at("=COUPDAYS(DATE(2011,1,25), DATE(2011,11,15), 4, 3)")).toBe(91.25);
  });

  it.each([0, 1, 4])("a period's days are the days before and after settlement (basis %s)", (b) => {
    for (const [s, m] of [
      ["DATE(2011,1,25)", "DATE(2011,11,15)"],
      ["DATE(2008,2,29)", "DATE(2012,8,31)"],
      ["DATE(2010,12,31)", "DATE(2013,6,30)"],
    ]) {
      const t = `${s}, ${m}, 2, ${b}`;
      same(at(`=COUPDAYBS(${t}) + COUPDAYSNC(${t})`), at(`=COUPDAYS(${t})`) as number);
    }
  });

  it("US 30/360 counts a period as DAYS360 does, the 31st after an early day included", () => {
    // DAYS360 was checked against Excel in its own round; COUPDAYBS in US
    // 30/360 is DAYS360 from the previous coupon date.
    for (const s of ["DATE(2011,3,31)", "DATE(2011,1,31)", "DATE(2011,7,31)", "DATE(2011,10,15)"]) {
      const t = `${s}, DATE(2011,11,15), 2, 0`;
      expect(at(`=COUPDAYBS(${t})`), s).toBe(at(`=DAYS360(COUPPCD(${t}), ${s})`));
    }
    expect(at("=COUPDAYBS(DATE(2011,3,31), DATE(2011,11,15), 2, 0)")).toBe(136);
  });

  it("settling on a coupon date at a month's end accrues nothing, in 30/360 too", () => {
    expect(at("=COUPPCD(DATE(2011,2,28), DATE(2011,8,31), 2, 0)")).toBe(dateSerial(2011, 2, 28));
    expect(at("=COUPDAYBS(DATE(2011,2,28), DATE(2011,8,31), 2, 0)")).toBe(0);
    expect(at("=COUPNCD(DATE(2011,2,28), DATE(2011,8,31), 2, 1)")).toBe(dateSerial(2011, 8, 31));
  });

  it("a schedule from a month's last day stays on last days", () => {
    // From August 31st back six months is February 28th, and back again August 31st.
    expect(at("=COUPPCD(DATE(2011,1,25), DATE(2011,8,31), 2, 1)")).toBe(dateSerial(2010, 8, 31));
    expect(at("=COUPNCD(DATE(2011,1,25), DATE(2011,8,31), 2, 1)")).toBe(dateSerial(2011, 2, 28));
    expect(at("=COUPNCD(DATE(2011,9,1), DATE(2012,8,31), 2, 1)")).toBe(dateSerial(2012, 2, 29));
    expect(at("=COUPNUM(DATE(2011,1,25), DATE(2011,8,31), 4, 1)")).toBe(3);
  });

  it.each([
    [`=COUPDAYBS(DATE(2011,1,25), DATE(2011,11,15), 3, 1)`, "#NUM!"],
    [`=COUPDAYBS(DATE(2011,1,25), DATE(2011,11,15), 2, 5)`, "#NUM!"],
    [`=COUPNUM(DATE(2011,11,15), DATE(2011,11,15), 2, 1)`, "#NUM!"],
    [`=COUPNUM(DATE(2011,11,16), DATE(2011,11,15), 2, 1)`, "#NUM!"],
    [`=COUPNUM("soon", DATE(2011,11,15), 2, 1)`, "#VALUE!"],
    [`=COUPNUM(DATE(2011,1,25), DATE(2011,11,15))`, "#N/A"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("truncates its dates, frequency and basis, as the pages say", () => {
    expect(at("=COUPDAYBS(DATE(2011,1,25)+0.9, DATE(2011,11,15)+0.5, 2.9, 1.7)")).toBe(71);
  });
});

describe("the discount family", () => {
  it.each([
    ["=INTRATE(DATE(2008,2,15), DATE(2008,5,15), 1000000, 1014420, 2)", 0.05768],
    ["=PRICEDISC(DATE(2008,2,16), DATE(2008,3,1), 0.0525, 100, 2)", 99.79583333333333],
    ["=RECEIVED(DATE(2008,2,15), DATE(2008,5,15), 1000000, 0.0575, 2)", 1014584.6544071021],
    ["=YIELDDISC(DATE(2008,2,16), DATE(2008,3,1), 99.795, 100, 2)", 0.052822571986860085],
    ["=ACCRINTM(DATE(2008,4,1), DATE(2008,6,15), 0.1, 1000, 3)", 20.54794521],
    [
      "=PRICEMAT(DATE(2008,2,15), DATE(2008,4,13), DATE(2007,11,11), 0.061, 0.061, 0)",
      99.984498875557,
    ],
    [
      "=YIELDMAT(DATE(2008,3,15), DATE(2008,11,3), DATE(2007,11,8), 0.0625, 100.0123, 0)",
      0.060954333691539,
    ],
  ])("the page's %s is %s", (f, want) => {
    expect(Math.abs((at(f) as number) / want - 1)).toBeLessThan(1e-8);
  });

  it("DISC's page prints a result its own dates do not give", () => {
    // The page lists 1 July 2018 to 1 January 2048 and prints 0.001038; those
    // dates give 0.000686, and 0.001038 is what a maturity in 2038 gives.
    same(at("=DISC(DATE(2018,7,1), DATE(2048,1,1), 97.975, 100, 1)"), 0.0006863841691213468);
    same(at("=DISC(DATE(2018,7,1), DATE(2038,1,1), 97.975, 100, 1)"), 0.0010381908237747683);
  });

  it("par and basis may be left out: $1,000 and 30/360", () => {
    // 1 April to 15 June is 74 days in 30/360.
    same(at("=ACCRINTM(DATE(2008,4,1), DATE(2008,6,15), 0.1)"), (1000 * 0.1 * 74) / 360);
  });

  it("DISC and PRICEDISC undo each other, as do INTRATE and RECEIVED", () => {
    const d = at("=DISC(DATE(2008,2,16), DATE(2008,9,1), 97.5, 100, 1)") as number;
    same(at(`=PRICEDISC(DATE(2008,2,16), DATE(2008,9,1), ${d}, 100, 1)`), 97.5);
    const r = at("=INTRATE(DATE(2008,2,15), DATE(2009,5,15), 1000, 1060, 3)") as number;
    expect(r).toBeGreaterThan(0);
  });

  it.each([
    ["=DISC(DATE(2008,2,16), DATE(2008,3,1), 0, 100, 2)", "#NUM!"],
    ["=INTRATE(DATE(2008,2,15), DATE(2008,5,15), 1000000, -1, 2)", "#NUM!"],
    ["=PRICEDISC(DATE(2008,3,1), DATE(2008,2,16), 0.0525, 100, 2)", "#NUM!"],
    ["=RECEIVED(DATE(2008,2,15), DATE(2008,5,15), 1000000, 0.0575, 7)", "#NUM!"],
    ["=ACCRINTM(DATE(2008,6,15), DATE(2008,4,1), 0.1, 1000, 3)", "#NUM!"],
    ["=ACCRINTM(DATE(2008,4,1), DATE(2008,6,15), 0, 1000, 3)", "#NUM!"],
    ["=PRICEMAT(DATE(2008,2,15), DATE(2008,4,13), DATE(2007,11,11), -0.01, 0.061, 0)", "#NUM!"],
    ["=YIELDMAT(DATE(2008,3,15), DATE(2008,11,3), DATE(2007,11,8), 0.0625, 0, 0)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("Treasury bills", () => {
  it.each([
    ["=TBILLEQ(DATE(2008,3,31), DATE(2008,6,1), 0.0914)", 0.09415149356594302],
    ["=TBILLPRICE(DATE(2008,3,31), DATE(2008,6,1), 0.09)", 98.45],
    ["=TBILLYIELD(DATE(2008,3,31), DATE(2008,6,1), 98.45)", 0.09141696292534264],
  ])("the page's %s is %s", (f, want) => {
    same(at(f), want);
  });

  it("TBILLPRICE and TBILLYIELD undo each other", () => {
    const pr = at("=TBILLPRICE(DATE(2008,3,31), DATE(2008,9,1), 0.05)") as number;
    same(
      at(`=TBILLYIELD(DATE(2008,3,31), DATE(2008,9,1), ${pr})`),
      0.05 / (1 - (0.05 * 154) / 360),
    );
  });

  it.each([
    // More than a year after settlement.
    ["=TBILLPRICE(DATE(2008,3,31), DATE(2009,6,1), 0.09)", "#NUM!"],
    ["=TBILLEQ(DATE(2008,3,31), DATE(2009,4,1), 0.09)", "#NUM!"],
    ["=TBILLEQ(DATE(2008,6,1), DATE(2008,3,31), 0.09)", "#NUM!"],
    ["=TBILLPRICE(DATE(2008,3,31), DATE(2008,6,1), 0)", "#NUM!"],
    // TBILLYIELD alone refuses settlement on the maturity date.
    ["=TBILLYIELD(DATE(2008,6,1), DATE(2008,6,1), 98)", "#NUM!"],
    ["=TBILLYIELD(DATE(2008,3,31), DATE(2008,6,1), 0)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("a year to the day is still within a year", () => {
    expect(at("=TBILLPRICE(DATE(2008,3,31), DATE(2009,3,31), 0.01)")).toBeCloseTo(98.986111, 6);
  });
});

describe("fractional dollars", () => {
  it.each([
    ["=DOLLARDE(1.02, 16)", 1.125],
    ["=DOLLARDE(1.1, 32)", 1.3125],
    ["=DOLLARFR(1.125, 16)", 1.02],
    ["=DOLLARFR(1.125, 32)", 1.04],
    ["=DOLLARDE(-1.02, 16)", -1.125],
    ["=DOLLARDE(1.02, 16.9)", 1.125],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toBeCloseTo(want, 12);
  });

  it.each([
    ["=DOLLARDE(1.02, -1)", "#NUM!"],
    ["=DOLLARDE(1.02, 0.5)", "#DIV/0!"],
    ["=DOLLARFR(1.125, 0)", "#DIV/0!"],
    ["=DOLLARFR(1.125, -16)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("DOLLARDE undoes DOLLARFR", () => {
    for (const f of [2, 8, 16, 32, 100])
      expect(at(`=DOLLARDE(DOLLARFR(3.40625, ${f}), ${f})`)).toBeCloseTo(3.40625, 12);
  });
});

describe("YEARFRAC, on the same day counts", () => {
  it.each([
    // The YEARFRAC page's examples.
    ["=YEARFRAC(DATE(2012,1,1), DATE(2012,7,30))", 0.58055556],
    ["=YEARFRAC(DATE(2012,1,1), DATE(2012,7,30), 1)", 0.57650273],
    ["=YEARFRAC(DATE(2012,1,1), DATE(2012,7,30), 3)", 0.57808219],
  ])("the page's %s is %s", (f, want) => {
    expect(at(f)).toBeCloseTo(want, 8);
  });

  it("FOUND IN R335: a 31st is the 30th in European 30/360", () => {
    same(at("=YEARFRAC(DATE(2009,1,1), DATE(2009,12,31), 4)"), 359 / 360);
    same(at("=YEARFRAC(DATE(2007,8,2), DATE(2007,10,31), 4)"), 88 / 360);
    // The US count keeps a 31st after a day before the 30th.
    same(at("=YEARFRAC(DATE(2009,1,1), DATE(2009,12,31), 0)"), 1);
  });

  it("FOUND IN R335: a span ending on January 29th has no leap day", () => {
    same(at("=YEARFRAC(DATE(2009,1,1), DATE(2009,1,29), 1)"), 28 / 365);
    same(at("=YEARFRAC(DATE(2007,1,29), DATE(2008,1,29), 1)"), 1);
  });

  it("counts a February 29th in the span, and averages years past one", () => {
    same(at("=YEARFRAC(DATE(2008,2,1), DATE(2008,3,1), 1)"), 29 / 366);
    same(at("=YEARFRAC(DATE(2007,12,1), DATE(2008,3,1), 1)"), 91 / 366);
    same(at("=YEARFRAC(DATE(2007,1,1), DATE(2010,1,1), 1)"), 1096 / ((365 * 3 + 366) / 4));
    // US 30/360: February's last day is the 30th, and a 31st after a 30th is the 30th.
    same(at("=YEARFRAC(DATE(2007,2,28), DATE(2007,3,31), 0)"), 31 / 360);
    same(at("=YEARFRAC(DATE(2007,1,30), DATE(2007,3,31), 0)"), 60 / 360);
  });

  it("either way round, and refuses a basis past 4", () => {
    same(
      at("=YEARFRAC(DATE(2012,7,30), DATE(2012,1,1))"),
      at("=YEARFRAC(DATE(2012,1,1), DATE(2012,7,30))") as number,
    );
    expect(at("=YEARFRAC(DATE(2012,1,1), DATE(2012,7,30), 5)")).toEqual({ err: "#NUM!" });
    expect(at("=YEARFRAC(DATE(2012,1,1), DATE(2012,1,1), 1)")).toBe(0);
  });
});
