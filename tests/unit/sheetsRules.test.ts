// Conditional formatting, data validation, the grid AutoFilter and sort, and
// how they travel: with inserted rows, through the save schema, and in and
// out of an .xlsx.

import ExcelJS from "exceljs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { CondFormatter, describeRule, inPeriod, type CondFormat } from "@/lib/sheets/condFormat";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { columnValues, currentRegion, filteredRows, sortEdits } from "@/lib/sheets/filter";
import { adjustRuleFormulas, moveCells, shiftRangeA1 } from "@/lib/sheets/ops";
import { checkValidation, listItems, timeValue, type Validation } from "@/lib/sheets/validation";
import { readXlsx, writeXlsx } from "@/lib/sheets/xlsx";
import { cellsToRanges } from "@/lib/sheets/xlsxRules";
import { gridSchema } from "@/utils/sheets/schemas";
import { parseRangeA1 } from "@/lib/sheets/a1";
import type { Scalar } from "@/lib/sheets/formula/values";

/** A one-sheet engine over cells typed as { A1: "5" }. */
function sheet(typed: Record<string, string>, extra: Partial<GridData> = {}) {
  const cells: GridData["cells"] = {};
  for (const [ref, i] of Object.entries(typed)) {
    const r = parseRangeA1(ref)!;
    cells[`${r.r0},${r.c0}`] = { i };
  }
  const e = new WorkbookEngine([
    { id: "s", name: "Data", kind: "grid", grid: { cells, ...extra } },
    {
      id: "l",
      name: "Lists",
      kind: "grid",
      grid: { cells: { "0,0": { i: "Open" }, "1,0": { i: "Done" } } },
    },
  ]);
  const value = (row: number, col: number) => e.getValue("s", row, col);
  const evaluate = (f: string, row: number, col: number, self?: Scalar) => {
    const v = e.evaluateAt("s", row, col, f, self === undefined ? {} : { self });
    return (Array.isArray(v) ? (v[0]?.[0] ?? null) : v) as Scalar;
  };
  return { e, value, evaluate };
}

const at = (ref: string) => {
  const r = parseRangeA1(ref)!;
  return [r.r0, r.c0] as const;
};

describe("conditional formatting", () => {
  const nums = { B2: "10", B3: "50", B4: "-20", B5: "80", B6: "50", B7: "" };
  const rules = (list: Omit<CondFormat, "id">[]) => list.map((r, i) => ({ ...r, id: `r${i}` }));
  const red = { bg: "#FFC7CE", color: "#9C0006" };
  const green = { bg: "#C6EFCE" };

  it("highlights by comparison, and a literal or a formula can be the operand", () => {
    const { value, evaluate } = sheet({ ...nums, D1: "40" });
    const cf = new CondFormatter(
      rules([
        { ranges: ["B2:B7"], rule: { kind: "cell", op: "gt", a: "=$D$1", style: red } },
        { ranges: ["B2:B7"], rule: { kind: "cell", op: "between", a: "0", b: "20", style: green } },
      ]),
      { value, evaluate, today: 45000 },
    );
    expect(cf.at(...at("B3"))?.bg).toBe("#FFC7CE"); // 50 > 40
    expect(cf.at(...at("B2"))?.bg).toBe("#C6EFCE"); // 10 between 0 and 20
    expect(cf.at(...at("B4"))).toBeUndefined(); // -20
    // A blank compares as 0, as Excel's does: 0 is between 0 and 20.
    expect(cf.at(...at("B7"))?.bg).toBe("#C6EFCE");
  });

  it("a higher rule wins what both set, and stop-if-true ends the list", () => {
    const { value, evaluate } = sheet(nums);
    const both = rules([
      { ranges: ["B2:B7"], rule: { kind: "cell", op: "gt", a: "40", style: red } },
      { ranges: ["B2:B7"], rule: { kind: "cell", op: "gt", a: "0", style: { ...green, b: true } } },
    ]);
    const cf = new CondFormatter(both, { value, evaluate, today: 0 });
    expect(cf.at(...at("B3"))).toMatchObject({ bg: "#FFC7CE", b: true });
    const stop = new CondFormatter([{ ...both[0], stop: true }, both[1]], {
      value,
      evaluate,
      today: 0,
    });
    expect(stop.at(...at("B3"))?.b).toBeUndefined();
  });

  it("top and bottom N, top percent, above average, duplicates", () => {
    const { value, evaluate } = sheet(nums);
    const cf = (rule: CondFormat["rule"]) =>
      new CondFormatter(rules([{ ranges: ["B2:B7"], rule }]), { value, evaluate, today: 0 });
    const top2 = cf({ kind: "top", n: 2, style: red });
    expect(["B2", "B3", "B4", "B5", "B6"].map((c) => !!top2.at(...at(c)))).toEqual([
      false,
      true,
      false,
      true,
      true, // ties with the second largest count in, as in Excel
    ]);
    const bottom1 = cf({ kind: "top", n: 1, bottom: true, style: red });
    expect(!!bottom1.at(...at("B4"))).toBe(true);
    const pct = cf({ kind: "top", n: 20, percent: true, style: red }); // 20% of 5 → 1
    expect(["B5", "B3"].map((c) => !!pct.at(...at(c)))).toEqual([true, false]);
    const avg = cf({ kind: "average", style: red }); // mean 34
    expect(["B3", "B2"].map((c) => !!avg.at(...at(c)))).toEqual([true, false]);
    const dup = cf({ kind: "duplicate", style: red });
    expect(["B3", "B6", "B2"].map((c) => !!dup.at(...at(c)))).toEqual([true, true, false]);
  });

  it("a formula rule is written for the first cell and moves with each cell", () => {
    const { value, evaluate } = sheet({ A2: "x", A3: "y", B2: "5", B3: "-1", C2: "1", C3: "-1" });
    const cf = new CondFormatter(
      rules([{ ranges: ["A2:C3"], rule: { kind: "formula", formula: "=$C2<0", style: red } }]),
      { value, evaluate, today: 0 },
    );
    expect(["A2", "B2", "A3", "B3"].map((c) => !!cf.at(...at(c)))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("text, blanks and errors", () => {
    const { value, evaluate } = sheet({ A1: "Overdue invoice", A2: "paid", A3: "", A4: "=1/0" });
    const f = (rule: CondFormat["rule"]) =>
      new CondFormatter(rules([{ ranges: ["A1:A4"], rule }]), { value, evaluate, today: 0 });
    expect(!!f({ kind: "text", op: "contains", text: "DUE", style: red }).at(0, 0)).toBe(true);
    expect(!!f({ kind: "text", op: "begins", text: "pa", style: red }).at(1, 0)).toBe(true);
    expect(!!f({ kind: "blank", style: red }).at(2, 0)).toBe(true);
    expect(!!f({ kind: "errors", style: red }).at(3, 0)).toBe(true);
    expect(!!f({ kind: "errors", style: red }).at(0, 0)).toBe(false);
  });

  it("color scales mix between the stops; data bars start at zero; icons split the range", () => {
    const { value, evaluate } = sheet({ A1: "0", A2: "50", A3: "100", B1: "-50", B2: "100" });
    const scale = new CondFormatter(
      rules([
        {
          ranges: ["A1:A3"],
          rule: {
            kind: "scale",
            min: { type: "min", color: "#FF0000" },
            max: { type: "max", color: "#0000FF" },
          },
        },
      ]),
      { value, evaluate, today: 0 },
    );
    expect(scale.at(0, 0)?.bg).toBe("#FF0000");
    expect(scale.at(1, 0)?.bg).toBe("#800080");
    expect(scale.at(2, 0)?.bg).toBe("#0000FF");
    const bar = new CondFormatter(
      rules([{ ranges: ["B1:B2"], rule: { kind: "bar", color: "#638EC6" } }]),
      {
        value,
        evaluate,
        today: 0,
      },
    );
    // -50..100: zero sits a third of the way; -50 fills left of it, 100 to the right edge.
    expect(bar.at(0, 1)?.bar).toMatchObject({ start: 0, end: 1 / 3 });
    expect(bar.at(1, 1)?.bar).toMatchObject({ start: 1 / 3, end: 1 });
    const icons = new CondFormatter(
      rules([{ ranges: ["A1:A3"], rule: { kind: "icons", set: "3traffic" } }]),
      {
        value,
        evaluate,
        today: 0,
      },
    );
    expect([0, 1, 2].map((r) => icons.at(r, 0)?.icon)).toEqual(["🔴", "🟡", "🟢"]);
  });

  it("says each rule in words for the rules manager, colors by name", () => {
    expect(describeRule({ kind: "bar", color: "#638EC6" })).toBe("Data bar: Blue");
    expect(describeRule({ kind: "bar", color: "#123456" })).toBe("Data bar: #123456");
    expect(
      describeRule({
        kind: "scale",
        min: { type: "min", color: "#63BE7B" },
        mid: { type: "percentile", value: 50, color: "#FFEB84" },
        max: { type: "max", color: "#F8696B" },
      }),
    ).toBe("Color scale: Green – Yellow – Red");
    expect(describeRule({ kind: "icons", set: "3traffic" })).toBe(
      "Icon set: 3 traffic lights 🔴🟡🟢",
    );
    expect(describeRule({ kind: "date", period: "last7", style: {} })).toBe(
      "A date in the last 7 days",
    );
    expect(describeRule({ kind: "cell", op: "between", a: "1", b: "=$D$1", style: {} })).toBe(
      "Cell value between 1 and =$D$1",
    );
  });

  it("date periods follow Excel's Sunday-first week", () => {
    // Today is Tuesday 2024-10-08 (45573). 45571 is Sunday 2024-10-06, 45570 the Saturday before.
    const today = 45573;
    expect(inPeriod(45571, "thisWeek", today)).toBe(true);
    expect(inPeriod(45570, "thisWeek", today)).toBe(false);
    expect(inPeriod(45570, "lastWeek", today)).toBe(true);
    expect(inPeriod(45564, "lastWeek", today)).toBe(true); // Sunday 2024-09-29
    expect(inPeriod(45563, "lastWeek", today)).toBe(false);
    expect(inPeriod(45567, "last7", today)).toBe(true); // 2024-10-02
    expect(inPeriod(45566, "last7", today)).toBe(false);
    expect(inPeriod(45541, "lastMonth", today)).toBe(true); // 2024-09-06
    expect(inPeriod(45572, "yesterday", today)).toBe(true);
    expect(inPeriod(45574.75, "tomorrow", today)).toBe(true); // a time of day counts
  });
});

describe("data validation", () => {
  const env = (s: ReturnType<typeof sheet>) => ({
    evaluate: s.evaluate,
    rangeValues: (ref: string, row: number, col: number) => {
      const v = s.e.evaluateAt("s", row, col, ref, { array: true });
      return (Array.isArray(v) ? v.flat() : [v]) as Scalar[];
    },
  });
  const rule = (r: Validation["rule"], more: Partial<Validation> = {}): Validation => ({
    id: "v",
    ranges: ["B2:B9"],
    rule: r,
    ...more,
  });

  it("a list: typed items, or the values of a range on another sheet", () => {
    const s = sheet({});
    const typed = rule({ kind: "list", items: ["Low", "High"] });
    expect(checkValidation(typed, "high", env(s), 1, 1)).toEqual({ ok: true });
    expect(checkValidation(typed, "Medium", env(s), 1, 1)).toEqual({
      ok: false,
      message: "Choose one of: Low, High",
    });
    const ranged = rule({ kind: "list", source: "=Lists!$A$1:$A$5" });
    expect(listItems(ranged, env(s), 1, 1)).toEqual(["Open", "Done"]);
    expect(checkValidation(ranged, "Done", env(s), 1, 1).ok).toBe(true);
    expect(checkValidation(ranged, "Closed", env(s), 1, 1).ok).toBe(false);
  });

  it("numbers, dates, times and lengths, with the limits named as typed", () => {
    const s = sheet({ D1: "100" });
    const whole = rule({ kind: "whole", op: "between", a: "1", b: "=D1" });
    expect(checkValidation(whole, "50", env(s), 1, 1).ok).toBe(true);
    expect(checkValidation(whole, "50.5", env(s), 1, 1)).toEqual({
      ok: false,
      message: "Enter a whole number between 1 and 100",
    });
    expect(checkValidation(whole, "abc", env(s), 1, 1).ok).toBe(false);
    const date = rule({ kind: "date", op: "between", a: "2024-01-01", b: "2024-12-31" });
    expect(checkValidation(date, "2024-06-30", env(s), 1, 1).ok).toBe(true);
    expect(checkValidation(date, "2025-01-02", env(s), 1, 1)).toEqual({
      ok: false,
      message: "Enter a date between 2024-01-01 and 2024-12-31",
    });
    const time = rule({ kind: "time", op: "between", a: "9:00", b: "17:30" });
    expect(checkValidation(time, "12:15", env(s), 1, 1).ok).toBe(true);
    expect(checkValidation(time, "6:00 PM", env(s), 1, 1).ok).toBe(false);
    expect(timeValue("6:00 PM")).toBeCloseTo(0.75);
    const len = rule({ kind: "length", op: "le", a: "5" });
    expect(checkValidation(len, "abcde", env(s), 1, 1).ok).toBe(true);
    expect(checkValidation(len, "abcdef", env(s), 1, 1).ok).toBe(false);
  });

  it("a custom formula, a blank cell, and the rule's own message", () => {
    const s = sheet({ A2: "7", A3: "7" });
    const unique = rule(
      { kind: "custom", formula: "=COUNTIF($A$2:$A$3,B2)=0" },
      { error: { style: "stop", message: "Already used" } },
    );
    expect(checkValidation(unique, "8", env(s), 1, 1).ok).toBe(true);
    expect(checkValidation(unique, "7", env(s), 1, 1)).toEqual({
      ok: false,
      message: "Already used",
    });
    expect(checkValidation(unique, "", env(s), 1, 1).ok).toBe(true);
    const required = { ...unique, allowBlank: false };
    expect(checkValidation(required, "", env(s), 1, 1).ok).toBe(false);
  });
});

describe("the grid filter and sort", () => {
  const data = {
    A1: "Region",
    B1: "Sales",
    A2: "North",
    B2: "120",
    A3: "South",
    B3: "80",
    A4: "North",
    B4: "40",
    A5: "East",
    B5: "",
    A6: "West",
    B6: "200",
  };
  const envOf = (s: ReturnType<typeof sheet>) => ({
    value: s.value,
    text: (r: number, c: number) => {
      const v = s.value(r, c);
      return v === null ? "" : String(v);
    },
  });

  it("keeps ticked values, or rows meeting a condition, and lists each value once", () => {
    const s = sheet(data);
    const env = envOf(s);
    expect(filteredRows({ range: "A1:B6", cols: { "0": { values: ["North"] } } }, env)).toEqual([
      2, 4, 5,
    ]);
    expect(
      filteredRows({ range: "A1:B6", cols: { "1": { cond: { op: "gt", a: "100" } } } }, env),
    ).toEqual([2, 3, 4]);
    expect(
      filteredRows({ range: "A1:B6", cols: { "1": { cond: { op: "top", a: "1" } } } }, env),
    ).toEqual([1, 2, 3, 4]);
    expect(columnValues({ range: "A1:B6" }, 0, env)).toEqual([
      { text: "East", count: 1 },
      { text: "North", count: 2 },
      { text: "South", count: 1 },
      { text: "West", count: 1 },
    ]);
  });

  it("sorts rows under the header, blanks last either way, moving formulas with their rows", () => {
    const s = sheet({ ...data, C2: "=B2*2" });
    const env = { value: s.value, input: (r: number, c: number) => s.e.getInput("s", r, c) };
    const edits = sortEdits({ r0: 0, c0: 0, r1: 5, c1: 2 }, [{ col: 1, desc: true }], env);
    const col = (c: number) => edits.filter((x) => x.col === c).map((x) => x.input);
    expect(col(0)).toEqual(["West", "North", "South", "North", "East"]);
    expect(col(1)).toEqual(["200", "120", "80", "40", ""]);
    // North's formula went from row 2 to row 3 and now reads its own row.
    expect(col(2)).toEqual(["", "=B3*2", "", "", ""]);
  });

  it("finds the block of data around a cell", () => {
    const s = sheet(data);
    const filled = (r: number, c: number) => s.value(r, c) !== null;
    expect(currentRegion(2, 0, filled)).toEqual({ r0: 0, c0: 0, r1: 5, c1: 1 });
  });
});

describe("rules and the filter follow inserted and deleted rows", () => {
  const grid: GridData = {
    cells: {},
    cond: [
      {
        id: "c",
        ranges: ["B2:B40"],
        rule: { kind: "formula", formula: "=$C2<0", style: { bg: "#FFC7CE" } },
      },
    ],
    validations: [{ id: "v", ranges: ["D2:D40"], rule: { kind: "list", source: "=$F$2:$F$9" } }],
    filter: { range: "A1:D40", cols: { "3": { values: ["x"] } }, hidden: [5, 9] },
  };

  it("ranges move and grow", () => {
    expect(shiftRangeA1("B2:B40", "rows", 0, 1)).toBe("B3:B41");
    expect(shiftRangeA1("B2:B40", "rows", 10, 2)).toBe("B2:B42");
    expect(shiftRangeA1("B2:B2", "rows", 1, -1)).toBeNull();
    const moved = moveCells(grid, "rows", 0, 1);
    expect(moved.cond![0].ranges).toEqual(["B3:B41"]);
    expect(moved.validations![0].ranges).toEqual(["D3:D41"]);
    expect(moved.filter).toMatchObject({ range: "A2:D41", hidden: [6, 10] });
  });

  it("a deleted column inside the filter drops its own column filter", () => {
    const moved = moveCells(grid, "cols", 1, -1); // delete column B
    expect(moved.filter?.range).toBe("A1:C40");
    expect(moved.filter?.cols).toEqual({ "2": { values: ["x"] } });
    expect(moved.cond).toEqual([]);
  });

  it("rule formulas follow, as cell formulas do", () => {
    const moved = adjustRuleFormulas(moveCells(grid, "rows", 0, 1), "Data", "Data", "rows", 0, 1);
    expect(moved.cond![0].rule).toMatchObject({ formula: "=$C3<0" });
    expect(moved.validations![0].rule).toMatchObject({ source: "=$F$3:$F$10" });
    // Another sheet's insert leaves them alone (the same object back).
    expect(adjustRuleFormulas(grid, "Data", "Other", "rows", 0, 1)).toBe(grid);
  });
});

describe("the save schema", () => {
  const ok = (g: unknown) => gridSchema.safeParse(g).success;
  it("accepts rules, validations and a filter", () => {
    expect(
      ok({
        cells: {},
        cond: [
          { id: "a", ranges: ["B2:B9"], rule: { kind: "icons", set: "3traffic" } },
          {
            id: "b",
            ranges: ["C2:C9"],
            rule: { kind: "cell", op: "gt", a: "=$D$1", style: { bg: "#FFC7CE" } },
          },
        ],
        validations: [
          {
            id: "v",
            ranges: ["D2:D9"],
            rule: { kind: "whole", op: "between", a: "1", b: "10" },
            error: { style: "warning" },
          },
        ],
        filter: { range: "A1:D9", cols: { "1": { cond: { op: "gt", a: "5" } } }, hidden: [3] },
      }),
    ).toBe(true);
  });
  it("refuses a color that is not #RRGGBB, an icon set it does not know, a bad range", () => {
    const cf = (rule: unknown, ranges = ["B2:B9"]) =>
      ok({ cells: {}, cond: [{ id: "a", ranges, rule }] });
    expect(cf({ kind: "bar", color: "red;background:url(x)" })).toBe(false);
    expect(cf({ kind: "cell", op: "gt", a: "1", style: { bg: "#FFC7CE", evil: 1 } })).toBe(false);
    expect(cf({ kind: "icons", set: "<img>" })).toBe(false);
    expect(cf({ kind: "blank", style: {} }, ["B2:B9;DROP"])).toBe(false);
  });
});

describe("rules in and out of an .xlsx", () => {
  it("round-trips every kind of rule, the validations and the filter", async () => {
    const cond: CondFormat[] = [
      {
        id: "1",
        ranges: ["B2:B6"],
        rule: { kind: "cell", op: "gt", a: "50", style: { bg: "#FFC7CE", color: "#9C0006" } },
      },
      {
        id: "2",
        ranges: ["B2:B6"],
        rule: { kind: "cell", op: "between", a: "=$E$1", b: "20", style: { b: true } },
      },
      {
        id: "3",
        ranges: ["A2:A6"],
        rule: { kind: "text", op: "contains", text: "rth", style: { bg: "#C6EFCE" } },
      },
      {
        id: "4",
        ranges: ["A2:A6"],
        rule: { kind: "text", op: "begins", text: 'Ea"st', style: { i: true } },
      },
      { id: "5", ranges: ["B2:B6"], rule: { kind: "top", n: 2, style: { bg: "#FFEB9C" } } },
      { id: "6", ranges: ["B2:B6"], rule: { kind: "average", below: true, style: { st: true } } },
      {
        id: "7",
        ranges: ["C2:C6"],
        rule: { kind: "formula", formula: "=XLOOKUP(A2,A:A,B:B)>100", style: { u: true } },
      },
      {
        id: "8",
        ranges: ["D2:D6"],
        rule: { kind: "date", period: "last7", style: { bg: "#FFC7CE" } },
      },
      {
        id: "9",
        ranges: ["B2:B6"],
        rule: {
          kind: "scale",
          min: { type: "min", color: "#63BE7B" },
          mid: { type: "percentile", value: 50, color: "#FFEB84" },
          max: { type: "max", color: "#F8696B" },
        },
      },
      { id: "10", ranges: ["B2:B6"], rule: { kind: "bar", color: "#638EC6" } },
      { id: "11", ranges: ["B2:B6"], rule: { kind: "icons", set: "3arrows" } },
    ];
    const validations: Validation[] = [
      {
        id: "a",
        ranges: ["A2:A6"],
        rule: { kind: "list", items: ["North", "South", "East", "West"] },
        prompt: { title: "Region", message: "Pick a region" },
        error: { style: "stop", title: "Not a region", message: "Pick from the list" },
      },
      {
        id: "b",
        ranges: ["B2:B6"],
        rule: { kind: "decimal", op: "ge", a: "0" },
        error: { style: "warning" },
      },
      {
        id: "c",
        ranges: ["D2:D6"],
        rule: { kind: "date", op: "between", a: "2024-01-01", b: "2024-12-31" },
      },
      {
        id: "d",
        ranges: ["E2:F6"],
        rule: { kind: "custom", formula: "=LEN(E2)<10" },
        error: { style: "info" },
      },
    ];
    const grid: GridData = {
      cells: {
        "0,0": { i: "Region" },
        "0,1": { i: "Sales" },
        "1,0": { i: "North" },
        "1,1": { i: "80" },
      },
      cond,
      validations,
      filter: { range: "A1:B6", cols: { "0": { values: ["North"] } }, hidden: [2, 3] },
    };
    const buf = await writeXlsx([{ kind: "grid", name: "Data", grid, value: () => null }]);
    const xml = strFromU8(unzipSync(new Uint8Array(buf))["xl/worksheets/sheet1.xml"]);
    expect(xml).toContain('<autoFilter ref="A1:B6"/>');
    // Excel shows a text rule by its operator and text, which ExcelJS leaves out.
    expect(xml).toMatch(/<cfRule type="containsText"[^>]* operator="containsText" text="rth">/);
    expect(xml).toMatch(
      /<cfRule type="beginsWith"[^>]* operator="beginsWith"[^>]* text="Ea&quot;st">/,
    );
    expect(xml).toContain("_xlfn.XLOOKUP(A2,A:A,B:B)&gt;100");
    expect(xml).toContain("LEFT(A2,LEN(&quot;Ea&quot;&quot;st&quot;))");

    const back = await readXlsx(buf, { maxCells: 1000 });
    const g = back.sheets[0].grid;
    expect(back.warnings).toEqual([]);
    const kinds = g.cond!.map((c) => c.rule.kind);
    expect(kinds).toEqual([
      "cell",
      "cell",
      "text",
      "text",
      "top",
      "average",
      "formula",
      "date",
      "scale",
      "bar",
      "icons",
    ]);
    expect(g.cond![1].rule).toMatchObject({ a: "=$E$1", b: "20", style: { b: true } });
    expect(g.cond![2].rule).toMatchObject({
      op: "contains",
      text: "rth",
      style: { bg: "#C6EFCE" },
    });
    expect(g.cond![3].rule).toMatchObject({ op: "begins", text: 'Ea"st' });
    expect(g.cond![6].rule).toMatchObject({ formula: "=XLOOKUP(A2,A:A,B:B)>100" });
    expect(g.cond![8].rule).toMatchObject({
      mid: { type: "percentile", value: 50, color: "#FFEB84" },
    });
    const byRange = Object.fromEntries(g.validations!.map((v) => [v.ranges.join(" "), v]));
    expect(byRange["A2:A6"]).toMatchObject({
      rule: { kind: "list", items: ["North", "South", "East", "West"] },
      prompt: { title: "Region", message: "Pick a region" },
      error: { style: "stop", title: "Not a region", message: "Pick from the list" },
    });
    expect(byRange["B2:B6"]).toMatchObject({
      rule: { kind: "decimal", op: "ge", a: "0" },
      error: { style: "warning" },
    });
    expect(byRange["D2:D6"].rule).toEqual({ kind: "date", op: "between", a: "45292", b: "45657" });
    expect(byRange["E2:F6"]).toMatchObject({
      rule: { kind: "custom", formula: "=LEN(E2)<10" },
      error: { style: "info" },
    });
    expect(g.filter).toEqual({ range: "A1:B6", cols: {} });
    // The rows the filter hid stay hidden in the file.
    expect(g.hiddenRows).toEqual([2, 3]);
  });

  it("rules written as the formula they mean come back as those rules", async () => {
    const style = { bg: "#FFC7CE" };
    const kinds: CondFormat["rule"][] = [
      { kind: "text", op: "notContains", text: "void", style },
      { kind: "text", op: "ends", text: "Inc.", style },
      { kind: "duplicate", style },
      { kind: "unique", style },
      { kind: "blank", style },
      { kind: "notBlank", style },
      { kind: "errors", style },
      { kind: "noErrors", style },
    ];
    const cond = kinds.map((rule, i) => ({ id: String(i), ranges: ["C3:C30"], rule }));
    const buf = await writeXlsx([
      { kind: "grid", name: "S", grid: { cells: {}, cond }, value: () => null },
    ]);
    const back = await readXlsx(buf, { maxCells: 100 });
    expect(back.sheets[0].grid.cond!.map((c) => c.rule)).toEqual(kinds);
    // A formula about some other cell stays a formula rule.
    const other = await writeXlsx([
      {
        kind: "grid",
        name: "S",
        grid: {
          cells: {},
          cond: [
            {
              id: "x",
              ranges: ["C3:C30"],
              rule: { kind: "formula", formula: "=ISERROR(D3)", style },
            },
          ],
        },
        value: () => null,
      },
    ]);
    expect((await readXlsx(other, { maxCells: 100 })).sheets[0].grid.cond![0].rule).toEqual({
      kind: "formula",
      formula: "=ISERROR(D3)",
      style,
    });
  });

  it("gathers a validation's cells back into ranges", () => {
    const cells = [
      { row: 1, col: 1 },
      { row: 2, col: 1 },
      { row: 1, col: 2 },
      { row: 2, col: 2 },
      { row: 5, col: 1 },
    ];
    expect(cellsToRanges(cells)).toEqual(["B2:C3", "B6"]);
  });

  it("a date limit that is a formula goes out as a decimal rule Excel can read", async () => {
    const grid: GridData = {
      cells: {},
      validations: [
        { id: "a", ranges: ["A1:A5"], rule: { kind: "date", op: "ge", a: "=TODAY()" } },
      ],
    };
    const buf = await writeXlsx([{ kind: "grid", name: "S", grid, value: () => null }]);
    const xml = strFromU8(unzipSync(new Uint8Array(buf))["xl/worksheets/sheet1.xml"]);
    expect(xml).toMatch(
      /<dataValidation type="decimal" operator="greaterThanOrEqual"[^>]*sqref="A1:A5"><formula1>TODAY\(\)<\/formula1>/,
    );
    // ExcelJS reads that limit back as NaN; the file's own text brings the formula home.
    const back = await readXlsx(buf, { maxCells: 100 });
    expect(back.sheets[0].grid.validations?.[0]).toMatchObject({
      ranges: ["A1:A5"],
      rule: { kind: "decimal", op: "ge", a: "=TODAY()" },
    });
  });
});
