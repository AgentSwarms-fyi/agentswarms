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
  type SheetError,
  type Value,
} from "./values";
import { FUNCTIONS, LIFTS, OWN_LIFTS } from "./functions";
import { paramName } from "./scope";
import { tailOf, wholeRange, zipN } from "./arrays";

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
  /**
   * Where the formula at (row, col) spills, for A2# (R171): from it to the
   * far corner of its array, or #REF! when it does not spill.
   */
  spillRange?(sheet: string, row: number, col: number): RangeRef | SheetError;
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
  /** Is a row hidden, and how (SUBTOTAL leaves filtered rows out; 101–111 hand-hidden ones too)? */
  rowHidden?(sheet: string, row: number): "filter" | "manual" | null;
  /** A cell's formula, when it holds one (ISFORMULA, FORMULATEXT, SUBTOTAL). */
  formula?(sheet: string, row: number, col: number): string | undefined;
  /** Names LET has given values to, and a LAMBDA's parameters, lower-cased. */
  names?: ReadonlyMap<string, Value>;
  /** The workbook's sheets, table sheets too, in tab order (SHEET and SHEETS, R331). */
  sheetNames?: () => readonly string[];
  /** LAMBDA parameters this call left out, lower-cased (ISOMITTED, R328). */
  omitted?: ReadonlySet<string>;
  /** How many LAMBDA calls deep this is: a recursion stops where Excel's does (LAMBDA_STACK). */
  depth?: number;
  /** A workbook's defined name (Revenue, TaxRate): what it refers to, parsed (R148). */
  definedName?(name: string): Node | undefined;
  /** Defined names being evaluated, so one that refers to itself says so. */
  naming?: ReadonlySet<string>;
  /**
   * Told when the formula works over several values where Excel before
   * dynamic arrays took one: an operator on a range, or a function of single
   * values given one (R161). A download marks such a formula as a dynamic
   * array formula, so that Excel computes it as this engine did.
   */
  onArray?(): void;
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

export type FnCtx = {
  env: EvalEnv;
  name: string;
  /** Evaluate a formula tree here (INDIRECT reads the reference its text names). */
  evaluate?: (node: Node) => Value;
};
export type FnImpl = (args: Arg[], ctx: FnCtx) => Value;

const MISSING = Symbol("missing");
export type Missing = typeof MISSING;
export const isMissing = (a: Arg) => a.node.k === "empty";

/** The range A2# names, or why it names none. */
function spillOf(node: Extract<Node, { k: "cell" }>, env: EvalEnv): RangeRef | SheetError {
  if (!env.spillRange) return err("#REF!", "A spill reference needs a workbook");
  return env.spillRange(node.sheet ?? env.sheet, node.ref.row, node.ref.col);
}

function rangeOf(node: Node, env: EvalEnv): RangeRef | undefined {
  if (node.k === "cell" && node.spill) {
    const ref = spillOf(node, env);
    return isError(ref) ? undefined : ref;
  }
  if (node.k === "cell") {
    return {
      sheet: node.sheet ?? env.sheet,
      r0: node.ref.row,
      c0: node.ref.col,
      r1: node.ref.row,
      c1: node.ref.col,
    };
  }
  if (node.k === "name") {
    // A defined name for a cell or range is that reference, wherever one is needed.
    const def = env.definedName?.(node.name);
    return def && (def.k === "cell" || def.k === "range") ? rangeOf(def, env) : undefined;
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

/** Several values, or a whole column or row: where older Excel took the one in the formula's row. */
const manyValues = (v: Value): boolean =>
  isMatrix(v) && (v.length > 1 || (v[0]?.length ?? 0) > 1 || !!tailOf(v));

/** Apply fn to every element of one or two values, broadcasting scalars (dynamic arrays). */
function broadcast(a: Value, b: Value, fn: (x: Scalar, y: Scalar) => Scalar): Value {
  return zipN([a, b], ([x, y]) => fn(x, y));
}

function mapValue(v: Value, fn: (x: Scalar) => Scalar): Value {
  return zipN([v], ([x]) => fn(x));
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

/**
 * A number as Excel compares it: to 15 significant digits.
 * FOUND IN R327: `=0.1+0.2=0.3` was FALSE here and is TRUE in Excel, and
 * `=(0.1+0.2)>0.3` was TRUE. Only the comparison operators do this, as in
 * Excel: MATCH, the lookups and sorting compare the stored values, which is
 * why a lookup of a computed value can miss in Excel too.
 */
const sig15 = (n: number): number =>
  Number.isFinite(n) && n !== 0 ? Number(n.toPrecision(15)) : n;

function compare(op: string, x: Scalar, y: Scalar): Scalar {
  if (isError(x)) return x;
  if (isError(y)) return y;
  const c =
    typeof x === "number" && typeof y === "number" ? sig15(x) - sig15(y) : compareScalars(x, y);
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
      if (node.spill) {
        const ref = spillOf(node, env);
        return isError(ref) ? ref : env.range(ref);
      }
      return env.cell(sheet, node.ref.row, node.ref.col);
    }
    case "range": {
      if (node.sheet && !env.hasSheet(node.sheet)) return err("#REF!", `No sheet "${node.sheet}"`);
      const ref = rangeOf(node, env)!;
      const m = env.range(ref);
      // A whole column keeps its blank rest as a tail (R146).
      return ref.whole ? wholeRange(m, ref.whole) : m;
    }
    case "struct": {
      if (!env.table) return err("#REF!", "Table references need a table sheet");
      const v = env.table(node);
      if (v === PENDING) throw new PendingValue();
      return v;
    }
    case "name": {
      const bound = env.names?.get(node.name.toLowerCase());
      if (bound !== undefined) return bound;
      const def = env.definedName?.(node.name);
      if (def) {
        const key = node.name.toLowerCase();
        if (env.naming?.has(key)) return err("#CYCLE!", `The name ${node.name} refers to itself`);
        return evaluate(def, { ...env, naming: new Set([...(env.naming ?? []), key]) });
      }
      return err("#NAME?", `Unknown name "${node.name}"`);
    }
    case "array":
      return node.rows.map((row) => row.map((n) => scalarOf(evaluate(n, env))));
    case "single":
      return intersect(node.arg, env);
    case "unary": {
      const v = evaluate(node.arg, env);
      if (node.op === "+") return v;
      if (manyValues(v)) env.onArray?.();
      return mapValue(v, (x) => {
        const n = toNumber(x);
        return isError(n) ? n : -n;
      });
    }
    case "percent": {
      const v = evaluate(node.arg, env);
      if (manyValues(v)) env.onArray?.();
      return mapValue(v, (x) => {
        const n = toNumber(x);
        return isError(n) ? n : n / 100;
      });
    }
    case "bin": {
      const a = evaluate(node.left, env);
      const b = evaluate(node.right, env);
      if (manyValues(a) || manyValues(b)) env.onArray?.();
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
    case "invoke": {
      const target = evaluate(node.fn, env);
      const fn = asLambda(target);
      if (fn) return callLambda(fn, node.args, env);
      if (!isMatrix(target) && isError(target)) return target;
      return err("#VALUE!", "Only a LAMBDA can be given values in brackets, as LAMBDA(x, x*2)(3)");
    }
    case "call": {
      if (node.name === "LET") return evaluateLet(node, env);
      if (node.name === "LAMBDA") return makeLambda(node, env);
      if (LAMBDA_FORMS.has(node.name)) return evaluateLambdaForm(node, env);
      const impl = FUNCTIONS[node.name];
      if (!impl) {
        // A LET name or a workbook name that holds a LAMBDA is called like a
        // function: =LET(f, LAMBDA(x, x*2), f(3)), or =DOUBLE(3) (R328).
        const fn = calleeLambda(node.name, env);
        if (fn && "params" in fn) return callLambda(fn, node.args, env);
        return fn ?? err("#NAME?", `Unknown function ${node.name}`);
      }
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
        const ref = rangeOf(n, env);
        return {
          node: n,
          isRef: n.k === "cell" || n.k === "range" || n.k === "struct" || (n.k === "name" && !!ref),
          ref,
          value() {
            if (!done) {
              cached = evaluate(n, env);
              done = true;
            }
            return cached as Value;
          },
        };
      });
      // One that works over arrays by itself (IF's condition) tells too.
      // FOUND IN R162: the check R161 added missed these, so
      // =SUM(IF(C1:C3,1,0)) went out as a plain formula.
      const own = env.onArray ? OWN_LIFTS.get(node.name) : undefined;
      if (
        own?.some(
          (i) => i < args.length && args[i].node.k !== "empty" && manyValues(args[i].value()),
        )
      )
        env.onArray?.();
      // A function of single values given an array works on each element,
      // as in Excel. FOUND IN R144: ISNUMBER(SEARCH("an",A1:A5)) looked at A1
      // only, so SUMPRODUCT(--ISNUMBER(...)) counted 0 or 1.
      const lift = LIFTS.get(node.name);
      if (lift) {
        const at = lift(args.length).filter((i) => i < args.length);
        const vals = at.map((i) => (args[i].node.k === "empty" ? null : args[i].value()));
        if (vals.some(isMatrix)) {
          if (vals.some(manyValues)) env.onArray?.();
          return zipN(vals, (xs) =>
            scalarOf(
              impl(
                args.map((a, i) => {
                  const j = at.indexOf(i);
                  return j < 0 ? a : { node: a.node, isRef: false, value: () => xs[j] };
                }),
                { env, name: node.name },
              ),
            ),
          );
        }
      }
      return impl(args, { env, name: node.name, evaluate: (n) => evaluate(n, env) });
    }
  }
}

/**
 * Excel's implicit intersection, @ (R162). From a column of cells, the one
 * in the formula's own row; from a row, the one in its own column; from a
 * block, the cell in both. Outside it, #VALUE!. A whole column holds every
 * row, used or not. From an array that is not a range, its first value.
 */
function intersect(arg: Node, env: EvalEnv): Value {
  const ref = rangeOf(arg, env);
  if (!ref) {
    const v = evaluate(arg, env);
    return isMatrix(v) ? (v[0]?.[0] ?? null) : v;
  }
  const oneRow = ref.whole !== "cols" && ref.r0 === ref.r1;
  const oneCol = ref.whole !== "rows" && ref.c0 === ref.c1;
  const inRows = ref.whole === "cols" || (env.row >= ref.r0 && env.row <= ref.r1);
  const inCols = ref.whole === "rows" || (env.col >= ref.c0 && env.col <= ref.c1);
  const outside = err("#VALUE!", "@ takes the value in the formula's own row or column");
  if (oneRow && oneCol) return env.cell(ref.sheet, ref.r0, ref.c0);
  if (oneCol) return inRows ? env.cell(ref.sheet, env.row, ref.c0) : outside;
  if (oneRow) return inCols ? env.cell(ref.sheet, ref.r0, env.col) : outside;
  return inRows && inCols ? env.cell(ref.sheet, env.row, env.col) : outside;
}

// ── LAMBDA (R328) ────────────────────────────────────────────────────────────
//
// FOUND IN THE GAP REVIEW: LAMBDA was #NAME?, so a workbook that defined its
// own functions (a named LAMBDA, MAP, REDUCE, BYROW) showed only the values
// Excel last saved and could not recompute. A LAMBDA evaluates to the #CALC!
// Excel shows for an uncalled function, carrying the function itself; a call,
// LET, a workbook name and the helpers below look inside it.

/** A LAMBDA: its parameters, its calculation, and the names it was written among. */
type LambdaFn = {
  params: { name: string; optional: boolean }[];
  body: Node;
  env: EvalEnv;
};

/**
 * Excel's operand stack for LAMBDA calls: a recursion is #NUM! when it
 * reaches 1,024 / (parameters + 1) calls, so a LAMBDA of one parameter goes
 * 511 deep (SUMTO(510) computes, SUMTO(511) does not, as in Excel).
 */
const LAMBDA_STACK = 1024;

/** The functions that take a LAMBDA, evaluated where they stand. */
const LAMBDA_FORMS = new Set(["MAP", "REDUCE", "SCAN", "BYROW", "BYCOL", "MAKEARRAY", "ISOMITTED"]);

const matrixOf = (v: Value): Matrix => (isMatrix(v) ? v : [[v]]);

function asLambda(v: Value): LambdaFn | null {
  if (isMatrix(v) || !isError(v) || !v.fn) return null;
  return v.fn as LambdaFn;
}

/** LAMBDA(param1, …, calculation): a function, not yet called. */
function makeLambda(node: Extract<Node, { k: "call" }>, env: EvalEnv): Value {
  const a = node.args;
  if (!a.length || a[a.length - 1].k === "empty")
    return err("#VALUE!", "LAMBDA takes its parameters, then a calculation");
  const params: LambdaFn["params"] = [];
  for (const p of a.slice(0, -1)) {
    // [rate] is a parameter a call may leave out; it parses as a column reference.
    const key = paramName(p);
    if (!key)
      return err(
        "#VALUE!",
        "LAMBDA's parameters are names, such as x, or [rate] for one that may be left out",
      );
    if (params.some((q) => q.name === key)) return err("#VALUE!", `LAMBDA names ${key} twice`);
    params.push({ name: key, optional: p.k === "struct" });
  }
  // The names given before it, as they are now: LET's later names (and the
  // LET name it is given to) are not the LAMBDA's, as in Excel.
  const fn: LambdaFn = {
    params,
    body: a[a.length - 1],
    env: { ...env, names: new Map(env.names ?? []) },
  };
  return {
    err: "#CALC!",
    detail:
      "A LAMBDA is a function: give it values, as in LAMBDA(x, x*2)(3), or name it and call the name",
    fn,
  };
}

/** The LAMBDA a called name holds: a LET name or a workbook name. An error when it holds something else. */
function calleeLambda(name: string, env: EvalEnv): LambdaFn | SheetError | null {
  const key = name.toLowerCase();
  const bound = env.names?.get(key);
  if (bound !== undefined)
    return (
      asLambda(bound) ?? err("#VALUE!", `${name} is a value, not a LAMBDA, so it can't be called`)
    );
  const def = env.definedName?.(name);
  if (!def) return null;
  if (env.naming?.has(key)) return err("#CYCLE!", `The name ${name} refers to itself`);
  const v = evaluate(def, { ...env, naming: new Set([...(env.naming ?? []), key]) });
  return asLambda(v) ?? err("#VALUE!", `${name} is a value, not a LAMBDA, so it can't be called`);
}

function callLambda(fn: LambdaFn, argNodes: Node[], env: EvalEnv): Value {
  const values = argNodes.map((n) => (n.k === "empty" ? undefined : evaluate(n, env)));
  return applyLambda(fn, values, (env.depth ?? 0) + 1);
}

/** Call a LAMBDA with values; undefined is a value left out. */
function applyLambda(fn: LambdaFn, values: (Value | undefined)[], depth: number): Value {
  const limit = Math.floor(LAMBDA_STACK / (fn.params.length + 1));
  if (depth >= limit)
    return err(
      "#NUM!",
      `LAMBDA calls went ${limit} deep, past Excel's limit: does the recursion stop?`,
    );
  if (values.length > fn.params.length)
    return err(
      "#VALUE!",
      `This LAMBDA takes ${fn.params.length} values; it was given ${values.length}`,
    );
  const names = new Map(fn.env.names ?? []);
  const omitted = new Set(fn.env.omitted ?? []);
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i];
    const v = values[i];
    if (v === undefined) {
      if (!p.optional) return err("#VALUE!", `This LAMBDA needs a value for ${p.name}`);
      names.set(p.name, null);
      omitted.add(p.name);
    } else {
      names.set(p.name, v);
      omitted.delete(p.name);
    }
  }
  try {
    // `naming` is cleared: a workbook name that calls itself is a recursion,
    // which LAMBDA_STACK stops, not the cycle a name referring to itself is.
    return evaluate(fn.body, { ...fn.env, names, omitted, depth, naming: undefined });
  } catch (e) {
    if (e instanceof RangeError) return err("#NUM!", "LAMBDA calls went too deep");
    throw e;
  }
}

/**
 * A formula's answer as a cell holds it: a LAMBDA left uncalled is the #CALC!
 * Excel shows, without the function, so no other cell can call it.
 */
export function settled(v: Value): Value {
  if (!isMatrix(v)) return isError(v) && v.fn ? { err: v.err, detail: v.detail } : v;
  if (!v.some((line) => line.some((x) => isError(x) && x.fn))) return v;
  return v.map((line) =>
    line.map((x) => (isError(x) && x.fn ? { err: x.err, detail: x.detail } : x)),
  );
}

/** MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY and ISOMITTED. */
function evaluateLambdaForm(node: Extract<Node, { k: "call" }>, env: EvalEnv): Value {
  const a = node.args;
  const depth = (env.depth ?? 0) + 1;
  const name = node.name;
  if (name === "ISOMITTED") {
    if (a.length !== 1) return err("#VALUE!", "ISOMITTED takes one parameter name");
    const p = a[0];
    return p.k === "name" ? (env.omitted?.has(p.name.toLowerCase()) ?? false) : false;
  }
  const last = a[a.length - 1];
  if (a.length < 2 || !last || last.k === "empty")
    return err("#VALUE!", `${name} takes a LAMBDA last, such as LAMBDA(x, x*2)`);
  const target = evaluate(last, env);
  const fn = asLambda(target);
  if (!fn) {
    if (!isMatrix(target) && isError(target)) return target;
    return err("#VALUE!", `${name} takes a LAMBDA last, such as LAMBDA(x, x*2)`);
  }
  /** One value from a call, as MAP, SCAN, BYROW and BYCOL need. */
  const one = (v: Value): Scalar =>
    !isMatrix(v)
      ? v
      : v.length === 1 && v[0].length === 1
        ? v[0][0]
        : err("#CALC!", `Each call in ${name} must give one value, not an array`);
  const valueOf = (n: Node | undefined): Value | undefined =>
    !n || n.k === "empty" ? undefined : evaluate(n, env);
  switch (name) {
    case "MAP": {
      const arrays = a.slice(0, -1).map((n) => matrixOf(evaluate(n, env)));
      const rows = arrays[0].length;
      const cols = arrays[0][0]?.length ?? 0;
      if (arrays.some((m) => m.length !== rows || (m[0]?.length ?? 0) !== cols))
        return err("#VALUE!", "MAP's arrays must be the same size");
      return arrays[0].map((line, r) =>
        line.map((_, c) =>
          one(
            applyLambda(
              fn,
              arrays.map((m) => m[r][c]),
              depth,
            ),
          ),
        ),
      );
    }
    case "REDUCE":
    case "SCAN": {
      if (a.length > 3)
        return err("#VALUE!", `${name} takes an initial value, an array and a LAMBDA`);
      const array = matrixOf(evaluate(a[a.length - 2], env));
      let acc: Value = a.length === 3 ? (valueOf(a[0]) ?? null) : null;
      const steps: Scalar[][] = [];
      for (const line of array) {
        const out: Scalar[] = [];
        for (const x of line) {
          acc = applyLambda(fn, [acc, x], depth);
          if (name === "SCAN") out.push(one(acc));
        }
        steps.push(out);
      }
      return name === "SCAN" ? steps : acc;
    }
    case "BYROW":
    case "BYCOL": {
      if (a.length !== 2) return err("#VALUE!", `${name} takes an array and a LAMBDA`);
      const m = matrixOf(evaluate(a[0], env));
      if (name === "BYROW") return m.map((line) => [one(applyLambda(fn, [[line]], depth))]);
      const cols = m[0]?.length ?? 0;
      return [
        Array.from({ length: cols }, (_, c) =>
          one(applyLambda(fn, [m.map((line) => [line[c]])], depth)),
        ),
      ];
    }
    case "MAKEARRAY": {
      if (a.length !== 3) return err("#VALUE!", "MAKEARRAY takes rows, columns and a LAMBDA");
      const rows = toNumber(scalarOf(evaluate(a[0], env)));
      const cols = toNumber(scalarOf(evaluate(a[1], env)));
      if (isError(rows)) return rows;
      if (isError(cols)) return cols;
      const R = Math.trunc(rows);
      const C = Math.trunc(cols);
      if (R < 1 || C < 1) return err("#VALUE!", "MAKEARRAY needs at least one row and one column");
      if (R * C > 1_000_000) return err("#NUM!", "Too large");
      return Array.from({ length: R }, (_, r) =>
        Array.from({ length: C }, (_, c) => one(applyLambda(fn, [r + 1, c + 1], depth))),
      );
    }
  }
  return err("#NAME?", `Unknown function ${name}`);
}

/**
 * LET(name1, value1, …, calculation): each value computed once, in order, and
 * known by its name to the values after it and to the calculation (R147).
 */
function evaluateLet(node: Extract<Node, { k: "call" }>, env: EvalEnv): Value {
  const a = node.args;
  if (a.length < 3 || a.length % 2 === 0)
    return err("#VALUE!", "LET takes names and their values in pairs, then a calculation");
  const names = new Map(env.names ?? []);
  const scoped: EvalEnv = { ...env, names };
  for (let i = 0; i + 1 < a.length; i += 2) {
    const n = a[i];
    if (n.k !== "name") return err("#NAME?", "LET needs a name, such as total, before each value");
    names.set(n.name.toLowerCase(), evaluate(a[i + 1], scoped));
  }
  return evaluate(a[a.length - 1], scoped);
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
