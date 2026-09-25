// The formula evaluator: syntax tree + environment → value.
//
// Synchronous on purpose. Cells are pulled from the environment (which owns
// recalculation, caching and cycles); table references (Orders[amount]) are
// answered by the environment's `table` hook, which may say PENDING while the
// server computes them. Operators broadcast over arrays, as Excel's dynamic
// arrays do.

import type { Node } from "./parser";
import {
  compareScalars,
  err,
  isError,
  isMatrix,
  scalarOf,
  toNumber,
  toText,
  type Matrix,
  type Scalar,
  type Value,
} from "./values";
import { FUNCTIONS } from "./functions";

export type RangeRef = {
  sheet: string;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  /** A:C or 2:4 — read to the data's extent, but DEPENDS on every row/column. */
  whole?: "cols" | "rows";
};

/** Returned by the table hook while a server-side answer is on its way. */
export const PENDING = Symbol("pending");

/**
 * A function call over table-sheet columns, answered by the lakehouse:
 * =SUMIFS(Orders[amount], Orders[region], A2) sends the columns by name and
 * A2's value, never the table's rows.
 */
export type TableCallArg =
  | { col: { table: string; column: string } }
  | { cols: { table: string; from: string; to: string } }
  | { table: string }
  | { call: TableCallRequest }
  | { value: Scalar };
export type TableCallRequest = { fn: string; args: TableCallArg[] };

/** Functions whose table-column arguments the lakehouse evaluates. */
export const TABLE_PUSHDOWN = new Set([
  "SUM",
  "AVERAGE",
  "COUNT",
  "COUNTA",
  "COUNTBLANK",
  "MIN",
  "MAX",
  "MEDIAN",
  "STDEV",
  "STDEV.S",
  "STDEV.P",
  "VAR",
  "VAR.S",
  "VAR.P",
  "SUMPRODUCT",
  "SUMIF",
  "SUMIFS",
  "COUNTIF",
  "COUNTIFS",
  "AVERAGEIF",
  "AVERAGEIFS",
  "MINIFS",
  "MAXIFS",
  "XLOOKUP",
  "VLOOKUP",
  "INDEX",
  "RANK",
  "RANK.EQ",
  "ROWS",
]);

export interface EvalEnv {
  /** The sheet the formula lives on (by name, as formulas refer to sheets). */
  sheet: string;
  /** The cell being computed, zero-based. */
  row: number;
  col: number;
  cell(sheet: string, row: number, col: number): Scalar;
  range(ref: RangeRef): Matrix;
  hasSheet(name: string): boolean;
  /** How far down/right a sheet has data, for whole-column/row references. */
  used(sheet: string): { rows: number; cols: number };
  /** Structured references to table sheets; absent = no tables here. */
  table?(node: Extract<Node, { k: "struct" }>): Value | typeof PENDING;
  /** Is this name a table sheet of the workbook? */
  isTable?(name: string): boolean;
  /** A call over table-sheet columns, computed by the lakehouse. */
  tableCall?(req: TableCallRequest): Value | typeof PENDING;
  now?: Date;
}

/** Thrown through the evaluator when a table answer is pending. */
export class PendingValue extends Error {
  constructor() {
    super("pending");
  }
}

/** A lazily evaluated argument. */
export type Arg = {
  node: Node;
  /** Evaluate (cached). Ranges stay matrices. */
  value(): Value;
  /** Is this argument a reference (cell/range/struct)? Some functions care. */
  isRef: boolean;
  /** The range this argument names, when it is a range or cell (for ROW/COLUMN/OFFSET-like needs). */
  ref?: RangeRef;
};

export type FnCtx = { env: EvalEnv; name: string };
export type FnImpl = (args: Arg[], ctx: FnCtx) => Value;

const MISSING = Symbol("missing");
export type Missing = typeof MISSING;
export const isMissing = (a: Arg) => a.node.k === "empty";

function rangeOf(node: Node, env: EvalEnv): RangeRef | undefined {
  if (node.k === "cell") {
    return {
      sheet: node.sheet ?? env.sheet,
      r0: node.ref.row,
      c0: node.ref.col,
      r1: node.ref.row,
      c1: node.ref.col,
    };
  }
  if (node.k === "range") {
    const sheet = node.sheet ?? env.sheet;
    if (node.wholeCols) {
      const used = env.used(sheet);
      return {
        sheet,
        r0: 0,
        c0: Math.min(node.start.col, node.end.col),
        r1: Math.max(0, used.rows - 1),
        c1: Math.max(node.start.col, node.end.col),
        whole: "cols",
      };
    }
    if (node.wholeRows) {
      const used = env.used(sheet);
      return {
        sheet,
        r0: Math.min(node.start.row, node.end.row),
        c0: 0,
        r1: Math.max(node.start.row, node.end.row),
        c1: Math.max(0, used.cols - 1),
        whole: "rows",
      };
    }
    return {
      sheet,
      r0: Math.min(node.start.row, node.end.row),
      c0: Math.min(node.start.col, node.end.col),
      r1: Math.max(node.start.row, node.end.row),
      c1: Math.max(node.start.col, node.end.col),
    };
  }
  return undefined;
}

/** Apply fn to every element of one or two values, broadcasting scalars (dynamic arrays). */
function broadcast(a: Value, b: Value, fn: (x: Scalar, y: Scalar) => Scalar): Value {
  if (!isMatrix(a) && !isMatrix(b)) return fn(a, b);
  const A = isMatrix(a) ? a : [[a]];
  const B = isMatrix(b) ? b : [[b]];
  const rows = Math.max(A.length, B.length);
  const cols = Math.max(A[0]?.length ?? 0, B[0]?.length ?? 0);
  const pick = (M: Matrix, r: number, c: number): Scalar | undefined => {
    const rr = M.length === 1 ? 0 : r;
    const cc = (M[0]?.length ?? 0) === 1 ? 0 : c;
    return M[rr]?.[cc];
  };
  const out: Matrix = [];
  for (let r = 0; r < rows; r++) {
    const line: Scalar[] = [];
    for (let c = 0; c < cols; c++) {
      const x = pick(A, r, c);
      const y = pick(B, r, c);
      line.push(x === undefined || y === undefined ? err("#N/A") : fn(x, y));
    }
    out.push(line);
  }
  return out;
}

function mapValue(v: Value, fn: (x: Scalar) => Scalar): Value {
  return isMatrix(v) ? v.map((row) => row.map(fn)) : fn(v);
}

function arith(op: string, x: Scalar, y: Scalar): Scalar {
  const a = toNumber(x);
  if (isError(a)) return a;
  const b = toNumber(y);
  if (isError(b)) return b;
  let r: number;
  switch (op) {
    case "+":
      r = a + b;
      break;
    case "-":
      r = a - b;
      break;
    case "*":
      r = a * b;
      break;
    case "/":
      if (b === 0) return err("#DIV/0!");
      r = a / b;
      break;
    case "^":
      if (a === 0 && b < 0) return err("#DIV/0!");
      r = Math.pow(a, b);
      break;
    default:
      return err("#VALUE!");
  }
  return Number.isFinite(r) ? r : err("#NUM!");
}

function compare(op: string, x: Scalar, y: Scalar): Scalar {
  if (isError(x)) return x;
  if (isError(y)) return y;
  const c = compareScalars(x, y);
  switch (op) {
    case "=":
      return c === 0;
    case "<>":
      return c !== 0;
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case ">=":
      return c >= 0;
  }
  return err("#VALUE!");
}

export function evaluate(node: Node, env: EvalEnv): Value {
  switch (node.k) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "bool":
      return node.v;
    case "err":
      return err(node.v);
    case "empty":
      return null;
    case "cell": {
      const sheet = node.sheet ?? env.sheet;
      if (node.sheet && !env.hasSheet(node.sheet)) return err("#REF!", `No sheet "${node.sheet}"`);
      return env.cell(sheet, node.ref.row, node.ref.col);
    }
    case "range": {
      if (node.sheet && !env.hasSheet(node.sheet)) return err("#REF!", `No sheet "${node.sheet}"`);
      return env.range(rangeOf(node, env)!);
    }
    case "struct": {
      if (!env.table) return err("#REF!", "Table references need a table sheet");
      const v = env.table(node);
      if (v === PENDING) throw new PendingValue();
      return v;
    }
    case "name":
      return err("#NAME?", `Unknown name "${node.name}"`);
    case "array":
      return node.rows.map((row) => row.map((n) => scalarOf(evaluate(n, env))));
    case "unary": {
      const v = evaluate(node.arg, env);
      if (node.op === "+") return v;
      return mapValue(v, (x) => {
        const n = toNumber(x);
        return isError(n) ? n : -n;
      });
    }
    case "percent": {
      const v = evaluate(node.arg, env);
      return mapValue(v, (x) => {
        const n = toNumber(x);
        return isError(n) ? n : n / 100;
      });
    }
    case "bin": {
      const a = evaluate(node.left, env);
      const b = evaluate(node.right, env);
      if (node.op === "&") {
        return broadcast(a, b, (x, y) => {
          const s = toText(x);
          if (isError(s)) return s;
          const t = toText(y);
          if (isError(t)) return t;
          return s + t;
        });
      }
      if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
        return broadcast(a, b, (x, y) => compare(node.op, x, y));
      }
      return broadcast(a, b, (x, y) => arith(node.op, x, y));
    }
    case "call": {
      const impl = FUNCTIONS[node.name];
      if (!impl) return err("#NAME?", `Unknown function ${node.name}`);
      if (env.tableCall && TABLE_PUSHDOWN.has(node.name)) {
        const req = tableCallRequest(node, env);
        if (req && "error" in req) return req.error;
        if (req) {
          const v = env.tableCall(req);
          if (v === PENDING) throw new PendingValue();
          return v;
        }
      }
      const args: Arg[] = node.args.map((n) => {
        let cached: Value | undefined;
        let done = false;
        return {
          node: n,
          isRef: n.k === "cell" || n.k === "range" || n.k === "struct",
          ref: rangeOf(n, env),
          value() {
            if (!done) {
              cached = evaluate(n, env);
              done = true;
            }
            return cached as Value;
          },
        };
      });
      return impl(args, { env, name: node.name });
    }
  }
}

/**
 * The pushdown form of a call, when it reads table-sheet columns and nothing
 * else by range; null when it does not (it is then evaluated here, and a
 * table column read directly says how to use it). An error in a value
 * argument is the call's answer, as it would be in Excel.
 */
export function tableCallRequest(
  node: Extract<Node, { k: "call" }>,
  env: EvalEnv,
): TableCallRequest | { error: Scalar } | null {
  const isTable = (name: string | undefined) => Boolean(name && env.isTable?.(name));
  let tables = 0;
  const args: TableCallArg[] = [];
  for (const a of node.args) {
    if (a.k === "struct" && a.table && !a.thisRow) {
      if (!isTable(a.table)) return null;
      tables++;
      args.push(
        a.endColumn
          ? { cols: { table: a.table, from: a.column, to: a.endColumn } }
          : { col: { table: a.table, column: a.column } },
      );
      continue;
    }
    if (a.k === "name" && isTable(a.name)) {
      tables++;
      args.push({ table: a.name });
      continue;
    }
    if (a.k === "call" && a.name === "MATCH" && node.name === "INDEX") {
      const inner = tableCallRequest(a, env);
      if (!inner) return null;
      if ("error" in inner) return inner;
      tables++;
      args.push({ call: inner });
      continue;
    }
    if (a.k === "range" || a.k === "struct" || a.k === "array") return null;
    const v = evaluate(a, env);
    if (isMatrix(v)) return null;
    if (isError(v)) return { error: v };
    args.push({ value: v });
  }
  return tables ? { fn: node.name, args } : null;
}

export { MISSING };
