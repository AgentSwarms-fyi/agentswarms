// Complex numbers, written the way Excel writes them (R260).
//
// formula.js computes these and gets exact arithmetic right, but not Excel's
// text: its IMSUM and IMPRODUCT turned a "j" into an "i", added up a mix of
// "i" and "j" that Excel refuses, and wrote results to 16-17 digits where
// Excel writes any number as text to 15 significant digits. Every answer
// below is complex arithmetic worked by hand.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTION_NAMES } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";

const e = new WorkbookEngine([
  {
    id: "s",
    name: "S",
    kind: "grid",
    grid: { cells: { "0,0": { i: "3+4i" }, "1,0": { i: "5-3i" } } },
  },
]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string): unknown => {
  const v = plain(e.evaluateAt("s", 19, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};

describe("complex arithmetic", () => {
  it("adds, subtracts, multiplies and divides", () => {
    expect(at('=IMSUM("3+4i","5-3i")')).toBe("8+i");
    expect(at('=IMSUB("13+4i","5+3i")')).toBe("8+i");
    expect(at('=IMPRODUCT("3+4i","5-3i")')).toBe("27+11i"); // 15 - 9i + 20i + 12
    // Excel's own example; check: (5+12i)(10+24i) = 50 + 240i - 288 = -238 + 240i.
    expect(at('=IMDIV("-238+240i","10+24i")')).toBe("5+12i");
  });

  it("reads ranges as Excel does", () => {
    expect(at("=IMSUM(A1:A2)")).toBe("8+i");
  });

  it("returns the parts as numbers", () => {
    expect(at('=IMABS("5+12i")')).toBe(13);
    expect(at('=IMREAL("6-9i")')).toBe(6);
    expect(at('=IMAGINARY("3+4i")')).toBe(4);
    expect(at('=IMAGINARY("i")')).toBe(1);
    expect(at('=IMARGUMENT("3+4i")')).toBeCloseTo(Math.atan2(4, 3), 14);
    expect(at('=IMCONJUGATE("3+4i")')).toBe("3-4i");
  });
});

describe("Excel's text, not the library's", () => {
  it("keeps a j where the arguments used j", () => {
    expect(at('=IMSUM("1+2j","3+4j")')).toBe("4+6j");
    expect(at('=IMPRODUCT("1+2j","3+4j")')).toBe("-5+10j"); // 3 + 4j + 6j - 8
    expect(at('=IMCONJUGATE("3+4j")')).toBe("3-4j");
  });

  it("refuses to mix i and j", () => {
    expect(at('=IMSUM("1+2i","3+4j")')).toEqual({ err: "#VALUE!" });
  });

  it("writes a number to fifteen significant digits, as Excel writes any number as text", () => {
    expect(at('=IMDIV("1","3")')).toBe("0.333333333333333"); // formula.js: 0.3333333333333333
    // (2+3i)^3 = 8 + 36i - 54 - 27i = -46 + 9i, computed in polar form with a
    // last-digit wobble that fifteen digits keeps the way Excel keeps it.
    expect(at('=IMPOWER("2+3i",3)')).toBe("-46+9.00000000000001i");
  });

  it("drops a zero part, and writes a unit coefficient as i alone", () => {
    expect(at('=IMSUB("3+4i","3+3i")')).toBe("i");
    expect(at('=IMSUB("3+4i","3+5i")')).toBe("-i");
    expect(at('=IMSUB("3+4i","1+4i")')).toBe("2");
    expect(at('=IMSUB("3+4i","3+4i")')).toBe("0");
  });
});

describe("what was left out", () => {
  it("IMSQRT is not registered: formula.js gives sqrt(-4) the wrong sign", () => {
    expect(FUNCTION_NAMES).not.toContain("IMSQRT");
  });
});
