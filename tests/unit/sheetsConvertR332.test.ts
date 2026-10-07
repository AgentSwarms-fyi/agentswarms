// CONVERT, with Excel's whole unit table (R332).
//
// FOUND IN R329's inventory: CONVERT was #NAME?, and formula.js's knew too
// few of Excel's units: "F", "C" and "ft2", all on Excel's own page, were
// #N/A. The page's examples come first; the rest checks each group against
// the unit's definition (an inch is 2.54 cm, a pound 453.59237 g…).
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS, LIFTS } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells: {} } }]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
/** Equal to 12 significant digits. */
const same = (got: unknown, want: number) => {
  expect(typeof got, String(got)).toBe("number");
  if (want === 0) expect(Math.abs(got as number)).toBeLessThan(1e-12);
  else expect(Math.abs((got as number) / want - 1)).toBeLessThan(1e-12);
};

describe("the examples on CONVERT's page", () => {
  it.each([
    ['=CONVERT(1, "lbm", "kg")', 0.45359237],
    ['=CONVERT(68, "F", "C")', 20],
    ['=CONVERT(CONVERT(100, "ft", "m"), "ft", "m")', 9.290304],
    ['=CONVERT(6, "C", "F")', 42.8],
    ['=CONVERT(6, "tsp", "tbs")', 2],
    // The page shows 22.71741274, which is not 6 US gallons (3.785411784 L each).
    ['=CONVERT(6, "gal", "l")', 22.712470704],
    ['=CONVERT(6, "mi", "km")', 9.656064],
    ['=CONVERT(6, "km", "mi")', 3.728227153424],
    ['=CONVERT(6, "in", "ft")', 0.5],
    ['=CONVERT(6, "cm", "in")', 2.36220472441],
  ])("%s is %s", (f, want) => {
    same(at(f), want);
  });
  it('=CONVERT(2.5, "ft", "sec") is #N/A: a distance is not a time', () => {
    expect(at('=CONVERT(2.5, "ft", "sec")')).toEqual({ err: "#N/A" });
  });
});

describe("each group, against the units' definitions", () => {
  it.each([
    // Mass.
    ['=CONVERT(1, "ton", "lbm")', 2000],
    ['=CONVERT(1, "stone", "lbm")', 14],
    ['=CONVERT(1, "uk_ton", "lbm")', 2240],
    ['=CONVERT(1, "LTON", "brton")', 1],
    ['=CONVERT(1, "ozm", "g")', 28.349523125],
    ['=CONVERT(7000, "grain", "lbm")', 1],
    ['=CONVERT(1, "cwt", "shweight")', 1],
    ['=CONVERT(1, "uk_cwt", "lbm")', 112],
    // Distance.
    ['=CONVERT(1, "Nmi", "m")', 1852],
    ['=CONVERT(1, "yd", "ft")', 3],
    ['=CONVERT(1, "ell", "in")', 45],
    ['=CONVERT(1, "Pica", "in")', 1 / 72],
    ['=CONVERT(1, "Picapt", "Pica")', 1],
    ['=CONVERT(1, "pica", "Pica")', 12],
    ['=CONVERT(1, "ang", "m")', 1e-10],
    ['=CONVERT(1, "ly", "m")', 9460730472580800],
    ['=CONVERT(1, "survey_mi", "ft")', 5280.0105600211],
    // Time.
    ['=CONVERT(1, "hr", "mn")', 60],
    ['=CONVERT(1, "day", "sec")', 86400],
    ['=CONVERT(1, "yr", "d")', 365.25],
    ['=CONVERT(90, "s", "min")', 1.5],
    // Pressure, force, energy, power, magnetism.
    ['=CONVERT(1, "atm", "Pa")', 101325],
    ['=CONVERT(1, "atm", "Torr")', 760],
    ['=CONVERT(1, "psi", "Pa")', 6894.75729316836],
    ['=CONVERT(1, "lbf", "N")', 4.4482216152605],
    ['=CONVERT(1, "N", "dyn")', 100000],
    ['=CONVERT(1, "cal", "J")', 4.1868],
    ['=CONVERT(1, "c", "J")', 4.184],
    ['=CONVERT(1, "Wh", "J")', 3600],
    ['=CONVERT(1, "BTU", "J")', 1055.05585262],
    ['=CONVERT(1, "flb", "J")', 1.3558179483314],
    ['=CONVERT(1, "HPh", "Wh")', 745.69987158227],
    ['=CONVERT(1, "HP", "W")', 745.69987158227],
    ['=CONVERT(1, "PS", "W")', 735.49875],
    ['=CONVERT(1, "T", "ga")', 10000],
    // Volume and area.
    ['=CONVERT(1, "barrel", "gal")', 42],
    ['=CONVERT(1, "gal", "qt")', 4],
    ['=CONVERT(1, "qt", "pt")', 2],
    ['=CONVERT(1, "cup", "oz")', 8],
    ['=CONVERT(1, "uk_gal", "l")', 4.54609],
    ['=CONVERT(1, "ft3", "in^3")', 1728],
    ['=CONVERT(1, "GRT", "ft3")', 100],
    ['=CONVERT(1, "MTON", "ft^3")', 40],
    ['=CONVERT(1, "m3", "l")', 1000],
    ['=CONVERT(1, "ha", "m2")', 10000],
    ['=CONVERT(1, "ar", "m^2")', 100],
    ['=CONVERT(1, "uk_acre", "ft2")', 43560],
    ['=CONVERT(1, "Morgen", "m2")', 2500],
    ['=CONVERT(1, "mi2", "uk_acre")', 640],
    // Speed and information.
    ['=CONVERT(1, "mph", "m/s")', 0.44704],
    ['=CONVERT(1, "kn", "m/h")', 1852],
    ['=CONVERT(1, "admkn", "m/hr")', 1853.184],
    ['=CONVERT(1, "byte", "bit")', 8],
  ])("%s is %s", (f, want) => {
    same(at(f), want);
  });

  it.each([
    ['=CONVERT(100, "C", "K")', 373.15],
    ['=CONVERT(0, "K", "F")', -459.67],
    ['=CONVERT(32, "fah", "kel")', 273.15],
    ['=CONVERT(80, "Reau", "cel")', 100],
    ['=CONVERT(491.67, "Rank", "C")', 0],
    ['=CONVERT(-40, "C", "F")', -40],
  ])("temperatures convert through kelvin: %s is %s", (f, want) => {
    expect(at(f) as number).toBeCloseTo(want, 9);
  });
});

describe("prefixes", () => {
  it.each([
    ['=CONVERT(1, "km", "m")', 1000],
    ['=CONVERT(1, "mm", "m")', 0.001],
    ['=CONVERT(1, "dam", "m")', 10],
    ['=CONVERT(1, "kg", "g")', 1000],
    ['=CONVERT(1, "mg", "g")', 0.001],
    ['=CONVERT(1, "ms", "s")', 0.001],
    ['=CONVERT(1, "kWh", "J")', 3600000],
    ['=CONVERT(1, "kcal", "J")', 4186.8],
    ['=CONVERT(1, "kPa", "Pa")', 1000],
    ['=CONVERT(1, "ml", "l")', 0.001],
    ['=CONVERT(1, "m/s", "km/h")', 3.6],
    ['=CONVERT(1000, "mK", "K")', 1],
    // On a square or a cube the prefix is raised with it.
    ['=CONVERT(1, "m2", "cm2")', 10000],
    ['=CONVERT(1, "km^2", "m2")', 1000000],
    ['=CONVERT(1, "km3", "m3")', 1e9],
    // Binary prefixes, on bits and bytes.
    ['=CONVERT(1, "Gibyte", "Mibyte")', 1024],
    ['=CONVERT(1, "kibyte", "byte")', 1024],
    ['=CONVERT(1, "kbyte", "bit")', 8000],
    ['=CONVERT(1, "Mibit", "kbit")', 1048.576],
  ])("%s is %s", (f, want) => {
    same(at(f), want);
  });

  it("an exact unit wins over a prefix: min, mi, pc and Pa are units", () => {
    same(at('=CONVERT(1, "min", "s")'), 60);
    same(at('=CONVERT(1, "mi", "ft")'), 5280);
    same(at('=CONVERT(1, "pc", "ly")'), 3.26156377716743);
    same(at('=CONVERT(1, "Pa", "p")'), 1);
  });
});

describe("what CONVERT refuses", () => {
  it.each([
    // Units are case-sensitive.
    ['=CONVERT(1, "LBM", "kg")', "#N/A"],
    ['=CONVERT(1, "ft", "kg")', "#N/A"],
    // A prefix only on a metric unit, a binary one only on bits and bytes.
    ['=CONVERT(1, "kmi", "mi")', "#N/A"],
    ['=CONVERT(1, "kim", "m")', "#N/A"],
    ['=CONVERT(1, "Kibyte", "byte")', "#N/A"],
    // Excel has no hertz.
    ['=CONVERT(1, "kHz", "Hz")', "#N/A"],
    ['=CONVERT("x", "m", "ft")', "#VALUE!"],
    ['=CONVERT(1, "m")', "#N/A"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("and says which unit it does not know", () => {
    const v = e.evaluateAt("s", 9, 9, '=CONVERT(1, "LBM", "kg")') as { detail?: string };
    expect(v.detail).toMatch(/"LBM".*case-sensitive/);
  });
});

describe("in a sheet", () => {
  it("lifts over a range, has help and goes into a file as it is", () => {
    expect(at('=CONVERT({1,2}, "in", "cm")')).toEqual([[2.54, 5.08]]);
    expect(LIFTS.has("CONVERT")).toBe(true);
    expect(FUNCTIONS.CONVERT).toBeTypeOf("function");
    expect(FUNCTION_HELP.CONVERT.sig).toBe("CONVERT(number, from_unit, to_unit)");
    expect(toFileFormula('=CONVERT(1,"mi","km")')).toBe('CONVERT(1,"mi","km")');
  });
});
