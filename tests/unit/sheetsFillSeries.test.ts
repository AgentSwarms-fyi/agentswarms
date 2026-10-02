// The fill handle's series, as Excel's AutoFill (R165). Before: a date typed
// 2023-01-30 was continued as text ending in a number (31, then
// "2023-01-32"); two dates a month apart repeated; months and days of the
// week repeated; Q3 ran on to Q7.

import { describe, expect, it } from "vitest";
import type { CellInput } from "@/lib/sheets/engine";
import { literalValue } from "@/lib/sheets/engine";
import { parseDateText } from "@/lib/sheets/formula/values";
import { fillEdits } from "@/lib/sheets/ops";
import { seriesOf } from "@/lib/sheets/series";

/** What filling `n` cells past the typed ones writes. */
const next = (cells: (string | CellInput)[], n: number) => {
  const s = seriesOf(cells.map((c) => (typeof c === "string" ? { i: c } : c)));
  return s ? Array.from({ length: n }, (_, k) => s(k + 1)) : null;
};

describe("dates", () => {
  it("one date goes on by the day, across a month's end", () => {
    expect(next(["2023-01-30"], 3)).toEqual(["2023-01-31", "2023-02-01", "2023-02-02"]);
    expect(next([{ i: "45000", f: "yyyy-mm-dd" }], 2)).toEqual(["45001", "45002"]);
    expect(next(["2023-03-15 10:00"], 1)).toEqual(["2023-03-16 10:00"]);
  });
  it("dates on the same day of their months go on by the month, or the year", () => {
    expect(next(["2023-01-15", "2023-02-15"], 2)).toEqual(["2023-03-15", "2023-04-15"]);
    expect(next(["2022-12-31", "2023-01-31"], 2)).toEqual(["2023-02-28", "2023-03-31"]);
    expect(next(["2021-06-01", "2022-06-01"], 1)).toEqual(["2023-06-01"]);
  });
  it("other dates by their step in days", () => {
    expect(next(["2023-03-01", "2023-03-08"], 2)).toEqual(["2023-03-15", "2023-03-22"]);
    expect(next(["2023-03-01", "2023-03-08", "2023-03-09"], 1)).toBeNull();
  });
  it("a day past the month's end is not a date", () => {
    expect(parseDateText("2023-02-31")).toBeNull();
    expect(literalValue("2023-02-31")).toBe("2023-02-31");
    expect(parseDateText("2024-02-29")).not.toBeNull();
  });
});

describe("months and days of the week", () => {
  it("go on by name, in the same form and case, and round the year", () => {
    expect(next(["Jan"], 3)).toEqual(["Feb", "Mar", "Apr"]);
    expect(next(["January"], 2)).toEqual(["February", "March"]);
    expect(next(["DEC"], 2)).toEqual(["JAN", "FEB"]);
    expect(next(["may"], 1)).toEqual(["june"]);
    expect(next(["Monday"], 2)).toEqual(["Tuesday", "Wednesday"]);
    expect(next(["Fri"], 3)).toEqual(["Sat", "Sun", "Mon"]);
  });
  it("by their step", () => {
    expect(next(["Mon", "Wed"], 2)).toEqual(["Fri", "Sun"]);
    expect(next(["Jan", "Apr"], 2)).toEqual(["Jul", "Oct"]);
  });
  it("a mix is no series", () => {
    expect(next(["Jan", "Monday"], 1)).toBeNull();
  });
});

describe("quarters", () => {
  it("go round after the fourth", () => {
    expect(next(["Q3"], 3)).toEqual(["Q4", "Q1", "Q2"]);
    expect(next(["Qtr 4"], 1)).toEqual(["Qtr 1"]);
    expect(next(["Quarter 1", "Quarter 3"], 2)).toEqual(["Quarter 1", "Quarter 3"]);
  });
});

describe("numbers, and text ending in one, as before", () => {
  it("a step continues; one number alone repeats", () => {
    expect(next(["2", "4"], 2)).toEqual(["6", "8"]);
    expect(next(["5"], 2)).toBeNull();
    expect(next(["Item 9"], 2)).toEqual(["Item 10", "Item 11"]);
    expect(next(["=A1"], 1)).toBeNull();
  });
});

describe("the fill handle", () => {
  it("writes the series and carries each cell's format", () => {
    const cells: Record<string, CellInput> = {
      "0,0": { i: "Jan" },
      "0,1": { i: "45000", f: "d-mmm-yy" },
      "0,2": { i: "=A1" },
    };
    const edits = fillEdits(
      { r0: 0, c0: 0, r1: 0, c1: 2 },
      { r0: 0, c0: 0, r1: 2, c1: 2 },
      (r, c) => cells[`${r},${c}`],
    );
    const at = (row: number, col: number) => edits.find((e) => e.row === row && e.col === col);
    expect([at(1, 0)?.input, at(2, 0)?.input]).toEqual(["Feb", "Mar"]);
    expect([at(1, 1)?.input, at(2, 1)?.input]).toEqual(["45001", "45002"]);
    expect(at(1, 1)?.format).toBe("d-mmm-yy");
    expect(at(2, 2)?.input).toBe("=A3");
  });
});
