// A widget's title is a claim, and claims get checked.
//
// The AI names a visual before it knows what the query will return, and the
// two then drift apart in both directions. Three instances, all from one
// generator, all found by looking at the dashboard rather than the code:
//
//   "Top 5 Products by Sales"    → SQL carried no LIMIT   → 14 bars
//   "Top 10 Customers by Sales"  → bar race caps at 12     → 12 rows
//   "Revenue by Region"          → SQL ended LIMIT 1       → one bar
//
// The last one is the reason this exists as a separate check rather than a
// note on the insight card. The card's every figure verified against the
// widget's data and every sentence was false — "AMER accounts for 100% of the
// total revenue", "there are no other regions contributing" — because the
// query had already thrown the other regions away. A checker reading the prose
// cannot catch that; the prose is not wrong about its data. Only something
// that reads the TITLE against the QUERY can.
//
// Deterministic, and no model call: the repairs below are re-runs of SQL the
// generator already wrote, not new generations. Same split as everywhere else
// in this half of the product — the model proposes, the check decides.
import { queryRowLimit } from "@/lib/biInsightFacts";

/** A countable promise in a title: "Top 5 Products", "bottom 3 regions". */
export type TitleClaim = { kind: "top" | "bottom"; n: number };

/**
 * The N a title promises, or null when it promises no particular number.
 *
 * "Top Products by Revenue" makes no countable claim and is left alone — only
 * an explicit number is a promise a reader can hold the chart to.
 */
export function parseTitleClaim(text: string | undefined): TitleClaim | null {
  if (!text) return null;
  const m = /\b(top|highest|bottom|lowest)\s+(\d{1,4})\b/i.exec(text);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n < 1) return null;
  const word = m[1].toLowerCase();
  return { kind: word === "bottom" || word === "lowest" ? "bottom" : "top", n };
}

/** Charts whose whole job is comparing categories against one another. */
const CATEGORY_CHARTS = new Set([
  "bar",
  "hbar",
  "scolumn",
  "shbar",
  "pie",
  "nightingale",
  "treemap",
  "funnel",
  "radar",
  "barrace",
  "wordcloud",
]);

const hasOrderBy = (sql: string) => /\border\s+by\b/i.test(sql);
const hasGroupBy = (sql: string) => /\bgroup\s+by\b/i.test(sql);

/** Drop a trailing `LIMIT n`, leaving the rest of the query untouched. */
export function stripTrailingLimit(sql: string): string {
  return sql.replace(/\s+limit\s+\d+\s*;?\s*$/i, "");
}

/** Append `LIMIT n`, replacing a trailing one if the query already had it. */
export function withLimit(sql: string, n: number): string {
  return `${stripTrailingLimit(sql.trim()).replace(/;\s*$/, "")} LIMIT ${n}`;
}

export type TitleVerdict =
  /** Title and query already agree. */
  | { verdict: "ok" }
  /**
   * The title promised N and the query returned more. Keep the query's own
   * ordering and take the N that was asked for — the rows are already sorted,
   * so this is exactly what `LIMIT n` would have produced.
   */
  | { verdict: "truncate"; n: number; sql: string; note: string }
  /**
   * A category chart whose query kept one row. A one-bar bar chart is not a
   * chart, and the title never asked for one.
   */
  | { verdict: "widen"; sql: string }
  /**
   * The title promised more than the query could give. Nothing can be
   * repaired — rows cannot be invented — so the reader is told.
   */
  | { verdict: "short"; promised: number; got: number; note: string };

/**
 * Compare what a widget says it shows with what its query actually did.
 *
 * `rowCount` is the count the query returned, not the count the chart drew:
 * the question is whether the QUERY honoured the title, and a renderer that
 * caps its own display (the bar race, at twelve) is a separate bug fixed in a
 * separate place.
 */
export function reconcileTitle(args: {
  title?: string;
  question?: string;
  sql?: string;
  rowCount: number;
  chartType?: string;
}): TitleVerdict {
  const sql = args.sql?.trim();
  if (!sql) return { verdict: "ok" };
  const claim = parseTitleClaim(args.title) ?? parseTitleClaim(args.question);
  const limit = queryRowLimit(sql);
  const isCategory = args.chartType ? CATEGORY_CHARTS.has(args.chartType) : false;

  if (claim) {
    // Taking the first N of an unordered result would be an arbitrary N, which
    // is a different lie from the one being fixed.
    if (args.rowCount > claim.n && hasOrderBy(sql)) {
      return {
        verdict: "truncate",
        n: claim.n,
        sql: withLimit(sql, claim.n),
        note: `Showing the ${claim.kind} ${claim.n} of ${args.rowCount}.`,
      };
    }
    if (args.rowCount < claim.n) {
      return {
        verdict: "short",
        promised: claim.n,
        got: args.rowCount,
        note: `The data has ${args.rowCount} row${args.rowCount === 1 ? "" : "s"}, not ${claim.n}.`,
      };
    }
    return { verdict: "ok" };
  }

  // No number promised. The remaining failure is the opposite one: a query
  // that narrowed to a single row under a title describing a breakdown.
  if (isCategory && limit === 1 && hasGroupBy(sql)) {
    return { verdict: "widen", sql: stripTrailingLimit(sql) };
  }
  return { verdict: "ok" };
}

/** The outcome of reconciling one generated widget. */
export type ReconciledWidget = {
  rows: Record<string, unknown>[];
  sql: string | undefined;
  /** Shown on the widget when the reader would otherwise be misled. */
  note?: string;
  changed: "none" | "truncated" | "widened" | "short";
};

/**
 * Apply the verdict, re-running SQL only where a re-run is the repair.
 *
 * `execute` is the caller's own runner, so a warehouse widget re-queries the
 * warehouse and a local one the local engine. When it fails, the original
 * result is kept and the note says what was not repaired — a widget that
 * renders is better than a dashboard with a hole in it, provided it does not
 * claim more than it has.
 */
export async function reconcileWidgetResult(args: {
  title?: string;
  question?: string;
  sql?: string;
  chartType?: string;
  rows: Record<string, unknown>[];
  execute?: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<ReconciledWidget> {
  const base: ReconciledWidget = { rows: args.rows, sql: args.sql, changed: "none" };
  const v = reconcileTitle({
    title: args.title,
    question: args.question,
    sql: args.sql,
    chartType: args.chartType,
    rowCount: args.rows.length,
  });

  if (v.verdict === "ok") return base;
  if (v.verdict === "short") return { ...base, note: v.note, changed: "short" };

  if (v.verdict === "truncate") {
    // No re-query: the rows are already in the query's own order, so slicing
    // them gives precisely what `LIMIT n` would have returned. The SQL is
    // rewritten anyway so a later refresh agrees with what is on screen.
    return {
      rows: args.rows.slice(0, v.n),
      sql: v.sql,
      note: v.note,
      changed: "truncated",
    };
  }

  // widen: the only case that needs the database again.
  if (!args.execute) return base;
  try {
    const res = await args.execute(v.sql);
    if (!res.rows.length) return base;
    return { rows: res.rows, sql: v.sql, changed: "widened" };
  } catch {
    return {
      ...base,
      note: "This query returned a single row; the other categories were not fetched.",
      changed: "none",
    };
  }
}
