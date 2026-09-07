// pandas query/eval → Spark SQL, at compile time.
//
// Filter conditions and derived columns are typed in pandas' query/eval
// dialect: that is what the pandas engine evaluates them with and what the
// canvas shows as examples. On the Spark engine they are Spark SQL. The two
// agree on the everyday subset — arithmetic, comparisons, and/or/not, string
// literals, backtick-quoted names — and this module rewrites the rest that has
// a Spark equivalent (`&`/`|`/`~`, `in [...]`, `.isnull()`, the common `.str`
// and `.dt` accessors) and refuses what does not, at save time, naming the
// construct. A refusal here beats a parse error on a cluster after the data
// was read.

type Tok =
  | { t: "str"; v: string }
  | { t: "num"; v: string }
  | { t: "id"; v: string }
  | { t: "bt"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "lb" }
  | { t: "rb" }
  | { t: "comma" }
  | { t: "dot" };

const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);

function tokenize(src: string, what: string): Tok[] {
  const out: Tok[] = [];
  const bad = (m: string) => new Error(`${what}: ${m}`);
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) {
          v += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        v += src[j];
        j++;
      }
      if (j >= src.length) throw bad("unterminated string literal");
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) throw bad("unterminated backtick-quoted name");
      out.push({ t: "bt", v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const rest = src.slice(i);
    const num = /^(\d[\d_]*(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(rest);
    if (num) {
      out.push({ t: "num", v: num[0].replace(/_/g, "") });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    if (ch === "@") {
      throw bad(
        "`@variable` references are not available here — write the value into the expression",
      );
    }
    const two = rest.slice(0, 2);
    if (two === "**") throw bad("`**` is not available on the Spark engine — use power(a, b)");
    if (["==", "!=", "<=", ">=", "//"].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>&|~".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "(") out.push({ t: "lp" });
    else if (ch === ")") out.push({ t: "rp" });
    else if (ch === "[") out.push({ t: "lb" });
    else if (ch === "]") out.push({ t: "rb" });
    else if (ch === ",") out.push({ t: "comma" });
    else if (ch === ".") out.push({ t: "dot" });
    else if (ch === "=") throw bad("`=` assigns in pandas — use `==` to compare");
    else throw bad(`unexpected character ${JSON.stringify(ch)}`);
    i++;
  }
  return out;
}

/** A Spark SQL string literal from what was typed (python escapes kept). */
function sqlStr(v: string): string {
  return "'" + v.replace(/(^|[^\\])'/g, "$1\\'") + "'";
}

function joinSql(pieces: string[]): string {
  let s = "";
  for (const p of pieces) {
    const noSpace = p === ")" || p === "," || s.endsWith("(") || s === "";
    s += (noSpace ? "" : " ") + p;
  }
  return s;
}

/** Split a token list on top-level commas. */
function splitArgs(toks: Tok[]): Tok[][] {
  const parts: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const tk of toks) {
    if (tk.t === "lp" || tk.t === "lb") depth++;
    if (tk.t === "rp" || tk.t === "rb") depth--;
    if (tk.t === "comma" && depth === 0) {
      parts.push(cur);
      cur = [];
    } else cur.push(tk);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/** Tokens from `from` up to (not including) the matching closer; returns [inner, indexAfterCloser]. */
function group(toks: Tok[], from: number, open: "lp" | "lb", what: string): [Tok[], number] {
  const close = open === "lp" ? "rp" : "rb";
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === open) depth++;
    else if (tk.t === close) {
      depth--;
      if (depth === 0) return [toks.slice(from + 1, i), i + 1];
    }
  }
  throw new Error(`${what}: unbalanced ${open === "lp" ? "parentheses" : "brackets"}`);
}

const CAST_TYPES: Record<string, string> = {
  int: "BIGINT",
  int64: "BIGINT",
  int32: "INT",
  float: "DOUBLE",
  float64: "DOUBLE",
  float32: "FLOAT",
  str: "STRING",
  string: "STRING",
  bool: "BOOLEAN",
  boolean: "BOOLEAN",
};

function translate(toks: Tok[], what: string): string {
  const out: string[] = [];
  const bad = (m: string) => new Error(`${what}: ${m}`);
  // Where the most recent complete operand starts in `out`, so a method
  // chain after it can wrap exactly that operand.
  let operandStart: number | null = null;
  const openStack: number[] = [];
  // Comparisons seen since the last and/or/not at each nesting level: a
  // second one is a chained comparison, which SQL does not have.
  const cmp: number[] = [0];
  const arg = (ts: Tok[]) => translate(ts, what);
  // Two values with nothing between them is not an expression — and it is
  // also what "a second statement" looks like once newlines are whitespace.
  let lastWasOperand = false;
  const emit = (piece: string, operand: boolean) => {
    if (operand && lastWasOperand) {
      throw bad(`\`${piece}\` follows a value with no operator between them`);
    }
    lastWasOperand = operand;
    if (operand) operandStart = out.length;
    else operandStart = null;
    out.push(piece);
  };
  /** `IN (…)` / `IN [...]`: the list, translated item by item. */
  const inList = (open: "lp" | "lb", at: number): number => {
    const [inner, after] = group(toks, at, open, what);
    emit(`(${splitArgs(inner).map(arg).join(", ")})`, false);
    return after;
  };
  const method = (name: string, args: Tok[][], base: string): string => {
    const a = args.map(arg);
    switch (name) {
      case "isnull":
      case "isna":
        return `(${base} IS NULL)`;
      case "notnull":
      case "notna":
        return `(${base} IS NOT NULL)`;
      case "abs":
        return `abs(${base})`;
      case "round":
        return `round(${base}, ${a[0] ?? "0"})`;
      case "fillna":
        if (a.length !== 1) throw bad(".fillna() takes one value");
        return `coalesce(${base}, ${a[0]})`;
      case "astype": {
        const tk = args[0]?.[0];
        const key = tk && (tk.t === "str" || tk.t === "id") ? tk.v : "";
        const to = CAST_TYPES[key];
        if (!to)
          throw bad(
            `.astype(${key || "?"}) is not available on the Spark engine — int, float, str or bool`,
          );
        return `CAST(${base} AS ${to})`;
      }
      default:
        throw bad(`.${name}() is not available on the Spark engine here — use a SQL step for it`);
    }
  };
  const strMethod = (name: string, args: Tok[][], base: string): string => {
    const a = args.map(arg);
    const one = (fn: string) => {
      if (a.length) throw bad(`.str.${name}() takes no argument`);
      return `${fn}(${base})`;
    };
    switch (name) {
      case "len":
        return one("length");
      case "lower":
        return one("lower");
      case "upper":
        return one("upper");
      case "strip":
        return one("trim");
      case "title":
        return one("initcap");
      case "contains":
        if (a.length < 1) throw bad(".str.contains() needs a pattern");
        return `(${base} RLIKE ${a[0]})`;
      case "startswith":
        if (a.length !== 1) throw bad(".str.startswith() needs one prefix");
        return `startswith(${base}, ${a[0]})`;
      case "endswith":
        if (a.length !== 1) throw bad(".str.endswith() needs one suffix");
        return `endswith(${base}, ${a[0]})`;
      case "replace":
        if (a.length < 2) throw bad(".str.replace() needs a pattern and a replacement");
        return `regexp_replace(${base}, ${a[0]}, ${a[1]})`;
      default:
        throw bad(
          `.str.${name}() is not available on the Spark engine here — use a SQL step for it`,
        );
    }
  };
  const DT: Record<string, string> = {
    year: "year",
    month: "month",
    day: "day",
    hour: "hour",
    minute: "minute",
    second: "second",
    date: "to_date",
    dayofweek: "dayofweek",
    weekday: "weekday",
    quarter: "quarter",
  };

  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    switch (tk.t) {
      case "str":
        emit(sqlStr(tk.v), true);
        i++;
        break;
      case "num":
        emit(tk.v, true);
        i++;
        break;
      case "bt":
        emit(tk.v, true);
        i++;
        break;
      case "id": {
        const v = tk.v;
        const next = toks[i + 1];
        if (v === "and" || v === "or") {
          emit(v.toUpperCase(), false);
          cmp[cmp.length - 1] = 0;
          i++;
        } else if (v === "not") {
          if (next?.t === "id" && next.v === "in") {
            emit("NOT IN", false);
            i += 2;
          } else {
            emit("NOT", false);
            cmp[cmp.length - 1] = 0;
            i++;
          }
        } else if (v === "in") {
          emit("IN", false);
          i++;
        } else if (v === "True" || v === "False") {
          emit(v.toLowerCase(), true);
          i++;
        } else if (v === "None") {
          emit("null", true);
          i++;
        } else if (v === "is") {
          throw bad("`is None` is not available here — use .isnull() or .notnull()");
        } else if (v === "if" || v === "else" || v === "lambda") {
          throw bad(
            `\`${v}\` is not available on the Spark engine — use a SQL step with CASE WHEN`,
          );
        } else if (next?.t === "lp") {
          // A function call: abs(x), round(x, 2), sqrt(x) — Spark has the
          // same names for pandas' arithmetic helpers.
          const [inner, after] = group(toks, i + 1, "lp", what);
          emit(`${v}(${splitArgs(inner).map(arg).join(", ")})`, true);
          i = after;
        } else {
          emit(v, true);
          i++;
        }
        break;
      }
      case "op": {
        const v = tk.v;
        if (COMPARE.has(v)) {
          if (cmp[cmp.length - 1] >= 1) {
            throw bad("chained comparisons are not available — write `a < x and x < b`");
          }
          cmp[cmp.length - 1]++;
          emit(v, false);
        } else if (v === "&") emit("AND", false);
        else if (v === "|") emit("OR", false);
        else if (v === "~") emit("NOT", false);
        else if (v === "//") emit("div", false);
        else emit(v, false);
        if (v === "&" || v === "|" || v === "~") cmp[cmp.length - 1] = 0;
        i++;
        break;
      }
      case "lp": {
        const prev = out[out.length - 1];
        if (prev === "IN" || prev === "NOT IN") {
          i = inList("lp", i);
          break;
        }
        if (lastWasOperand) throw bad("`(` follows a value with no operator between them");
        openStack.push(out.length);
        cmp.push(0);
        emit("(", false);
        i++;
        break;
      }
      case "rp": {
        const start = openStack.pop();
        if (start === undefined) throw bad("unbalanced parentheses");
        cmp.pop();
        out.push(")");
        operandStart = start;
        lastWasOperand = true;
        i++;
        break;
      }
      case "lb": {
        // Only a membership list: `x in [1, 2]` → `x IN (1, 2)`.
        const prev = out[out.length - 1];
        if (prev !== "IN" && prev !== "NOT IN") {
          throw bad("indexing with [...] is not available here — a list only follows `in`");
        }
        i = inList("lb", i);
        break;
      }
      case "rb":
        throw bad("unbalanced brackets");
      case "comma":
        throw bad("a stray comma — an expression is one value");
      case "dot": {
        if (operandStart === null) throw bad("a `.` needs a column before it");
        const nameTok = toks[i + 1];
        if (!nameTok || nameTok.t !== "id") throw bad("a `.` needs a method after it");
        const base = joinSql(out.slice(operandStart));
        let piece: string;
        let after: number;
        if (nameTok.v === "str" || nameTok.v === "dt") {
          const dot = toks[i + 2];
          const m = toks[i + 3];
          if (!dot || dot.t !== "dot" || !m || m.t !== "id") {
            throw bad(
              `.${nameTok.v} needs an accessor after it, like .${nameTok.v === "str" ? "str.lower()" : "dt.year"}`,
            );
          }
          if (nameTok.v === "dt") {
            const fn = DT[m.v];
            if (!fn)
              throw bad(
                `.dt.${m.v} is not available on the Spark engine here — use a SQL step for it`,
              );
            piece = `${fn}(${base})`;
            after = i + 4;
          } else {
            if (toks[i + 4]?.t !== "lp") throw bad(`.str.${m.v} needs parentheses`);
            const [inner, next] = group(toks, i + 4, "lp", what);
            piece = strMethod(m.v, splitArgs(inner), base);
            after = next;
          }
        } else {
          if (toks[i + 2]?.t !== "lp") {
            throw bad(
              `.${nameTok.v} is not available on the Spark engine here — use a SQL step for it`,
            );
          }
          const [inner, next] = group(toks, i + 2, "lp", what);
          piece = method(nameTok.v, splitArgs(inner), base);
          after = next;
        }
        out.splice(operandStart);
        out.push(piece);
        i = after;
        break;
      }
    }
  }
  if (openStack.length) throw bad("unbalanced parentheses");
  if (!out.length) throw bad("the expression is empty");
  return joinSql(out);
}

/**
 * The Spark SQL for a pandas query/eval expression, or an Error that names the
 * construct Spark does not have. `what` labels the message ("Filter x").
 */
export function toSparkSql(expr: string, what: string): string {
  if (!expr.trim()) throw new Error(`${what}: the expression is empty`);
  return translate(tokenize(expr, what), what);
}
