// Charts: how a range is read (Excel's rule for names, categories and series
// direction), and charts in and out of an .xlsx as DrawingML parts.

import ExcelJS from "exceljs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { parseRangeA1 } from "@/lib/sheets/a1";
import { chartData, type ChartDef, type ChartType } from "@/lib/sheets/charts";
import type { Scalar } from "@/lib/sheets/formula/values";
import {
  addChartsToXlsx,
  anchorAt,
  chartXml,
  readXlsxCharts,
  seriesRefs,
} from "@/lib/sheets/xlsxCharts";

/** A value reader over cells typed as { A1: "Month", B2: 120 }. */
function cells(map: Record<string, Scalar>) {
  const byPos = new Map<string, Scalar>();
  for (const [ref, v] of Object.entries(map)) {
    const r = parseRangeA1(ref)!;
    byPos.set(`${r.r0},${r.c0}`, v);
  }
  return (row: number, col: number) => byPos.get(`${row},${col}`) ?? null;
}

const sales = cells({
  A1: "Month",
  B1: "North",
  C1: "South",
  A2: "Jan",
  B2: 120,
  C2: 80,
  A3: "Feb",
  B3: 150,
  C3: 95,
  A4: "Mar",
  B4: 170,
  C4: null,
});

const def = (type: ChartType, range = "A1:C4", more: Partial<ChartDef> = {}): ChartDef => ({
  id: "c1",
  type,
  range,
  x: 400,
  y: 24,
  w: 480,
  h: 300,
  ...more,
});

describe("reading a range as Excel does", () => {
  it("a header row names the series and a text column gives the categories", () => {
    const d = chartData(def("column"), sales);
    expect(d.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(d.series).toEqual([
      { name: "North", values: [120, 150, 170] },
      { name: "South", values: [80, 95, null] },
    ]);
  });

  it("series run across the rows when the range is wider than tall, or when asked", () => {
    const wide = cells({
      A1: "",
      B1: "Q1",
      C1: "Q2",
      D1: "Q3",
      A2: "Revenue",
      B2: 10,
      C2: 20,
      D2: 30,
    });
    const d = chartData(def("line", "A1:D2"), wide);
    expect(d.categories).toEqual(["Q1", "Q2", "Q3"]);
    expect(d.series).toEqual([{ name: "Revenue", values: [10, 20, 30] }]);
    const rows = chartData(def("column", "A1:C4", { seriesIn: "rows" }), sales);
    expect(rows.series.map((s) => s.name)).toEqual(["Jan", "Feb", "Mar"]);
    expect(rows.categories).toEqual(["North", "South"]);
  });

  it("a pie draws the first series; a scatter reads x then y", () => {
    expect(chartData(def("pie"), sales).series).toHaveLength(1);
    const xy = cells({ A1: "Spend", B1: "Sales", A2: 1, B2: 10, A3: 2, B3: 19, A4: 3, B4: 31 });
    const d = chartData(def("scatter", "A1:B4"), xy);
    expect(d.xs).toEqual([1, 2, 3]);
    expect(d.series).toEqual([{ name: "Sales", values: [10, 19, 31] }]);
  });

  it("says why there is nothing to draw", () => {
    const text = cells({ A1: "a", A2: "b" });
    expect(chartData(def("column", "A1:A2"), text).problem).toMatch(/no numbers/);
    expect(chartData(def("column", "nope"), sales).problem).toMatch(/not a range/);
    expect(chartData(def("scatter", "A1:A4"), sales).problem).toMatch(/two columns/);
  });
});

describe("charts in an .xlsx", () => {
  async function workbook() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sales 2024");
    ws.addRows([
      ["Month", "North", "South"],
      ["Jan", 120, 80],
      ["Feb", 150, 95],
      ["Mar", 170, 60],
    ]);
    // A table part too, so the sheet already has relationships.
    ws.addTable({
      name: "T1",
      ref: "E1",
      columns: [{ name: "k" }],
      rows: [[1]],
    });
    return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  }
  const sheetOf = (charts: ChartDef[]) => ({
    name: "Sales 2024",
    charts,
    value: sales,
    colPx: () => 100,
    rowPx: () => 24,
  });

  it("anchors a chart to the cell it starts in, offset in Excel's units (EMU, 9525 a pixel)", () => {
    expect(anchorAt(150, () => 100, 100)).toEqual([1, 50 * 9525]);
    expect(anchorAt(0, () => 24, 100)).toEqual([0, 0]);
  });

  it("names the ranges each series plots, quoted when the sheet name needs it", () => {
    const refs = seriesRefs(
      "Sales 2024",
      parseRangeA1("A1:C4")!,
      { headerRow: true, labelCol: true, byCols: true },
      false,
    );
    expect(refs[0]).toEqual({
      name: "'Sales 2024'!$B$1",
      cat: "'Sales 2024'!$A$2:$A$4",
      val: "'Sales 2024'!$B$2:$B$4",
    });
    const xml = chartXml(def("combo", "A1:C4", { title: "R&D <spend>" }), refs);
    expect(xml).toContain("<c:barChart>");
    expect(xml).toContain("<c:lineChart>");
    expect(xml).toContain("R&amp;D &lt;spend&gt;");
  });

  it("adds chart, drawing and relationship parts that ExcelJS still opens, and reads them back", async () => {
    const types: ChartType[] = [
      "column",
      "bar",
      "line",
      "area",
      "pie",
      "doughnut",
      "scatter",
      "combo",
      "radar",
    ];
    const charts = types.map((t, i) =>
      def(t, t === "scatter" ? "B1:C4" : "A1:C4", {
        id: `c${i}`,
        title: `${t} chart`,
        y: 24 + i * 310,
        ...(t === "column"
          ? { stacked: "normal" as const, labels: true, legend: "right" as const }
          : {}),
        ...(t === "line" ? { smooth: true, xTitle: "Month", yTitle: "Units" } : {}),
      }),
    );
    const out = addChartsToXlsx(await workbook(), [sheetOf(charts)]);
    const files = unzipSync(new Uint8Array(out));
    expect(Object.keys(files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f))).toHaveLength(9);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    // <drawing> sits before <tableParts>, as the schema orders them.
    expect(sheet.indexOf("<drawing ")).toBeGreaterThan(0);
    expect(sheet.indexOf("<drawing ")).toBeLessThan(sheet.indexOf("<tableParts"));
    const rels = strFromU8(files["xl/worksheets/_rels/sheet1.xml.rels"]);
    expect(rels).toContain("relationships/table");
    expect(rels).toContain("relationships/drawing");
    expect(strFromU8(files["[Content_Types].xml"])).toContain("drawingml.chart+xml");
    // The cells and the table are untouched: ExcelJS reads the file.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out);
    expect(wb.worksheets[0].getCell("B3").value).toBe(150);

    const back = readXlsxCharts(unzipSync(new Uint8Array(out)), () => ({
      colPx: () => 100,
      rowPx: () => 24,
    }));
    expect(back.skipped).toEqual([]);
    const got = back.charts.get("Sales 2024")!;
    expect(got.map((c) => c.type)).toEqual(types);
    expect(got[0]).toMatchObject({
      range: "A1:C4",
      title: "column chart",
      stacked: "normal",
      labels: true,
      legend: "right",
      x: 400,
      y: 24,
      w: 480,
      h: 300,
    });
    expect(got[2]).toMatchObject({ smooth: true, xTitle: "Month", yTitle: "Units" });
    expect(got[6]).toMatchObject({ type: "scatter", range: "B1:C4" });
  });

  it("leaves out a chart of another sheet's data, and says so", async () => {
    const out = addChartsToXlsx(await workbook(), [sheetOf([def("column")])]);
    const back = readXlsxCharts(unzipSync(new Uint8Array(out)), (name) =>
      name === "Sales 2024" ? { colPx: () => 100, rowPx: () => 24 } : null,
    );
    expect(back.charts.get("Sales 2024")).toHaveLength(1);
    // Point the chart at another sheet.
    const files = unzipSync(new Uint8Array(out));
    const part = Object.keys(files).find((f) => /xl\/charts\/chart\d+\.xml$/.test(f))!;
    const moved = strFromU8(files[part]).replace(/'Sales 2024'!/g, "Other!");
    const { zipSync, strToU8 } = await import("fflate");
    files[part] = strToU8(moved);
    const z = zipSync(files);
    const again = readXlsxCharts(unzipSync(z), () => ({ colPx: () => 100, rowPx: () => 24 }));
    expect(again.charts.size).toBe(0);
    expect(again.skipped).toEqual(["Sales 2024: a chart of another sheet's data"]);
  });
});

describe("charts on the sheet", () => {
  it("move and grow with inserted rows, and go when their data is deleted", async () => {
    const { moveCells } = await import("@/lib/sheets/ops");
    const grid = { cells: {}, charts: [def("column", "A1:C4")] };
    expect(moveCells(grid, "rows", 0, 2).charts![0].range).toBe("A3:C6");
    expect(moveCells(grid, "rows", 2, 1).charts![0].range).toBe("A1:C5");
    expect(moveCells(grid, "cols", 0, -3).charts).toEqual([]);
  });

  it("are checked strictly when saved", async () => {
    const { gridSchema } = await import("@/utils/sheets/schemas");
    const ok = (c: unknown) => gridSchema.safeParse({ cells: {}, charts: [c] }).success;
    expect(ok(def("line", "A1:B9", { title: "Revenue" }))).toBe(true);
    expect(ok({ ...def("line"), type: "sparkline" })).toBe(false);
    expect(ok({ ...def("line"), range: "A1:B9;DROP" })).toBe(false);
    expect(ok({ ...def("line"), onclick: "alert(1)" })).toBe(false);
    expect(ok({ ...def("line"), w: 5 })).toBe(false);
  });

  it("travel through the workbook's own Excel writer and reader", async () => {
    const { readXlsx, writeXlsx } = await import("@/lib/sheets/xlsx");
    const cells: Record<string, { i: string }> = {};
    const rows = [
      ["Month", "North", "South"],
      ["Jan", "120", "80"],
      ["Feb", "150", "95"],
    ];
    rows.forEach((r, i) => r.forEach((v, j) => (cells[`${i},${j}`] = { i: v })));
    const value = (r: number, c: number) => {
      const v = rows[r]?.[c];
      return v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : v;
    };
    const buf = await writeXlsx([
      {
        kind: "grid",
        name: "Q1 revenue by region and product line",
        grid: { cells, charts: [def("line", "A1:C3", { title: "Trend", x: 350, y: 0 })] },
        value,
      },
    ]);
    const back = await readXlsx(buf, { maxCells: 100 });
    expect(back.warnings).toEqual([]);
    expect(back.sheets[0].grid.charts).toEqual([
      expect.objectContaining({
        type: "line",
        range: "A1:C3",
        title: "Trend",
        x: 350,
        y: 0,
        w: 480,
        h: 300,
      }),
    ]);
  });
});

describe("the chart component", () => {
  it("gives recharts its axes as direct children (it does not look inside a fragment)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../../src/components/sheets/SheetChart.tsx"),
      "utf8",
    );
    // A fragment inside a chart hid the column and bar charts' axes.
    expect(src).not.toMatch(/<>|<\/>|<Fragment/);
  });
});
