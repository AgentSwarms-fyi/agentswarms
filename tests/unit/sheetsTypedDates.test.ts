// Typed times and dates with a month's name (R166). Before: 12:30, 9:00 AM
// and 25:00 stayed text (a column of them summed to 0), and 15-Mar-2023 or
// Mar 15, 2023 stayed text, so =B1+1 was #VALUE!.

import { describe, expect, it } from "vitest";
import { impliedFormat } from "@/lib/sheets/cellView";
import { WorkbookEngine, literalValue } from "@/lib/sheets/engine";
import { formatValue } from "@/lib/sheets/format";
import { parseDateText, parseTimeText } from "@/lib/sheets/formula/values";
import { seriesOf } from "@/lib/sheets/series";

const near = (v: unknown, n: number) => expect(v as number).toBeCloseTo(n, 9);

describe("a typed time", () => {
  it("is a fraction of a day, as Excel reads it", () => {
    near(literalValue("12:30"), 12.5 / 24);
    near(literalValue("9:05:30"), (9 * 3600 + 5 * 60 + 30) / 86400);
    near(literalValue("9:00 AM"), 9 / 24);
    near(literalValue("9:00 PM"), 21 / 24);
    near(literalValue("12:00 AM"), 0);
    near(literalValue("12:15 PM"), 12.25 / 24);
    near(literalValue("25:00"), 25 / 24);
  });
  it("is shown as it was typed", () => {
    expect(impliedFormat("12:30")).toBe("h:mm");
    expect(impliedFormat("9:05:30")).toBe("h:mm:ss");
    expect(impliedFormat("9:00 AM")).toBe("h:mm AM/PM");
    expect(impliedFormat("25:00")).toBe("[h]:mm");
    expect(formatValue(literalValue("9:00 PM") as number, "h:mm AM/PM")).toBe("9:00 PM");
    expect(formatValue(literalValue("25:00") as number, "[h]:mm")).toBe("25:00");
  });
  it("not a time: minutes past 59, AM with an hour past 12", () => {
    expect(literalValue("12:75")).toBe("12:75");
    expect(literalValue("13:00 PM")).toBe("13:00 PM");
    expect(parseTimeText("9")).toBeNull();
  });
});

describe("a date with its month's name", () => {
  it("in the ways Excel reads it, a two-digit year in the 2000s up to 29", () => {
    for (const t of [
      "15-Mar-2023",
      "15 Mar 2023",
      "15 March 2023",
      "Mar 15, 2023",
      "March 15 2023",
      "15-Mar-23",
    ])
      expect({ t, v: literalValue(t) }).toEqual({ t, v: 45000 });
    expect(literalValue("Mar 2023")).toBe(44986);
    expect(parseDateText("1 Jan 45")).toBe(parseDateText("1945-01-01"));
  });
  it("shown as Excel shows it", () => {
    expect(impliedFormat("15-Mar-2023")).toBe("d-mmm-yy");
    expect(impliedFormat("Mar 15, 2023")).toBe("d-mmm-yy");
    expect(impliedFormat("Mar 2023")).toBe("mmm-yy");
  });
  it("not a date: a day past the month's end, a word that is no month", () => {
    expect(literalValue("31-Feb-2023")).toBe("31-Feb-2023");
    expect(literalValue("Foo 15, 2023")).toBe("Foo 15, 2023");
    expect(literalValue("Jan")).toBe("Jan");
  });
  it("an ISO date's time can say AM or PM", () => {
    expect(literalValue("2023-03-15 9:00 PM")).toBe(45000 + 21 / 24);
    expect(literalValue("2023-03-15 25:00")).toBe("2023-03-15 25:00");
  });
});

describe("in formulas", () => {
  const e = new WorkbookEngine([
    {
      id: "s",
      name: "S",
      grid: {
        cells: {
          "0,0": { i: "12:30" },
          "1,0": { i: "9:00 AM" },
          "2,0": { i: "25:00" },
          "3,0": { i: "=SUM(A1:A3)*24" },
          "0,1": { i: "15-Mar-2023" },
          "1,1": { i: "=B1+1" },
          "2,1": { i: '=DATEVALUE("Mar 15, 2023")' },
          "3,1": { i: '="12:30"*24' },
        },
      },
    },
  ]);
  e.recalcAll();
  it("times add up, and dates count", () => {
    near(e.getValue("s", 3, 0), 12.5 + 9 + 25);
    expect(e.getValue("s", 1, 1)).toBe(45001);
    expect(e.getValue("s", 2, 1)).toBe(45000);
    near(e.getValue("s", 3, 1), 12.5);
  });
});

describe("the fill handle", () => {
  const fill = (cells: { i: string; f?: string }[], n: number) => {
    const s = seriesOf(cells);
    return s ? Array.from({ length: n }, (_, k) => Number(s(k + 1))) : null;
  };
  it("a typed date by the day, a typed time by the hour", () => {
    expect(fill([{ i: "15-Mar-2023", f: "d-mmm-yy" }], 2)).toEqual([45001, 45002]);
    const t = fill([{ i: "9:00", f: "h:mm" }], 2)!;
    near(t[0], 10 / 24);
    near(t[1], 11 / 24);
    const half = fill(
      [
        { i: "9:00 AM", f: "h:mm AM/PM" },
        { i: "9:30 AM", f: "h:mm AM/PM" },
      ],
      1,
    )!;
    near(half[0], 10 / 24);
  });
});
