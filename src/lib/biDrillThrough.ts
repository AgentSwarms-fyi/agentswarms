// Drill-through: turning "which rows are behind this bar?" into a query that
// actually answers it.
//
// WHY THIS EXISTS. The explore dialog used to run `SELECT * FROM <table> LIMIT
// 1000` and then filter the result in the browser. Three things were wrong with
// that, and the third is the dangerous one:
//
//   1. The widget's OWN filters were dropped. A chart scoped to FY2026 explored
//      rows from every year and called them "the rows behind this bar".
//   2. The cap landed BEFORE the narrowing. On any table past 1,000 rows you
//      got an arbitrary slice — no ORDER BY, so whatever the engine felt like —
//      and then filtered EMEA within it.
//   3. The dialog printed the surviving count as a fact. Drill into a region
//      with 50,000 rows, read "37 rows". Not truncated, not flagged: wrong.
//
// The fix is to push every narrowing into the query and cap AFTER it, so 1,000
// means "the first 1,000 of the matching rows" and the total is a real count.
//
// HOW THE BASE QUERY IS DERIVED. A widget's SQL is normally aggregated
// (`SELECT region, SUM(sales) ... GROUP BY region`), and the point of
// drill-through is the rows UNDER that aggregate. So instead of guessing the
// base table and rebuilding a query around it — which loses joins, aliases and
// the widget's filters — we keep the widget's own FROM/JOIN/WHERE verbatim,
// replace the select list with `*`, and drop the aggregation tail. Everything
// that made the widget's numbers what they are is preserved, including a join
// alias that a reconstructed query would have left dangling.
//
// WHAT IT REFUSES. Set operations (UNION and friends) have no single row grain
// to descend into, and a category computed in the select list (`DATE_TRUNC(...)
// AS month`) names a column the base rows do not have. Both are refused rather
// than approximated: a drill-through that silently drops its predicate shows
// the whole table under the label "rows behind this bar", which is the bug this
// module exists to remove.
//
// SECURITY. Predicate columns are validated with `safeIdent` and must appear in
// the base query's own result columns; values are escaped with `quoteStr`.
// Both come from biDirectQuery, which already does this for direct-query
// widgets against the same warehouses.
import { quoteStr, safeIdent } from "@/lib/biDirectQuery";
import type { DrillEntry } from "@/lib/biChartMath";
import type { BiCrossFilter } from "@/lib/biDashboards";

export const DRILL_THROUGH_ROW_CAP = 1000;

/** One equality narrowing — a drill level, or the dashboard cross-filter. */
export type DrillPredicate = {
  column: string;
  value: string;
  /** Where it came from, for the dialog's disclosure line. */
  origin: "drill" | "crossfilter";
};

/**
 * Everything narrowing what the reader is looking at: the drill levels they
 * clicked into, then the dashboard cross-filter.
 *
 * The drill path matters most and is the part that used never to arrive — the
 * dialog could only see the cross-filter, so drilling two levels into a chart
 * and asking for the rows behind it gave you the rows behind the TOP level.
 */
export function explorePredicates(
  drillPath: DrillEntry[],
  context: BiCrossFilter,
): DrillPredicate[] {
  const preds: DrillPredicate[] = (drillPath ?? []).map((d) => ({
    column: d.field,
    value: d.value,
    origin: "drill" as const,
  }));
  // A cross-filter on a column a drill level already pins is the same
  // narrowing twice — harmless in SQL, but when the two values differ the
  // disclosure line reads as a contradiction. The drill is the more specific
  // statement of where the reader is, so it wins.
  if (context && !preds.some((p) => p.column.toLowerCase() === context.column.toLowerCase())) {
    preds.push({ column: context.column, value: context.value, origin: "crossfilter" });
  }
  return preds;
}

export type DrillThroughPlan = {
  /** Rows query, capped. Ask for cap + 1 to detect truncation. */
  rows: string;
  /** COUNT(*) over the same predicates — the honest denominator. */
  count: string;
  /**
   * "raw" — the widget's aggregation was stripped, so these are base rows.
   * "aggregated" — it could not be stripped safely, so these are the widget's
   * own output rows, narrowed. Useful, but NOT the rows under the bar, and the
   * dialog must say so.
   */
  mode: "raw" | "aggregated";
  /** Predicates that made it into the SQL, in order. */
  applied: DrillPredicate[];
};

// ── SQL scanning ────────────────────────────────────────────────────────
//
// Everything below needs "is this keyword at the top level?", which needs a
// scanner that knows what is a keyword and what merely looks like one inside a
// string, a quoted identifier or a comment. `WHERE note = 'group by hand'` is
// not a GROUP BY, and a column named "order" is not an ORDER BY.

type Word = { word: string; start: number; end: number; depth: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Bare words outside literals/comments, each tagged with its paren depth. */
export function scanWords(sql: string): Word[] {
  const out: Word[] = [];
  const n = sql.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Single quotes double to escape ('it''s'); so do double quotes.
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && sql[i] !== "`") i++;
      i++;
      continue;
    }
    // [bracketed] identifiers (AlaSQL / T-SQL). Treated as opaque either way:
    // if it is array indexing instead, skipping it still finds no keywords.
    if (c === "[") {
      i++;
      while (i < n && sql[i] !== "]") i++;
      i++;
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_PART.test(sql[i])) i++;
      out.push({ word: sql.slice(start, i).toUpperCase(), start, end: i, depth });
      continue;
    }
    i++;
  }
  return out;
}

/** Clauses that end the FROM/WHERE body we want to keep. */
const TAIL_KEYWORDS = new Set([
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "QUALIFY",
  "WINDOW",
  "FETCH",
]);

/** Set operators: more than one row grain, so there is nothing to drill into. */
const SET_OPS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);

/**
 * Strip a query down to `SELECT * <its own FROM/JOIN/WHERE>`, keeping any
 * leading CTEs. Returns null when that cannot be done safely.
 *
 * The select list is discarded wholesale, which is the point: it is where the
 * SUM/COUNT/window functions live. What remains is the row source the widget
 * was aggregating, filtered exactly as the widget filtered it.
 */
export function unaggregateSql(sql: string): string | null {
  const src = (sql ?? "").trim().replace(/;+\s*$/, "");
  if (!src) return null;
  const words = scanWords(src);

  // The main SELECT is the first at depth 0: CTE bodies and subqueries are
  // parenthesised, so theirs sit deeper.
  const select = words.find((w) => w.depth === 0 && w.word === "SELECT");
  if (!select) return null;

  const after = words.filter((w) => w.start >= select.end);
  if (after.some((w) => w.depth === 0 && SET_OPS.has(w.word))) return null;

  const from = after.find((w) => w.depth === 0 && w.word === "FROM");
  if (!from) return null;

  const tail = after.find(
    (w) => w.depth === 0 && w.start > from.start && TAIL_KEYWORDS.has(w.word),
  );
  const body = src.slice(from.start, tail ? tail.start : src.length).trim();
  if (!body) return null;

  // Anything before the main SELECT is a WITH block the FROM may reference.
  const prefix = src.slice(0, select.start).trim();
  return `${prefix ? `${prefix} ` : ""}SELECT * ${body}`;
}

/**
 * Columns whose values are numbers in the widget's own snapshot.
 *
 * This decides whether a predicate is written `year = 2026` or `year = '2026'`.
 * Drill values reach us as display strings because that is what a chart axis
 * holds, and quoting a number is not universally harmless: Postgres and
 * Snowflake coerce it, BigQuery rejects it outright. The snapshot is the same
 * data the user clicked, so its types are the right authority.
 */
export function numericColumnsFrom(rows: Record<string, unknown>[]): string[] {
  const out = new Set<string>();
  const rejected = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (v === null || v === undefined || v === "") continue;
      if (typeof v === "number" && Number.isFinite(v)) out.add(k);
      else rejected.add(k);
    }
  }
  // A column that is a number in one row and text in another is not numeric;
  // quoting is the safe reading of a mixed column.
  return [...out].filter((c) => !rejected.has(c));
}

/** `col = literal`, or null when the column name is not a safe identifier. */
export function renderPredicate(p: DrillPredicate, numeric: boolean): string | null {
  const id = safeIdent(p.column);
  if (!id) return null;
  if (numeric && p.value.trim() !== "" && Number.isFinite(Number(p.value))) {
    return `${id} = ${Number(p.value)}`;
  }
  return `${id} = ${quoteStr(p.value)}`;
}

/**
 * Predicates naming a column the base rows do not expose.
 *
 * Non-empty means refuse: the widget's category is computed in its select list
 * (`DATE_TRUNC('month', d) AS month`), so there is no `month` to filter raw
 * rows by. Dropping the predicate would show every row under a label promising
 * one bar's worth.
 */
export function unresolvablePredicates(
  predicates: DrillPredicate[],
  baseColumns: string[],
): DrillPredicate[] {
  const have = new Set(baseColumns.map((c) => String(c).toLowerCase()));
  return predicates.filter((p) => !have.has(p.column.toLowerCase()));
}

/** Wrap a base query with the drill predicates, capped AFTER filtering. */
export function buildDrillThroughSql(args: {
  /** The widget's SQL. Unaggregated when possible, used as-is when not. */
  widgetSql: string;
  predicates: DrillPredicate[];
  numericColumns?: string[];
  cap?: number;
}): DrillThroughPlan | null {
  const raw = unaggregateSql(args.widgetSql);
  const base = (raw ?? args.widgetSql ?? "").trim().replace(/;+\s*$/, "");
  if (!base) return null;

  const numeric = new Set((args.numericColumns ?? []).map((c) => c.toLowerCase()));
  const applied: DrillPredicate[] = [];
  const preds: string[] = [];
  for (const p of args.predicates ?? []) {
    const sql = renderPredicate(p, numeric.has(p.column.toLowerCase()));
    if (!sql) continue;
    preds.push(sql);
    applied.push(p);
  }

  const where = preds.length ? ` WHERE ${preds.join(" AND ")}` : "";
  const cap = Math.max(1, Math.trunc(args.cap ?? DRILL_THROUGH_ROW_CAP));
  // NEWLINE BEFORE THE CLOSING PAREN, and it is load-bearing. A base query
  // ending in a `--` comment — which survives stripping, because a comment is
  // not a clause — would otherwise comment out the paren AND every predicate
  // after it, turning the wrapper into a syntax error or, worse, an unfiltered
  // query. Found by the test that checks comments are not read as clauses.
  const wrapped = `(${base}\n) AS _dt`;
  return {
    rows: `SELECT * FROM ${wrapped}${where} LIMIT ${cap}`,
    count: `SELECT COUNT(*) AS _n FROM ${wrapped}${where}`,
    mode: raw ? "raw" : "aggregated",
    applied,
  };
}

/** The single number out of a COUNT(*) result, or null if it is not there. */
export function readCount(rows: Record<string, unknown>[]): number | null {
  const row = rows?.[0];
  if (!row) return null;
  for (const v of Object.values(row)) {
    // Warehouses return COUNT as a string often enough that a number-only
    // reading would silently give up and show "more than 1,000" forever.
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}
