// ASC and JIS (R341).
//
// FOUND IN R329's inventory: both were #NAME?, listed as out of reach. They
// are character mappings: ASC makes full-width ASCII and katakana half-width,
// JIS the reverse. Excel's pages give no table; OpenOffice's specification,
// written to match Japanese Excel, does, and the engine follows it. The
// independent check here is Unicode's own NFKC normalization (built into the
// JavaScript engine): it maps half-width katakana, with their marks, to the
// full-width forms and full-width ASCII to ASCII, so JIS of half-width kana
// and ASC of full-width ASCII must agree with it, and NFKC must undo ASC's kana.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS } from "@/lib/sheets/formula/functions";
import { toFullWidth, toHalfWidth } from "@/lib/sheets/formula/kana";
import type { Value } from "@/lib/sheets/formula/values";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

const e = new WorkbookEngine([
  {
    id: "s",
    name: "S",
    kind: "grid",
    grid: { cells: { "0,0": { i: "ｶﾞｲﾄﾞ" }, "1,0": { i: "ＡＢＣ" } } },
  },
]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 20, 5, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i)).join("");

describe("JIS: half-width to full-width", () => {
  it("the page's example, and the ASCII block", () => {
    expect(at('=JIS("EXCEL")')).toBe("ＥＸＣＥＬ");
    expect(toFullWidth("A1-b2")).toBe("Ａ１－ｂ２");
  });

  it("the specification's four exceptions to the ASCII block", () => {
    expect(toFullWidth("\"\\`'")).toBe("\u201d\uffe5\u2018\u2019");
  });

  it("every half-width katakana, with its marks joined, is what NFKC makes of it", () => {
    const kana = range(0xff66, 0xff9d);
    for (const k of kana) expect(toFullWidth(k), k).toBe(k.normalize("NFKC"));
    for (const k of "ｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾊﾋﾌﾍﾎ")
      expect(toFullWidth(`${k}ﾞ`), k).toBe(`${k}ﾞ`.normalize("NFKC"));
    for (const k of "ﾊﾋﾌﾍﾎ") expect(toFullWidth(`${k}ﾟ`), k).toBe(`${k}ﾟ`.normalize("NFKC"));
  });

  it("a word, a mark alone, and other characters left as they are", () => {
    expect(at("=JIS(A1)")).toBe("ガイド");
    expect(toFullWidth("ﾞ")).toBe("\u309b");
    expect(toFullWidth("漢字 é")).toBe("漢字 é");
  });
});

describe("ASC: full-width to half-width", () => {
  it("the page's example, and the full-width ASCII block as NFKC maps it", () => {
    expect(at('=ASC("EXCEL")')).toBe("EXCEL");
    const full = range(0xff01, 0xff5e);
    expect(toHalfWidth(full)).toBe(full.normalize("NFKC"));
    expect(at("=ASC(A2)")).toBe("ABC");
  });

  it("each katakana the specification lists, splitting a voiced one, which NFKC joins again", () => {
    const listed = [range(0x30a1, 0x30c3), range(0x30c4, 0x30ed), "\u30ef\u30f2\u30f3"].join("");
    for (const k of listed) {
      const half = toHalfWidth(k);
      expect(half, k).not.toBe(k);
      expect(half.normalize("NFKC"), k).toBe(k);
    }
    expect(toHalfWidth("ガギグ")).toBe("ｶﾞｷﾞｸﾞ");
    expect(toHalfWidth("パピプ")).toBe("ﾊﾟﾋﾟﾌﾟ");
  });

  it("the specification's punctuation, and ASC undoes JIS", () => {
    expect(toHalfWidth("\u3002\u300c\u300d\u3001\u30fb\u30fc\uffe5")).toBe("｡｢｣､･ｰ\\");
    const s = 'Excel "2026" ｶﾞｲﾄﾞ\\';
    expect(toHalfWidth(toFullWidth(s))).toBe(s);
  });

  it("what the specification does not list stays: ヴ, hiragana, kanji", () => {
    expect(toHalfWidth("ヴぁ漢")).toBe("ヴぁ漢");
  });
});

describe("the two in the workbook", () => {
  it("answer for each cell of a range, read a number as text, and are known", () => {
    expect(at('=ASC({"Ａ";"Ｂ"})')).toEqual([["A"], ["B"]]);
    expect(at("=JIS(12)")).toBe("１２");
    for (const name of ["ASC", "JIS"]) {
      expect(FUNCTIONS[name], name).toBeTypeOf("function");
      expect(FUNCTION_HELP[name]?.sig, name).toMatch(new RegExp(`^${name}\\(`));
      expect(toFileFormula(`=${name}(A1)`)).toBe(`${name}(A1)`);
    }
  });
});
