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
  walk(p.ast, "value", (n, ctx) => {
    if (n.k !== "single") return;
    const span = spanOf(n);
    if (!span) return;
    const [s, e] = span;
    const plainRead = n.arg.k === "range" || n.arg.k === "name" || n.arg.k === "cell";
    if (!dynamic && ctx === "value" && plainRead) {
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
