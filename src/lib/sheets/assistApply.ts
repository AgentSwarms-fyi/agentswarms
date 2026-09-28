// What a proposal from the Sheets assistant does, worked out before anything
// changes: the cell edits, the rule or chart to add, or the sheet to make.
// The editor carries a plan out as one undoable step. A proposal that cannot
// be done says why and changes nothing.

import { parseA1, parseRangeA1, rangeA1, type RangeAddr } from "./a1";
import type { AssistAction } from "./assist";
import type { ChartDef } from "./charts";
import { CF_PRESETS, type CondFormat } from "./condFormat";
import type { WorkbookEngine } from "./engine";
import { shiftFormula } from "./formula/shift";
import { flat, isError } from "./formula/values";
import { WHOLE_TABLE_COLUMN } from "./gridTableResolver";

export type PlannedEdit = { row: number; col: number; input: string; format?: string };

export type ActionPlan =
  | { kind: "edits"; sheetId: string; edits: PlannedEdit[] }
  | { kind: "rule"; sheetId: string; cond: CondFormat[] }
  | { kind: "chart"; sheetId: string; charts: ChartDef[] }
  | { kind: "new_sheet"; name: string; edits: PlannedEdit[] }
  | { kind: "refused"; reason: string };

/** Most rows one proposed formula is filled down. */
export const MAX_FILL_ROWS = 100_000;
/** Most cells one proposed number format touches. */
export const MAX_FORMAT_CELLS = 200_000;

const COLORS = {
  red: CF_PRESETS[0].style,
  yellow: CF_PRESETS[1].style,
  green: CF_PRESETS[2].style,
} as const;

const cellRef = (s: string) => s.replace(/\$/g, "").trim().toUpperCase();

/**
 * One block of cells, or why not. FOUND IN R132: a chart proposed over
 * "A1:A4,C1:C4" failed at Apply with "is not a range", which told the person
 * nothing. Two blocks are named as two.
 */
function oneRange(text: string): { ok: true; r: RangeAddr } | { ok: false; reason: string } {
  const parts = text.split(",").filter((p) => p.trim());
  if (parts.length > 1) {
    return {
      ok: false,
      reason: `"${text}" is ${parts.length} separate blocks of cells; this takes one block, like A1:C4`,
    };
  }
  const r = parseRangeA1(cellRef(text));
  return r ? { ok: true, r } : { ok: false, reason: `"${text}" is not a range such as A1:C4` };
}

/** Values from the assistant as cell inputs: text, numbers, TRUE/FALSE, formulas; null clears. */
export function valueEdits(
  values: (string | number | boolean | null)[][],
  r0: number,
  c0: number,
): PlannedEdit[] {
  const edits: PlannedEdit[] = [];
  values.forEach((line, i) =>
    line.forEach((v, j) =>
      edits.push({
        row: r0 + i,
        col: c0 + j,
        input: v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v),
      }),
    ),
  );
  return edits;
}

/** Most formulas of one answer checked before it is offered. */
export const MAX_CHECKED_FORMULAS = 50;

const asFormula = (s: string) => (s.trim().startsWith("=") ? s.trim() : `=${s.trim()}`);

/**
 * The error a formula shows whatever the cells hold, or null. FOUND IN R133:
 * a proposed =FILTER(Orders, Orders[revenue]>1000) applied cleanly and showed
 * #VALUE!, since a table sheet's rows never come into the grid. An unknown
 * function or name, and a table column read whole, are the formula's own;
 * #DIV/0! or a #VALUE! from a text cell depend on the data and are left be.
 */
function ownError(
  engine: WorkbookEngine,
  sheetId: string,
  row: number,
  col: number,
  formula: string,
): string | null {
  // A total over a table sheet asks the lakehouse here, as applying it would;
  // its answer is kept for when it is applied.
  const bad = flat(engine.evaluateAt(sheetId, row, col, formula, { array: true }))
    .filter(isError)
    .find((e) => e.err === "#NAME?" || e.detail?.includes(WHOLE_TABLE_COLUMN));
  return bad ? `${formula} would show ${bad.err}${bad.detail ? `: ${bad.detail}` : ""}` : null;
}

/**
 * What stops each of an answer's proposals, checked against the workbook
 * before they are offered (R132–R134):
 * - whether it can be carried out at all;
 * - whether it changes anything;
 * - whether a formula it writes errs by itself, computed where it would sit.
 *
 * A proposal on a sheet an earlier proposal of the same answer creates is
 * checked for its shape, and its formulas as if on the active sheet: the
 * errors looked for do not depend on where a formula sits.
 */
export function proposalProblems(
  actions: AssistAction[],
  args: Omit<Parameters<typeof planAction>[1], "newId">,
): { index: number; action: AssistAction; reason: string }[] {
  const { engine, activeSheetId } = args;
  const out: { index: number; action: AssistAction; reason: string }[] = [];
  const coming = new Set<string>();
  let checked = 0;
  const formulaProblem = (sheetId: string, cells: PlannedEdit[]): string | null => {
    for (const c of cells) {
      if (!c.input.startsWith("=") || checked >= MAX_CHECKED_FORMULAS) continue;
      checked++;
      const bad = ownError(engine, sheetId, c.row, c.col, c.input);
      if (bad) return bad;
    }
    return null;
  };
  actions.forEach((a, index) => {
    const push = (reason: string | null) => reason && out.push({ index, action: a, reason });
    if (a.kind !== "new_sheet" && a.sheet && coming.has(a.sheet.toLowerCase())) {
      if (a.kind === "set_formula") {
        const at = parseA1(cellRef(a.cell));
        push(
          at
            ? formulaProblem(activeSheetId, [{ ...at, input: asFormula(a.formula) }])
            : `"${a.cell}" is not a cell`,
        );
        return;
      }
      const got = oneRange(a.range);
      if (!got.ok) push(got.reason);
      else if (a.kind === "set_values")
        push(formulaProblem(activeSheetId, valueEdits(a.values, got.r.r0, got.r.c0)));
      else if (a.kind === "highlight")
        push(
          formulaProblem(activeSheetId, [
            { row: got.r.r0, col: got.r.c0, input: asFormula(a.formula) },
          ]),
        );
      return;
    }
    const plan = planAction(a, { ...args, newId: () => "check" });
    if (plan.kind === "refused") push(plan.reason);
    // FOUND IN R134: after "Explain this formula", the formula the cell already
    // held was offered as a change.
    else if (
      plan.kind === "edits" &&
      a.kind !== "format" &&
      plan.edits.every((e) => e.input === (engine.getInput(plan.sheetId, e.row, e.col)?.i ?? ""))
    )
      push("the cells already hold exactly this; applying it changes nothing");
    // Only the first cell of a formula filled down: the rest are the same formula moved.
    else if (plan.kind === "edits" && a.kind === "set_formula")
      push(formulaProblem(plan.sheetId, plan.edits.slice(0, 1)));
    // A format's edits are the cells as they are; only new values are checked.
    else if (plan.kind === "edits" && a.kind === "set_values")
      push(formulaProblem(plan.sheetId, plan.edits));
    else if (plan.kind === "new_sheet") push(formulaProblem(activeSheetId, plan.edits));
    else if (plan.kind === "rule" && a.kind === "highlight") {
      const r = parseRangeA1(cellRef(a.range));
      if (r)
        push(formulaProblem(plan.sheetId, [{ row: r.r0, col: r.c0, input: asFormula(a.formula) }]));
    }
    if (a.kind === "new_sheet") coming.add(a.name.toLowerCase());
  });
  return out;
}

export function planAction(
  a: AssistAction,
  args: {
    engine: WorkbookEngine;
    /** The sheet a proposal without a sheet name is about. */
    activeSheetId: string;
    newId: () => string;
    /** Column width and row height at 100% zoom, for placing a chart beside its data. */
    colWidth: number;
    rowHeight: number;
  },
): ActionPlan {
  const { engine } = args;
  if (a.kind === "new_sheet") {
    if (engine.sheetIdByName(a.name)) {
      return { kind: "refused", reason: `There is already a sheet named "${a.name}"` };
    }
    return { kind: "new_sheet", name: a.name, edits: valueEdits(a.values, 0, 0) };
  }
  const sheetId = a.sheet ? engine.sheetIdByName(a.sheet) : args.activeSheetId;
  if (!sheetId) return { kind: "refused", reason: `There is no sheet named "${a.sheet}"` };
  const sheet = engine.sheet(sheetId);
  if (sheet?.kind !== "grid") {
    return {
      kind: "refused",
      reason: `${sheet?.name ?? a.sheet} is a table sheet; the assistant changes grid sheets`,
    };
  }
  switch (a.kind) {
    case "set_formula": {
      const at = parseA1(cellRef(a.cell));
      if (!at) return { kind: "refused", reason: `"${a.cell}" is not a cell` };
      const formula = a.formula.trim().startsWith("=") ? a.formula.trim() : `=${a.formula.trim()}`;
      // fill_to_row is 1-based and inclusive, as the person reads row numbers.
      const last = Math.max(at.row, (a.fill_to_row ?? at.row + 1) - 1);
      if (last - at.row + 1 > MAX_FILL_ROWS) {
        return {
          kind: "refused",
          reason: `That fills ${last - at.row + 1} rows; at most ${MAX_FILL_ROWS}`,
        };
      }
      const edits: PlannedEdit[] = [];
      for (let r = at.row; r <= last; r++) {
        edits.push({
          row: r,
          col: at.col,
          // Filled down the way the fill handle does: relative references move.
          input: r === at.row ? formula : shiftFormula(formula, r - at.row, 0),
        });
      }
      return { kind: "edits", sheetId, edits };
    }
    case "set_values": {
      const got = oneRange(a.range);
      if (!got.ok) return { kind: "refused", reason: got.reason };
      const r = got.r;
      return { kind: "edits", sheetId, edits: valueEdits(a.values, r.r0, r.c0) };
    }
    case "format": {
      const got = oneRange(a.range);
      if (!got.ok) return { kind: "refused", reason: got.reason };
      const r = got.r;
      const cells = (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
      if (cells > MAX_FORMAT_CELLS) {
        return { kind: "refused", reason: `That is ${cells} cells; at most ${MAX_FORMAT_CELLS}` };
      }
      const edits: PlannedEdit[] = [];
      for (let row = r.r0; row <= r.r1; row++) {
        for (let col = r.c0; col <= r.c1; col++) {
          const cur = engine.getInput(sheetId, row, col);
          // An empty cell keeps no format of its own; a number typed later takes the column's.
          if (!cur) continue;
          edits.push({ row, col, input: cur.i, format: a.number_format });
        }
      }
      if (!edits.length) return { kind: "refused", reason: `${a.range} is empty` };
      return { kind: "edits", sheetId, edits };
    }
    case "highlight": {
      const got = oneRange(a.range);
      if (!got.ok) return { kind: "refused", reason: got.reason };
      const r = got.r;
      const formula = a.formula.trim().startsWith("=") ? a.formula.trim() : `=${a.formula.trim()}`;
      const rule: CondFormat = {
        id: args.newId(),
        ranges: [rangeA1(r)],
        rule: { kind: "formula", formula, style: COLORS[a.color ?? "red"] },
      };
      // First in the list: the newest rule wins where rules overlap, as in Excel.
      return { kind: "rule", sheetId, cond: [rule, ...(engine.gridOf(sheetId)?.cond ?? [])] };
    }
    case "add_chart": {
      const got = oneRange(a.range);
      if (!got.ok) return { kind: "refused", reason: got.reason };
      const r = got.r;
      const grid = engine.gridOf(sheetId);
      // Beside the data (right of its last column, level with its first
      // row), below any chart already there.
      let x = 0;
      for (let c = 0; c <= r.c1; c++) x += grid?.colWidths?.[String(c)] ?? args.colWidth;
      let y = 0;
      for (let row = 0; row < r.r0; row++) y += grid?.rowHeights?.[String(row)] ?? args.rowHeight;
      x += 24;
      const w = 480;
      const h = 300;
      const existing = grid?.charts ?? [];
      const overlapping = existing.filter((c) => c.x < x + w && c.x + c.w > x);
      if (overlapping.length) y = Math.max(y, ...overlapping.map((c) => c.y + c.h + 16));
      const chart: ChartDef = {
        id: args.newId(),
        type: a.chart,
        range: rangeA1(r),
        ...(a.title ? { title: a.title } : {}),
        legend: "bottom",
        x,
        y,
        w,
        h,
      };
      return { kind: "chart", sheetId, charts: [...existing, chart] };
    }
  }
}
