// The Excel formula parser: tokens → syntax tree.
//
// Precedence follows Excel, not arithmetic: unary minus binds tighter than
// "^" (=-2^2 is 4), "^" is left-associative (=2^3^2 is 64), "%" is postfix,
// "&" sits between arithmetic and comparison.

import { FormulaSyntaxError, lex, type ErrorCode, type RefPart, type Token } from "./lexer";

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: ErrorCode }
  | { k: "empty" }
  | { k: "cell"; sheet?: string; ref: RefPart }
  | {
      k: "range";
      sheet?: string;
      start: RefPart;
      end: RefPart;
      wholeCols?: boolean;
      wholeRows?: boolean;
    }
  | { k: "struct"; table?: string; column: string; endColumn?: string; thisRow: boolean }
  | { k: "name"; name: string }
  | { k: "array"; rows: Node[][] }
  | { k: "call"; name: string; args: Node[] }
  | { k: "unary"; op: "-" | "+"; arg: Node }
  | { k: "percent"; arg: Node }
  | { k: "bin"; op: BinOp; left: Node; right: Node };

export type BinOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

const BINARY: Record<string, number> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
};
const UNARY_BP = 6;

export { FormulaSyntaxError };

/** Parse a formula body (without the leading "="). */
export function parseFormula(body: string): Node {
  const tokens = lex(body);
  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  const next = (): Token => {
    const t = tokens[i++];
    if (!t) throw new FormulaSyntaxError("The formula ends too soon", body.length);
    return t;
  };

  const expr = (minBp: number): Node => {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op") break;
      if (t.v === "%") {
        i++;
        left = { k: "percent", arg: left };
        continue;
      }
      const bp = BINARY[t.v];
      if (bp === undefined || bp < minBp) break;
      i++;
      // Left-associative everywhere (Excel's "^" included).
      const right = expr(bp + 1);
      left = { k: "bin", op: t.v as BinOp, left, right };
    }
    return left;
  };

  const primary = (): Node => {
    const t = next();
    switch (t.t) {
      case "num":
        return { k: "num", v: t.v };
      case "str":
        return { k: "str", v: t.v };
      case "bool":
        return { k: "bool", v: t.v };
      case "err":
        return { k: "err", v: t.v };
      case "cell":
        return { k: "cell", sheet: t.sheet, ref: t.ref };
      case "range":
        return {
          k: "range",
          sheet: t.sheet,
          start: t.start,
          end: t.end,
          wholeCols: t.wholeCols,
          wholeRows: t.wholeRows,
        };
      case "struct":
        return {
          k: "struct",
          table: t.table,
          column: t.column,
          endColumn: t.endColumn,
          thisRow: t.thisRow,
        };
      case "name":
        return { k: "name", name: t.name };
      case "op": {
        if (t.v === "u-" || t.v === "u+") {
          const arg = expr(UNARY_BP);
          return { k: "unary", op: t.v === "u-" ? "-" : "+", arg };
        }
        throw new FormulaSyntaxError(`Unexpected "${t.v}"`, t.s);
      }
      case "(": {
        const inner = expr(0);
        const close = next();
        if (close.t !== ")") throw new FormulaSyntaxError("Expected )", close.s);
        return inner;
      }
      case "func": {
        const open = next();
        if (open.t !== "(") throw new FormulaSyntaxError("Expected (", open.s);
        const args: Node[] = [];
        if (peek()?.t === ")") {
          i++;
          return { k: "call", name: t.name, args };
        }
        for (;;) {
          const p = peek();
          if (p && (p.t === "," || p.t === ")")) args.push({ k: "empty" });
          else args.push(expr(0));
          const sep = next();
          if (sep.t === ")") break;
          if (sep.t !== ",") throw new FormulaSyntaxError("Expected , or )", sep.s);
        }
        return { k: "call", name: t.name, args };
      }
      case "{": {
        const rows: Node[][] = [[]];
        for (;;) {
          const v = primaryConst();
          rows[rows.length - 1].push(v);
          const sep = next();
          if (sep.t === "}") break;
          if (sep.t === ",") continue;
          if (sep.t === ";") {
            rows.push([]);
            continue;
          }
          throw new FormulaSyntaxError("Expected , ; or } in an array", sep.s);
        }
        const width = rows[0].length;
        if (rows.some((r) => r.length !== width)) {
          throw new FormulaSyntaxError("Array rows must be the same length", t.s);
        }
        return { k: "array", rows };
      }
      default:
        throw new FormulaSyntaxError(`Unexpected "${body.slice(t.s, t.e)}"`, t.s);
    }
  };

  // Array constants hold literals only (Excel's rule), with an optional sign.
  const primaryConst = (): Node => {
    const t = next();
    if (t.t === "op" && (t.v === "u-" || t.v === "u+")) {
      const n = next();
      if (n.t !== "num") throw new FormulaSyntaxError("Expected a number", n.s);
      return { k: "num", v: t.v === "u-" ? -n.v : n.v };
    }
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "bool") return { k: "bool", v: t.v };
    if (t.t === "err") return { k: "err", v: t.v };
    throw new FormulaSyntaxError("Arrays hold numbers, text, TRUE/FALSE or errors only", t.s);
  };

  const node = expr(0);
  if (i < tokens.length) {
    const t = tokens[i];
    throw new FormulaSyntaxError(`Unexpected "${body.slice(t.s, t.e)}"`, t.s);
  }
  return node;
}

/** True when the input is a formula (starts with "=" and has more). */
export function isFormula(input: string): boolean {
  return input.length > 1 && input.startsWith("=");
}
