// The rest of Excel's complex functions (R264), each checked by an identity
// evaluated in the engine itself: exp undoes ln, a square root squared is the
// number, sin^2 + cos^2 = 1, tan = sin / cos.
//
// Adding them found formula.js unsound across the family, so all of it is the
// engine's own now: a number argument threw (IMSUB(5,2) was #VALUE!), IMPRODUCT
// never opened a range, the negative real axis was at -pi (IMSQRT("-4") was
// -2i), and IMLN took its angle as atan(y/x), wrong left of the imaginary axis.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTION_NAMES } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";

// A1 "3+4i", A2 the number 5, A3 blank, A4 "1+i".
const e = new WorkbookEngine([
  {
    id: "s",
    name: "S",
    kind: "grid",
    grid: { cells: { "0,0": { i: "3+4i" }, "1,0": { i: "5" }, "3,0": { i: "1+i" } } },
  },
]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string): unknown => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
/** The real and imaginary parts of a complex formula's answer. */
const parts = (f: string): [number, number] => [
  at(`=IMREAL(${f})`) as number,
  at(`=IMAGINARY(${f})`) as number,
];

const NEW = [
  "IMSQRT",
  "IMEXP",
  "IMLN",
  "IMLOG10",
  "IMLOG2",
  "IMSIN",
  "IMCOS",
  "IMTAN",
  "IMSINH",
  "IMCOSH",
  "IMSEC",
  "IMCSC",
  "IMCOT",
  "IMSECH",
  "IMCSCH",
];

describe("registered", () => {
  it.each(NEW)("%s is a function", (name) => expect(FUNCTION_NAMES).toContain(name));
});

describe("IMSQRT is the principal root", () => {
  it("the square root of -4 is 2i, not -2i", () => {
    const [re, im] = parts('IMSQRT("-4")');
    expect(re).toBeCloseTo(0, 12);
    expect(im).toBeCloseTo(2, 12); // formula.js: -2
  });

  it("is exact on the real axis, with no residue of cos(pi/2) in the real part", () => {
    expect(at('=IMSQRT("-4")')).toBe("2i");
    expect(at("=IMSQRT(9)")).toBe("3");
    expect(at('=IMSQRT("0")')).toBe("0");
  });

  it("takes the lower root below the real axis", () => {
    const [re, im] = parts('IMSQRT("-4i")');
    expect(re).toBeCloseTo(Math.SQRT2, 13);
    expect(im).toBeCloseTo(-Math.SQRT2, 13);
  });

  it("the square root of 3+4i is 2+i, and of -5-12i is 2-3i", () => {
    expect(at('=IMSQRT("3+4i")')).toBe("2+i");
    expect(at('=IMSQRT("-5-12i")')).toBe("2-3i");
  });

  it("gives Microsoft's documented example", () => {
    expect(at('=IMSQRT("1+i")')).toBe("1.09868411346781+0.455089860562227i");
  });

  it("squared, it is the number again", () => {
    const [re, im] = parts('IMPRODUCT(IMSQRT("-5+12i"),IMSQRT("-5+12i"))');
    expect(re).toBeCloseTo(-5, 12);
    expect(im).toBeCloseTo(12, 12);
  });

  it("keeps a j, and refuses what is not a complex number", () => {
    expect(String(at('=IMSQRT("3+4j")'))).toMatch(/j$/);
    expect(at('=IMSQRT("banana")')).toEqual({ err: "#NUM!" });
  });
});

describe("identities", () => {
  it("IMEXP undoes IMLN", () => {
    const [re, im] = parts('IMEXP(IMLN("3+4i"))');
    expect(re).toBeCloseTo(3, 12);
    expect(im).toBeCloseTo(4, 12);
  });

  it("IMLOG10 and IMLOG2 are IMLN over ln 10 and ln 2", () => {
    const [lr, li] = parts('IMLN("3+4i")');
    const [ar, ai] = parts('IMLOG10("3+4i")');
    expect(ar).toBeCloseTo(lr / Math.LN10, 12);
    expect(ai).toBeCloseTo(li / Math.LN10, 12);
    const [br] = parts('IMLOG2("3+4i")');
    expect(br).toBeCloseTo(lr / Math.LN2, 12);
  });

  it("sin^2 + cos^2 = 1", () => {
    const [re, im] = parts(
      'IMSUM(IMPRODUCT(IMSIN("1+2i"),IMSIN("1+2i")),IMPRODUCT(IMCOS("1+2i"),IMCOS("1+2i")))',
    );
    expect(re).toBeCloseTo(1, 10);
    expect(im).toBeCloseTo(0, 10);
  });

  it("tan, cot, sec and csc are the ratios they name", () => {
    const z = '"1+2i"';
    const close = (a: string, b: string) => {
      const [x, y] = parts(a);
      const [u, v] = parts(b);
      expect(x).toBeCloseTo(u, 12);
      expect(y).toBeCloseTo(v, 12);
    };
    close(`IMTAN(${z})`, `IMDIV(IMSIN(${z}),IMCOS(${z}))`);
    close(`IMCOT(${z})`, `IMDIV(IMCOS(${z}),IMSIN(${z}))`);
    close(`IMSEC(${z})`, `IMDIV("1",IMCOS(${z}))`);
    close(`IMCSC(${z})`, `IMDIV("1",IMSIN(${z}))`);
    close(`IMSECH(${z})`, `IMDIV("1",IMCOSH(${z}))`);
    close(`IMCSCH(${z})`, `IMDIV("1",IMSINH(${z}))`);
  });

  it("is written to fifteen significant digits, as Excel writes any number", () => {
    // e^(1+i) = e (cos 1 + i sin 1)
    expect(at('=IMEXP("1+i")')).toBe("1.46869393991589+2.28735528717884i");
  });
});

describe("a number is a complex number with no imaginary part", () => {
  it("as an argument, where formula.js threw", () => {
    expect(at("=IMSUB(5,2)")).toBe("3");
    expect(at("=IMPOWER(2,2)")).toBe("4");
    expect(at("=IMCONJUGATE(2)")).toBe("2");
    expect(at("=IMEXP(0)")).toBe("1");
    expect(at("=IMDIV(1,0)")).toEqual({ err: "#NUM!" });
  });

  it("in a cell", () => {
    expect(at("=IMSUB(A4,A2)")).toBe("-4+i");
    expect(at("=IMPRODUCT(A1,A2)")).toBe("15+20i");
  });

  it("written with an exponent, as Excel writes a small or large part", () => {
    // formula.js read "1E-07+2i" but none of these: each was #NUM!.
    expect(at('=IMREAL("1E-07")')).toBe(1e-7);
    expect(at('=IMAGINARY("3E-5i")')).toBe(3e-5);
    expect(at('=IMSUM("1.5E-07-2i","1")')).toBe("1.00000015-2i");
    expect(at('=IMREAL("1E+20+i")')).toBe(1e20);
  });
});

describe("ranges", () => {
  it("IMPRODUCT multiplies every value in a range and passes over a blank", () => {
    expect(at("=IMPRODUCT(A1:A4)")).toBe("-5+35i"); // (15+20i)(1+i) = 15 + 35i + 20i^2
    expect(at("=IMSUM(A1:A4)")).toBe("9+5i");
  });
});

describe("the negative real axis is at pi, not -pi", () => {
  it("IMARGUMENT", () => {
    expect(at('=IMARGUMENT("-1")')).toBeCloseTo(Math.PI, 14);
    expect(at('=IMARGUMENT("-i")')).toBeCloseTo(-Math.PI / 2, 14);
  });

  it("IMPOWER's principal cube root of -8 is 1 + 1.732i", () => {
    const [re, im] = parts('IMPOWER("-8",1/3)');
    expect(re).toBeCloseTo(1, 13);
    expect(im).toBeCloseTo(Math.sqrt(3), 13); // formula.js: -1.732
  });
});

describe("logarithms left of the imaginary axis", () => {
  it("IMLN(-1) is pi i, where formula.js said 0", () => {
    const [re, im] = parts('IMLN("-1")');
    expect(re).toBeCloseTo(0, 14);
    expect(im).toBeCloseTo(Math.PI, 13);
  });

  it("IMEXP undoes IMLN there too", () => {
    const [re, im] = parts('IMEXP(IMLN("-3+4i"))');
    expect(re).toBeCloseTo(-3, 12);
    expect(im).toBeCloseTo(4, 12);
  });

  it("IMLOG10(-100) is 2 + (pi / ln 10) i", () => {
    const [re, im] = parts('IMLOG10("-100")');
    expect(re).toBeCloseTo(2, 13);
    expect(im).toBeCloseTo(Math.PI / Math.LN10, 13);
  });
});

describe("zero, and answers with no imaginary part", () => {
  it("is written as text, as every complex answer is", () => {
    expect(at('=IMLN("1")')).toBe("0");
    expect(at('=IMSIN("0")')).toBe("0");
    expect(at('=IMTAN("0")')).toBe("0"); // formula.js threw
    expect(at('=IMPOWER("0",2)')).toBe("0");
  });

  it("is #NUM! where a function has a pole or zero has no logarithm", () => {
    for (const f of [
      '=IMCSC("0")',
      '=IMCOT("0")',
      '=IMCSCH("0")',
      '=IMLN("0")',
      '=IMPOWER("0",-1)',
    ]) {
      expect(at(f)).toEqual({ err: "#NUM!" });
    }
    expect(at('=IMARGUMENT("0")')).toEqual({ err: "#DIV/0!" });
  });

  it("IMREAL answers a number, not text", () => {
    expect(at('=IMREAL("1")')).toBe(1); // formula.js: "1"
    expect(at("=IMREAL(A2)")).toBe(5);
  });
});

describe("what is not a complex number", () => {
  it("is #NUM! for text, #VALUE! for TRUE or FALSE, as Excel's pages say", () => {
    expect(at('=IMABS("hello")')).toEqual({ err: "#NUM!" });
    expect(at("=IMABS(TRUE)")).toEqual({ err: "#VALUE!" });
  });

  it("is #NUM! when the answer overflows, not the text Infinity", () => {
    expect(at('=IMEXP("1000")')).toEqual({ err: "#NUM!" });
  });

  it("still refuses a mix of i and j, and keeps a j", () => {
    expect(at('=IMSUB("1+2i","3+4j")')).toEqual({ err: "#VALUE!" });
    expect(String(at('=IMPOWER("1+j",2)'))).toMatch(/j$/);
  });
});
