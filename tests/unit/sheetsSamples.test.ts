// The sample workbooks the Sheets page offers (Phase I), read back the way an
// import reads them: the app's own .xlsx reader, then the engine. The figures
// checked here were computed independently, in Python with openpyxl, from the
// rows of each file (see UI_TEST_RESULTS, Phase I), so a change to the
// generator or to a function that moves a number shows up here.
import { readFileSync, existsSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { SHEETS_SAMPLES } from "@/lib/sheets/samples";
import { readXlsx } from "@/lib/sheets/xlsx";

const dir = "public/samples/sheets";

async function open(file: string) {
  const buf = readFileSync(`${dir}/${file}`);
  const r = await readXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), {
    maxCells: 200_000,
  });
  const engine = new WorkbookEngine(
    r.sheets.map((s, i) => ({ id: `s${i}`, name: s.name, kind: "grid" as const, grid: s.grid })),
  );
  const id = (name: string) => `s${r.sheets.findIndex((s) => s.name === name)}`;
  const at = (sheet: string, ref: string) => {
    const col = ref.charCodeAt(0) - 65;
    const row = Number(ref.slice(1)) - 1;
    return engine.getValue(id(sheet), row, col);
  };
  return { r, engine, at, grid: (name: string) => r.sheets.find((s) => s.name === name)!.grid };
}

const near = (a: unknown, b: number) => expect(a as number).toBeCloseTo(b, 6);

describe("the sample workbooks", () => {
  it("every one offered is in the repository", () => {
    expect(SHEETS_SAMPLES.length).toBe(3);
    for (const s of SHEETS_SAMPLES) expect(existsSync(`${dir}/${s.file}`), s.file).toBe(true);
  });

  it("Sales performance 2026: lookups, totals by month, charts, rules and dropdowns", async () => {
    const { r, at, grid } = await open("sales-performance-2026.xlsx");
    expect(r.sheets.map((s) => s.name)).toEqual(["Dashboard", "Orders", "Products", "Reps"]);
    // Independently: 240 orders, 12 returned; revenue 448,677 on the rest.
    expect(at("Dashboard", "A5")).toBe(448677);
    near(at("Dashboard", "B5"), 0.5770030556502785);
    expect(at("Dashboard", "C5")).toBe(228);
    expect(at("Dashboard", "E5")).toBe(12);
    expect(at("Dashboard", "H9")).toBe(245539);
    expect(at("Dashboard", "B9")).toBe(21597);
    expect(at("Dashboard", "E20")).toBe(12172);
    expect(at("Dashboard", "H14")).toBe("Gadget");
    expect(at("Dashboard", "J9")).toBe("Asha Rao");
    expect(at("Reps", "D2")).toBe(93973);
    expect(grid("Dashboard").charts?.map((c) => c.type)).toEqual(["line", "column", "doughnut"]);
    expect(grid("Reps").charts?.map((c) => c.type)).toEqual(["combo"]);
    expect(grid("Orders").cond?.length).toBe(3);
    expect(grid("Orders").validations?.length).toBe(4);
    expect(grid("Orders").filter?.range).toBe("A1:L241");
    // R141: the months (dates) are the categories, not a fifth series.
    const files = unzipSync(new Uint8Array(readFileSync(`${dir}/sales-performance-2026.xlsx`)));
    const months = Object.entries(files)
      .filter(([n]) => /^xl\/charts\/chart\d+\.xml$/.test(n))
      .map(([, b]) => strFromU8(b))
      .find((x) => x.includes("Revenue by month and region"))!;
    expect(months.match(/<c:ser>/g)).toHaveLength(4);
    expect(months).toContain("<c:f>Dashboard!$A$9:$A$20</c:f>");
    // And the leaderboard's spilled figures are dollars, like its first.
    expect(grid("Dashboard").cells["10,10"]?.f).toBe('"$"#,##0');
  });

  it("Project tracker: counts and hours by status, and the charts", async () => {
    const { r, at, grid } = await open("project-tracker.xlsx");
    expect(r.sheets.map((s) => s.name)).toEqual(["Summary", "Tasks", "Team"]);
    expect([
      at("Summary", "B5"),
      at("Summary", "B6"),
      at("Summary", "B7"),
      at("Summary", "B8"),
    ]).toEqual([5, 4, 1, 4]);
    near(at("Summary", "C6"), 46.2);
    near(at("Summary", "B12"), 0.39936305732484073);
    expect(grid("Summary").charts?.map((c) => c.type)).toEqual(["pie", "radar"]);
    expect(grid("Team").charts?.map((c) => c.type)).toEqual(["bar"]);
    expect(grid("Tasks").validations?.length).toBe(4);
  });

  it("no chart covers a filled cell, the cells a formula spills into included", async () => {
    // The grid's default column width and row height (SheetGrid).
    const grid = readFileSync("src/components/sheets/SheetGrid.tsx", "utf8");
    expect(grid).toContain("export const ROW_H = 24;");
    expect(grid).toContain("export const DEFAULT_COL_W = 104;");
    const covered: string[] = [];
    for (const s of SHEETS_SAMPLES) {
      const { r, engine } = await open(s.file);
      r.sheets.forEach((sheet, i) => {
        const g = sheet.grid;
        const colX = (c: number) => {
          let x = 0;
          for (let k = 0; k < c; k++) x += g.colWidths?.[String(k)] ?? 104;
          return x;
        };
        const rowY = (row: number) => {
          let y = 0;
          for (let k = 0; k < row; k++) y += g.rowHeights?.[String(k)] ?? 24;
          return y;
        };
        const filled: [number, number][] = [];
        for (const key of Object.keys(g.cells)) {
          if (!g.cells[key].i) continue;
          const [row, col] = key.split(",").map(Number);
          const spill = engine.spillSize(`s${i}`, row, col) ?? { rows: 1, cols: 1 };
          for (let dr = 0; dr < spill.rows; dr++)
            for (let dc = 0; dc < spill.cols; dc++) filled.push([row + dr, col + dc]);
        }
        for (const ch of g.charts ?? []) {
          for (const [row, col] of filled) {
            const inX = colX(col) < ch.x + ch.w && colX(col + 1) > ch.x;
            const inY = rowY(row) < ch.y + ch.h && rowY(row + 1) > ch.y;
            if (inX && inY)
              covered.push(`${s.file} ${sheet.name} "${ch.title}" covers ${row},${col}`);
          }
        }
      });
    }
    expect(covered).toEqual([]);
  });

  it("Budget and cash flow: the scenario drives the model", async () => {
    const { r, at, grid, engine } = await open("budget-cash-flow.xlsx");
    expect(r.sheets.map((s) => s.name)).toEqual(["Assumptions", "Model", "Scenarios"]);
    expect(at("Model", "M2")).toBe(1491);
    expect(at("Model", "N7")).toBe(43400);
    expect(at("Model", "N8")).toBe(193400);
    expect(grid("Model").charts?.map((c) => c.type)).toEqual(["combo", "area", "scatter"]);
    // Picking another scenario moves the whole model.
    const a = `s${r.sheets.findIndex((s) => s.name === "Assumptions")}`;
    engine.setInput(a, 3, 1, "Worst");
    expect(at("Assumptions", "B5")).toBe(0.01);
    expect(at("Model", "N8") as number).toBeLessThan(193400);
  });
});
