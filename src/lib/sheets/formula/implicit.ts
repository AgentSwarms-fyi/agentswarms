// Excel's implicit intersection in files (R162).
//
// A plain formula in a file is one from Excel before dynamic arrays (R161).
// Where it expects one value and meets a range, Excel takes the value in the
// formula's own row, and Excel 365 shows an @ there: =Price*Qty over whole
// columns is =@Price*@Qty, row by row, and =SUM(LEN(A2:A4)) is
// =SUM(LEN(@A2:A4)). This engine computes the way Excel 365 does, so a
// file's formula takes those @ on the way in, and gives them back on the way
// out: dropped where the older reading takes the one value anyway, or written
// as _xlfn.SINGLE(…), the file's form of @, where it would not.

import { LIFTS, OWN_LIFTS } from "./functions";
import { lex } from "./lexer";
import { parseFormula, spanOf, type Node } from "./parser";

/**
 * Arguments that Excel, old or new, computes over arrays whatever the
 * formula: nothing inside them takes an @. SUMPRODUCT and LOOKUP are why
 * =SUMPRODUCT((C2:C4>1)*B2:B4) never needed Ctrl+Shift+Enter; the functions
 * of dynamic arrays take arrays by nature. A function missing here is read
 * as today, over arrays, so the list errs on that side.
 */
const ARRAY_ARGS: ReadonlyMap<string, readonly number[] | "all"> = new Map<
  string,
  readonly number[] | "all"
>([
  ["SUMPRODUCT", "all"],
  ["LOOKUP", [1, 2]],
  ["INDEX", [0]],
  ["MMULT", "all"],
  ["MDETERM", "all"],
  ["MINVERSE", "all"],
  ["TRANSPOSE", "all"],
  ["FREQUENCY", "all"],
  ["SUMX2MY2", "all"],
  ["SUMX2PY2", "all"],
  ["SUMXMY2", "all"],
  ["LINEST", "all"],
  ["LOGEST", "all"],
  ["TREND", "all"],
  ["GROWTH", "all"],
  ["CORREL", "all"],
  ["PEARSON", "all"],
  ["RSQ", "all"],
  ["SLOPE", "all"],
  ["INTERCEPT", "all"],
  ["STEYX", "all"],
  ["COVAR", "all"],
  ["COVARIANCE.P", "all"],
  ["COVARIANCE.S", "all"],
  ["FORECAST", [1, 2]],
  ["FORECAST.LINEAR", [1, 2]],
  ["TTEST", [0, 1]],
  ["T.TEST", [0, 1]],
  ["PROB", [0, 1]],
  ["F.TEST", "all"],
  ["FTEST", "all"],
  ["Z.TEST", [0]],
  ["ZTEST", [0]],
  ["CHISQ.TEST", "all"],
  ["CHITEST", "all"],
  ["AGGREGATE", "all"],
  // Dynamic arrays' own.
  ["FILTER", "all"],
  ["SORT", [0]],
  ["SORTBY", "all"],
  ["UNIQUE", [0]],
  ["XLOOKUP", [1, 2]],
  ["XMATCH", [1]],
  ["TAKE", [0]],
  ["DROP", [0]],
  ["CHOOSECOLS", [0]],
  ["CHOOSEROWS", [0]],
  ["VSTACK", "all"],
  ["HSTACK", "all"],
  ["TOCOL", [0]],
  ["TOROW", [0]],
  ["WRAPROWS", [0]],
  ["WRAPCOLS", [0]],
  ["EXPAND", [0]],
  ["TEXTJOIN", "all"],
  ["ARRAYTOTEXT", [0]],
  ["CONCAT", "all"],
]);

type Ctx = "value" | "ref" | "array";

/** How older Excel reads a function's argument: one value, a reference as it is, or an array. */
function argCtx(name: string, i: number, argc: number): Ctx {
  const arr = ARRAY_ARGS.get(name);
  if (arr === "all" || arr?.includes(i)) return "array";
  if (LIFTS.get(name)?.(argc).includes(i) || OWN_LIFTS.get(name)?.includes(i)) return "value";
  return "ref";
}

/** Several cells: A2:A4, B:B, 2:2 (not A1:A1). */
function manyCells(n: Extract<Node, { k: "range" }>): boolean {
  return !!(n.wholeCols || n.wholeRows || n.start.row !== n.end.row || n.start.col !== n.end.col);
}

/** Is a defined name's reference ("Orders!$B:$B") several cells? */
export function refIsRange(ref: string): boolean {
  try {
    const n = parseFormula(ref.startsWith("=") ? ref.slice(1) : ref);
    return n.k === "range" && manyCells(n);
  } catch {
    return false;
  }
}

/** Each node with the way older Excel reads it. */
function walk(n: Node, ctx: Ctx, visit: (n: Node, ctx: Ctx) => void): void {
  visit(n, ctx);
  const inner: Ctx = ctx === "array" ? "array" : "value";
  switch (n.k) {
    case "unary":
    case "percent":
      walk(n.arg, inner, visit);
      break;
    case "bin":
      walk(n.left, inner, visit);
      walk(n.right, inner, visit);
      break;
    case "call":
      n.args.forEach((a, i) =>
        walk(a, ctx === "array" ? "array" : argCtx(n.name, i, n.args.length), visit),
      );
      break;
    case "single":
      walk(n.arg, "ref", visit);
      break;
    case "invoke":
      walk(n.fn, "ref", visit);
      n.args.forEach((a) => walk(a, ctx === "array" ? "array" : "ref", visit));
      break;
    default:
      break;
  }
}

// ── A function's array answer where the cell takes it (R338) ────────────────
//
// FOUND IN R337: older Excel cut a function's array answer to its first
// value where the formula's own cell took it, and Excel 365 shows an @ in
// front of the function there. Microsoft's page on @ gives
// =INDEX(A1:A10,B1) as =@INDEX(A1:A10,B1) and =OFFSET(A1:A2,1,1) as
// =@OFFSET(A1:A2,1,1), with "a common exception ... if they're wrapped in a
// function that accepts an array or range (for example, SUM() or
// AVERAGE())". Without the @ such a file's =LINEST(B2:B7,A2:A7) spilled its
// intercept into the next cell, and =ROW(A2:A4) three rows.

/** Functions whose answer is an array whatever their arguments. */
const ARRAY_ANSWERS = new Set([
  "TRANSPOSE",
  "MMULT",
  "MINVERSE",
  "FREQUENCY",
  "LINEST",
  "LOGEST",
  "TREND",
  "GROWTH",
  "MODE.MULT",
]);

/** A number other than 0 written in the formula. */
const nonZero = (n: Node | undefined) => n?.k === "num" && n.v !== 0;

/** One cell named in the formula: A1, or A1:A1. */
const oneCell = (n: Node | undefined) =>
  n?.k === "cell" ? !n.spill : n?.k === "range" ? !manyCells(n) : false;

/** Can this call answer with several cells or values, as Excel reads it? */
function manyAnswers(n: Extract<Node, { k: "call" }>, isRange: (name: string) => boolean): boolean {
  const name = n.name.toUpperCase();
  const [first, a1, a2, a3, a4] = n.args;
  if (ARRAY_ANSWERS.has(name)) return true;
  switch (name) {
    // "The INDEX function can return an array or range when its second or third argument is 0."
    case "INDEX": {
      const flat =
        first?.k === "range" &&
        (first.start.row === first.end.row || first.start.col === first.end.col) &&
        !first.wholeCols &&
        !first.wholeRows;
      return !(nonZero(a1) && (a2 ? nonZero(a2) : flat));
    }
    // A multi-cell range when the base is one, or a height or width says so.
    case "OFFSET":
      return !(
        oneCell(first) &&
        (!a3 || (a3.k === "num" && a3.v === 1)) &&
        (!a4 || (a4.k === "num" && a4.v === 1))
      );
    case "INDIRECT":
      return !(a1 === undefined && first?.k === "str" && !first.v.includes(":"));
    case "ROW":
    case "COLUMN":
      return (
        !!first &&
        (first.k === "range"
          ? manyCells(first)
          : first.k === "cell"
            ? !!first.spill
            : first.k === "name"
              ? isRange(first.name)
              : false)
      );
    default:
      return false;
  }
}

/** The arguments whose value is the function's own answer: IF's branches, CHOOSE's choices. */
const PASSES_ON: ReadonlyMap<string, (i: number) => boolean> = new Map([
  ["IF", (i: number) => i >= 1],
  ["IFERROR", () => true],
  ["IFNA", () => true],
  ["CHOOSE", (i: number) => i >= 1],
]);

/**
 * Each node with whether its value is the cell's: the formula itself, an
 * operand of an operator whose value is, a value IF or CHOOSE passes on,
 * and an argument a function of one value takes. Not inside a function that
 * takes a range or array (SUM, SUMPRODUCT, INDEX's array).
 */
function walkCell(n: Node, cell: boolean, visit: (n: Node, cell: boolean) => void): void {
  visit(n, cell);
  switch (n.k) {
    case "unary":
    case "percent":
      walkCell(n.arg, cell, visit);
      break;
    case "bin":
      walkCell(n.left, cell, visit);
      walkCell(n.right, cell, visit);
      break;
    case "call": {
      const name = n.name.toUpperCase();
      // Only an argument of one value, or a branch IF or CHOOSE passes on; an
      // array argument (SUMPRODUCT's, INDEX's array) is taken whole.
      n.args.forEach((a, i) => {
        const passes = argCtx(name, i, n.args.length) === "value" || !!PASSES_ON.get(name)?.(i);
        walkCell(a, cell && passes, visit);
      });
      break;
    }
    default:
      break;
  }
}

function parsed(formula: string): { body: string; ast: Node } | null {
  if (!formula.startsWith("=")) return null;
  const body = formula.slice(1);
  try {
    return { body, ast: parseFormula(body) };
  } catch {
    return null;
  }
}

/**
 * A plain formula from a file, with an @ wherever older Excel takes one
 * value from several cells: a range or a range's name where one value is
 * expected. `isRange` says whether a defined name is several cells.
 */
export function withIntersections(formula: string, isRange: (name: string) => boolean): string {
  const p = parsed(formula);
  if (!p) return formula;
  const at: number[] = [];
  walk(p.ast, "value", (n, ctx) => {
    if (ctx !== "value") return;
    // A2# is the whole spill (R171): several cells, as a range is.
    const many =
      n.k === "range"
        ? manyCells(n)
        : n.k === "cell"
          ? !!n.spill
          : n.k === "name"
            ? isRange(n.name)
            : false;
    const s = spanOf(n)?.[0];
    if (many && s !== undefined) at.push(s);
  });
  // Where the cell takes the value: a function that can answer with several
  // (R338), and a range IF or CHOOSE passes on to the cell.
  walkCell(p.ast, true, (n, cell) => {
    if (!cell) return;
    const many =
      n.k === "call"
        ? manyAnswers(n, isRange)
        : n.k === "range"
          ? manyCells(n)
          : n.k === "cell"
            ? !!n.spill
            : n.k === "name"
              ? isRange(n.name)
              : false;
    const s = spanOf(n)?.[0];
    if (many && s !== undefined && !at.includes(s)) at.push(s);
  });
  if (!at.length) return formula;
  let body = p.body;
  for (const s of at.sort((a, b) => b - a)) body = `${body.slice(0, s)}@${body.slice(s)}`;
  return `=${body}`;
}

/** Excel 365's SINGLE(x), the file's way to keep an @ in a dynamic formula, as @(x). */
export function singleFromFile(formula: string): string {
  if (!/single/i.test(formula) || !formula.startsWith("=")) return formula;
  let body = formula.slice(1);
  let tokens;
  try {
    tokens = lex(body);
  } catch {
    return formula;
  }
  const at = tokens
    .filter((t) => t.t === "func" && t.name.toUpperCase() === "SINGLE")
    .map((t) => [t.s, t.e] as const)
    .sort((a, b) => b[0] - a[0]);
  for (const [s, e] of at) body = `${body.slice(0, s)}@${body.slice(e)}`;
  return `=${body}`;
}

/**
 * A formula's @ as the file must hold it. In a plain formula, an @ where
 * older Excel takes one value anyway is dropped: the file then reads as it
 * always did. Anywhere else, or in a dynamic array formula, it is written
 * _xlfn.SINGLE(…), which Excel 365 shows as @.
 */
export function intersectionsForFile(formula: string, dynamic: boolean): string {
  if (!formula.includes("@")) return formula;
  const p = parsed(formula);
  if (!p) return formula;
  const edits: { at: number; del: number; ins: string }[] = [];
  // Where the cell takes the value, older Excel took one value from a range
  // or a function's answer anyway (R338).
  const atCell = new Set<Node>();
  walkCell(p.ast, true, (n, cell) => {
    if (cell && n.k === "single") atCell.add(n);
  });
  walk(p.ast, "value", (n, ctx) => {
    if (n.k !== "single") return;
    const span = spanOf(n);
    if (!span) return;
    const [s, e] = span;
    const plainRead = n.arg.k === "range" || n.arg.k === "name" || n.arg.k === "cell";
    const cellRead =
      atCell.has(n) && (plainRead || (n.arg.k === "call" && manyAnswers(n.arg, () => true)));
    if (!dynamic && ((ctx === "value" && plainRead) || cellRead)) {
      edits.push({ at: s, del: 1, ins: "" });
    } else {
      edits.push({ at: s, del: 1, ins: "_xlfn.SINGLE(" }, { at: e, del: 0, ins: ")" });
    }
  });
  let body = p.body;
  for (const x of edits.sort((a, b) => b.at - a.at))
    body = body.slice(0, x.at) + x.ins + body.slice(x.at + x.del);
  return `=${body}`;
}
