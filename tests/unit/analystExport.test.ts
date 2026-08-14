// Exporting an analysis to a workbook. Two things carry the risk: Excel's
// sheet-name rules (a duplicate makes the file unopenable, and truncation
// manufactures duplicates), and the qualifiers — governed model, check
// verdict, verification, scenario labelling — which a spreadsheet strips off
// the moment they are not in the cells themselves.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  analystWorkbook,
  summarySheet,
  uniqueSheetNames,
  workbookFilename,
} from "@/lib/analystExport";
import { safeSheetName } from "@/lib/exportData";
import { markTurn } from "@/lib/analystVerification";
import type { AnalystStep, AnalystTurn } from "@/lib/aiAnalyst";

const step = (over: Partial<AnalystStep> = {}): AnalystStep => ({
  goal: "Total by region",
  sql: "SELECT 1",
  status: "done",
  columns: ["region", "total"],
  rows: [{ region: "EMEA", total: 10 }],
  ...over,
});

const turn = (over: Partial<AnalystTurn> = {}): AnalystTurn => ({
  question: "Which region sold most?",
  approach: "Total by region.",
  answer: "EMEA (step 1).",
  status: "done",
  steps: [step()],
  ...over,
});

const meta = { analystName: "Sales analyst", model: "gpt-5-mini", sourceText: "saas_sales" };

describe("sheet names Excel will actually accept", () => {
  it("strips the forbidden characters and caps at 31", () => {
    expect(safeSheetName("a/b\\c?d*e[f]g:h")).toBe("a b c d e f g h");
    expect(safeSheetName("x".repeat(50))).toHaveLength(31);
    expect(safeSheetName(undefined)).toBe("Sheet1");
    expect(safeSheetName("   ")).toBe("Sheet1");
  });

  it("de-duplicates AFTER truncation, which is where duplicates appear", () => {
    // These differ only past character 31. Truncated they are identical, and
    // a workbook with two identical sheet names does not open.
    const long = "Total sales by region and segm";
    const names = uniqueSheetNames([`${long}ent A`, `${long}ent B`]);
    expect(names[0]).not.toBe(names[1]);
    expect(names.every((n) => n.length <= 31)).toBe(true);
  });

  it("keeps room for the suffix rather than letting it be cut off", () => {
    const names = uniqueSheetNames(["y".repeat(40), "y".repeat(40), "y".repeat(40)]);
    expect(new Set(names).size).toBe(3);
    expect(names[1]).toMatch(/\(2\)$/);
    expect(names[2]).toMatch(/\(3\)$/);
    expect(names.every((n) => n.length <= 31)).toBe(true);
  });

  it("treats names differing only in case as duplicates, as Excel does", () => {
    // Asserting inequality alone proves nothing here — "Region" and "region"
    // are unequal strings whether or not they were de-duplicated. The suffix
    // is the evidence that the collision was actually detected.
    const names = uniqueSheetNames(["Region", "region"]);
    expect(names[0]).toBe("Region");
    expect(names[1]).toBe("region (2)");
  });
});

describe("the overview sheet carries the qualifiers", () => {
  it("names the governed model and the check verdict per step", () => {
    const s = summarySheet({
      ...meta,
      turns: [
        turn({
          steps: [
            step({ governed: { model: "sales_model" }, check: { verdict: "pass", note: "ok" } }),
          ],
        }),
      ],
    });
    const values = s.rows.map((r) => String(r.Value));
    expect(values.some((v) => v.includes("compiled from governed model sales_model"))).toBe(true);
    expect(values.some((v) => v.includes("check: pass"))).toBe(true);
  });

  it("carries a human verdict, and a stale-findings caveat", () => {
    const marked = markTurn({
      turn: turn(),
      state: "verified",
      at: "2026-08-14T00:00:00.000Z",
      by: "rimo",
    })!;
    const s = summarySheet({ ...meta, turns: [{ ...marked, answerStale: true }] });
    const values = s.rows.map((r) => String(r.Value));
    // The verdict VOIDS here (answerStale does not change steps, so it stays
    // active) — what matters is that some verdict text travels.
    expect(values.some((v) => v.includes("Verified by rimo"))).toBe(true);
    expect(values.some((v) => v.includes("written before a step was re-run"))).toBe(true);
  });

  it("stamps when the export was taken", () => {
    // A workbook outlives the query behind it. An "Exported" row with no date
    // is worse than no row: it looks like provenance and carries none.
    const s = summarySheet({ ...meta, turns: [turn()], exportedAt: new Date(2026, 7, 14) });
    const stamp = s.rows.find((r) => r.Field === "Exported");
    expect(String(stamp?.Value)).toContain("2026");
  });

  it("marks a hand-edited step as such", () => {
    const s = summarySheet({ ...meta, turns: [turn({ steps: [step({ edited: true })] })] });
    expect(s.rows.some((r) => String(r.Value).includes("edited by hand"))).toBe(true);
  });
});

describe("the workbook", () => {
  it("puts the overview first, then one sheet per step result", () => {
    const wb = analystWorkbook({
      ...meta,
      turns: [turn({ steps: [step(), step({ goal: "By segment" })] })],
    });
    expect(wb[0].name).toBe("Analysis");
    expect(wb).toHaveLength(3);
    expect(wb[1].columns).toEqual(["region", "total"]);
  });

  it("SKIPS a step with no rows rather than exporting an empty sheet", () => {
    // An empty sheet named after a step reads as "this returned nothing",
    // which is indistinguishable from "this step failed".
    const wb = analystWorkbook({
      ...meta,
      turns: [turn({ steps: [step({ rows: [], columns: [] }), step()] })],
    });
    expect(wb).toHaveLength(2);
  });

  it("exports a scenario on its own sheet, labelled in a COLUMN", () => {
    // In a column, not just the sheet name: sorting, filtering or a
    // copy-paste separates a name from its rows, and an unlabelled
    // hypothetical becomes a measurement.
    const wb = analystWorkbook({
      ...meta,
      turns: [
        turn({
          steps: [
            step({
              scenario: {
                changes: [],
                label: "Scenario — commission_rate 0.1 → 0.15",
                sql: "SELECT 1",
                columns: ["region", "total"],
                rows: [{ region: "EMEA", total: 8 }],
                delta: [],
              },
            }),
          ],
        }),
      ],
    });
    const scenario = wb[2];
    expect(scenario.name).toMatch(/scenario/i);
    expect(scenario.columns[0]).toBe("SCENARIO (not measured)");
    expect(scenario.rows[0]["SCENARIO (not measured)"]).toBe(
      "Scenario — commission_rate 0.1 → 0.15",
    );
  });

  it("gives every sheet a unique, legal name even for similar goals", () => {
    const long = "Revenue by region and segment and product line";
    const wb = analystWorkbook({
      ...meta,
      turns: [turn({ steps: [step({ goal: `${long} A` }), step({ goal: `${long} B` })] })],
    });
    const names = wb.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.length <= 31)).toBe(true);
  });

  it("still produces a workbook when nothing has rows", () => {
    const wb = analystWorkbook({ ...meta, turns: [turn({ steps: [step({ rows: [] })] })] });
    expect(wb).toHaveLength(1);
    expect(wb[0].name).toBe("Analysis");
  });
});

describe("the filename", () => {
  it("keeps it readable and free of path characters", () => {
    expect(workbookFilename("Q4: revenue / margin?")).toBe("Q4 revenue margin");
    expect(workbookFilename("")).toBe("analysis");
    expect(workbookFilename("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("the wiring", () => {
  const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");

  it("offers the export beside the PDF, from the same turns", () => {
    // Scoped to saveWorkbook: `turns: turnsToRender` also appears in savePdf,
    // so an unscoped check stayed green with the export handed an empty list.
    const fn = page.slice(page.indexOf("async function saveWorkbook()"));
    const body = fn.slice(0, fn.indexOf("async function savePdf()"));
    expect(body).toContain("analystWorkbook({");
    expect(body).toContain("downloadXlsxWorkbook(sheets,");
    expect(body).toContain("turns: turnsToRender,");
    // The same provenance the PDF uses — not the analyst's current model.
    expect(body).toContain("modelsUsedIn(turnsToRender, selected.model)");
  });
});
