// The ontology's expression language: small SQL fragments, re-emitted.
//
// An ontology holds SQL in five places: a derived property, a source filter,
// a metric, a rule predicate and an action's submission criteria. None of them
// is passed to the lakehouse as written. Each is tokenised here and then
// SERIALISED AGAIN from its tokens:
//
//   - a keyword or function is emitted only if it is on an allow-list below;
//   - every other word is a NAME, resolved by the caller (a property to its
//     column or derived SQL, a column to `t0."column"`) and emitted quoted;
//   - a string literal is emitted with its quotes doubled;
//   - `;`, comments, `$`, `?`, backslashes and dots outside numbers do not
//     tokenise at all.
//
// So a fragment cannot add a statement, reach another table, call `read_csv`
// or `getenv`, or smuggle a subquery: `(SELECT secret FROM t)` becomes
// `("SELECT" "secret" "FROM" "t")`, which the engine refuses to parse. The
// fragment still runs as the calling user through the governed lakehouse path,
// so this is the second fence, not the only one; it is also what lets the
// editor say "unknown property `amt`" before anything runs.

export type Token =
  | { t: "num"; v: string; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "name"; v: string; quoted: boolean; at: number }
  | { t: "kw"; v: string; at: number }
  | { t: "fn"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "lp"; at: number }
  | { t: "rp"; at: number }
  | { t: "comma"; at: number };

export class ExprError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/**
 * Words that are always keywords. A property cannot be named one of these
 * (validate.ts refuses it), so the two never collide.
 */
export const CORE_KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "null",
  "true",
  "false",
  "in",
  "between",
  "like",
  "ilike",
  "escape",
  "case",
  "when",
  "then",
  "else",
  "end",
  "as",
  "distinct",
  "filter",
  "where",
  "interval",
  "current_date",
  "current_timestamp",
]);

/**
 * Type names: keywords only right after `AS` or `::`, so a property called
 * `date` or `time` is still a property everywhere else.
 */
export const TYPE_WORDS = new Set([
  "varchar",
  "text",
  "integer",
  "int",
  "bigint",
  "smallint",
  "double",
  "float",
  "real",
  "decimal",
  "numeric",
  "boolean",
  "bool",
  "date",
  "timestamp",
  "timestamptz",
  "time",
]);

/** Interval units: keywords only in `INTERVAL <number or string> <unit>`. */
export const UNIT_WORDS = new Set([
  "year",
  "years",
  "quarter",
  "month",
  "months",
  "week",
  "weeks",
  "day",
  "days",
  "hour",
  "hours",
  "minute",
  "minutes",
  "second",
  "seconds",
]);

export const AGGREGATE_FUNCTIONS = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "mode",
  "stddev",
  "stddev_samp",
  "stddev_pop",
  "variance",
  "var_samp",
  "var_pop",
  "count_if",
  "any_value",
  "approx_count_distinct",
  "quantile_cont",
  "quantile_disc",
  "bool_and",
  "bool_or",
  "arg_max",
  "arg_min",
  "string_agg",
  "first",
  "last",
]);

export const SCALAR_FUNCTIONS = new Set([
  "abs",
  "round",
  "ceil",
  "ceiling",
  "floor",
  "sqrt",
  "power",
  "pow",
  "ln",
  "log",
  "log10",
  "exp",
  "sign",
  "greatest",
  "least",
  "coalesce",
  "nullif",
  "ifnull",
  "if",
  "cast",
  "try_cast",
  "lower",
  "upper",
  "trim",
  "ltrim",
  "rtrim",
  "length",
  "concat",
  "concat_ws",
  "substr",
  "substring",
  "replace",
  "left",
  "right",
  "lpad",
  "rpad",
  "starts_with",
  "ends_with",
  "contains",
  "strpos",
  "regexp_matches",
  "regexp_full_match",
  "regexp_replace",
  "regexp_extract",
  "date_trunc",
  "date_part",
  "date_diff",
  "datediff",
  "date_add",
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "dayofweek",
  "hour",
  "minute",
  "second",
  "strftime",
  "strptime",
  "epoch",
  "make_date",
  "today",
  "now",
  "md5",
]);

const OPERATORS = ["::", "<=", ">=", "<>", "!=", "||", "=", "<", ">", "+", "-", "*", "/", "%"];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") throw new ExprError("Comments are not allowed", i);
    if (c === "/" && src[i + 1] === "*") throw new ExprError("Comments are not allowed", i);
    if (c === ";") throw new ExprError("`;` is not allowed: an expression is one value", i);
    if (c === "'") {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= src.length) throw new ExprError("A string is not closed", i);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            v += "'";
            j += 2;
            continue;
          }
          break;
        }
        v += src[j++];
      }
      out.push({ t: "str", v, at: i });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) throw new ExprError("A quoted name is not closed", i);
      const v = src.slice(i + 1, j);
      if (!v || [...v].some((ch) => ch.charCodeAt(0) < 32))
        throw new ExprError("An empty or invalid quoted name", i);
      out.push({ t: "name", v, quoted: true, at: i });
      i = j + 1;
      continue;
    }
    const num = /^(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0], at: i });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (word) {
      const lower = word[0].toLowerCase();
      let k = i + word[0].length;
      while (k < src.length && /\s/.test(src[k])) k++;
      const call = src[k] === "(";
      const prev = out[out.length - 1];
      const prev2 = out[out.length - 2];
      const typePlace =
        (prev?.t === "kw" && prev.v === "as") || (prev?.t === "op" && prev.v === "::");
      const unitPlace =
        (prev?.t === "num" || prev?.t === "str") && prev2?.t === "kw" && prev2.v === "interval";
      if (typePlace && TYPE_WORDS.has(lower)) {
        // DECIMAL(10, 2) and VARCHAR(20) are types, not calls.
        out.push({ t: "kw", v: lower, at: i });
      } else if (CORE_KEYWORDS.has(lower)) {
        // IN (…), NOT (…), AND (…): a keyword before a parenthesis is still a keyword.
        out.push({ t: "kw", v: lower, at: i });
      } else if (call && (AGGREGATE_FUNCTIONS.has(lower) || SCALAR_FUNCTIONS.has(lower))) {
        out.push({ t: "fn", v: lower, at: i });
      } else if (call) {
        throw new ExprError(`The function \`${word[0]}\` is not allowed here`, i);
      } else if (
        CORE_KEYWORDS.has(lower) ||
        (typePlace && TYPE_WORDS.has(lower)) ||
        (unitPlace && UNIT_WORDS.has(lower))
      ) {
        out.push({ t: "kw", v: lower, at: i });
      } else if (typePlace) {
        throw new ExprError(`\`${word[0]}\` is not a type this can cast to`, i);
      } else {
        out.push({ t: "name", v: word[0], quoted: false, at: i });
      }
      i += word[0].length;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lp", at: i });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rp", at: i });
      i++;
      continue;
    }
    if (c === ",") {
      out.push({ t: "comma", at: i });
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op, at: i });
      i += op.length;
      continue;
    }
    throw new ExprError(`\`${c}\` is not allowed in an expression`, i);
  }
  let depth = 0;
  for (const t of out) {
    if (t.t === "lp") depth++;
    if (t.t === "rp" && --depth < 0) throw new ExprError("A `)` has no `(`", t.at);
  }
  if (depth !== 0) throw new ExprError("A `(` is not closed", src.length);
  if (!out.length) throw new ExprError("The expression is empty", 0);
  return out;
}

export type ExprKind = "scalar" | "predicate" | "aggregate";

export type ExprCheck = {
  ok: boolean;
  error?: string;
  at?: number;
  /** Names the expression refers to, as written. */
  names: string[];
  hasAggregate: boolean;
};

/**
 * Check an expression without compiling it. `known` lists the names it may
 * use (property names, or columns when the table's columns are known); pass
 * null to accept any name (columns of a table not yet read).
 */
export function checkExpr(src: string, kind: ExprKind, known: string[] | null): ExprCheck {
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch (e) {
    const err = e as ExprError;
    return { ok: false, error: err.message, at: err.at, names: [], hasAggregate: false };
  }
  const names: string[] = [];
  let hasAggregate = false;
  const knownLower = known ? new Map(known.map((k) => [k.toLowerCase(), k])) : null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === "fn" && AGGREGATE_FUNCTIONS.has(t.v)) hasAggregate = true;
    if (t.t === "name") {
      names.push(t.v);
      if (knownLower && !knownLower.has(t.v.toLowerCase())) {
        const hint = suggest(t.v, known ?? []);
        return {
          ok: false,
          error: `Unknown name \`${t.v}\`${hint ? ` — did you mean \`${hint}\`?` : ""}`,
          at: t.at,
          names,
          hasAggregate,
        };
      }
    }
  }
  if (kind === "aggregate" && !hasAggregate) {
    return {
      ok: false,
      error: "A metric aggregates: use SUM, COUNT, AVG, MIN, MAX or another aggregate",
      at: 0,
      names,
      hasAggregate,
    };
  }
  if (kind !== "aggregate" && hasAggregate) {
    const fn = tokens.find((t) => t.t === "fn" && AGGREGATE_FUNCTIONS.has(t.v));
    return {
      ok: false,
      error: "An aggregate belongs in a metric, not in a value of one object",
      at: fn?.at ?? 0,
      names,
      hasAggregate,
    };
  }
  return { ok: true, names, hasAggregate };
}

/** Serialise the tokens again, with every name replaced by what `resolve` returns. */
export function compileExpr(src: string, resolve: (name: string) => string): string {
  const tokens = tokenize(src);
  const parts: string[] = [];
  for (const t of tokens) {
    switch (t.t) {
      case "num":
        parts.push(t.v);
        break;
      case "str":
        parts.push(sqlString(t.v));
        break;
      case "name":
        parts.push(resolve(t.v));
        break;
      case "kw":
        parts.push(t.v.toUpperCase());
        break;
      case "fn":
        parts.push(t.v.toUpperCase());
        break;
      case "op":
        parts.push(t.v);
        break;
      case "lp":
        parts.push("(");
        break;
      case "rp":
        parts.push(")");
        break;
      case "comma":
        parts.push(",");
        break;
    }
  }
  return joinSql(parts);
}

function joinSql(parts: string[]): string {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const prev = parts[i - 1];
    const tight =
      i === 0 ||
      p === ")" ||
      p === "," ||
      prev === "(" ||
      p === "::" ||
      prev === "::" ||
      (p === "(" && /^[A-Z_]+$/.test(prev ?? "") && !CORE_KEYWORDS.has((prev ?? "").toLowerCase()));
    out += (tight ? "" : " ") + p;
  }
  return out;
}

export function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A SQL literal for a filter value: numbers bare, booleans as keywords, the rest quoted. */
export function sqlLiteral(v: string | number | boolean | null): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ExprError("A number must be finite", 0);
    return String(v);
  }
  return sqlString(v);
}

function suggest(word: string, known: string[]): string | null {
  const w = word.toLowerCase();
  let best: string | null = null;
  let bestD = 3;
  for (const k of known) {
    const d = editDistance(w, k.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
