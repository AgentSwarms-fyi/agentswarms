// What the analyst knows about time: today's date, and the dates its data
// actually covers.
//
// Neither was in any prompt. R512's UI test asked for "the latest year" over
// data running 2022-01-04 → 2025-12-31; the planner, knowing neither, filtered
// to 2023 and reported 470,532.51 as the year's total (2025's is 733,948.02).
// In the same session the self-check called 2024 and 2025 "future years which
// may not have actual data" — from its own sense of the date. Both are fixed by
// telling the models what the data and the clock say instead of letting them
// guess.
//
// The ranges are read with one query per dataset, local engine only: a date
// column is stored as text (see describeSchema), so each is parsed the ways
// uploads accept — ISO, month-first and day-first slashes — and the way that
// parses the most values is the column's format, month-first winning a tie as
// detectDateFormat decides it.
import type { DatasetMeta } from "@/lib/sqlEngine";

export type DateSpan = { table: string; column: string; earliest: string; latest: string };

/** Today in the running environment's own calendar, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

const PARSES = [
  (c: string) => `TRY_CAST(${c} AS TIMESTAMP)`,
  (c: string) => `TRY_STRPTIME(CAST(${c} AS VARCHAR), '%m/%d/%Y')`,
  (c: string) => `TRY_STRPTIME(CAST(${c} AS VARCHAR), '%d/%m/%Y')`,
];

/** At most this many date columns per dataset are read. */
const MAX_DATE_COLUMNS = 6;
/** At most this many datasets are read before planning. */
export const MAX_DATED_DATASETS = 8;

/** The date columns of a dataset worth a range, in schema order. */
export function datedColumns(d: DatasetMeta): string[] {
  return d.columns
    .filter((c) => c.type === "date")
    .map((c) => c.name)
    .slice(0, MAX_DATE_COLUMNS);
}

/**
 * DuckDB SQL reading every date column's count, earliest and latest value
 * under each parse, in one pass. Null when the dataset has no date column.
 */
export function dateRangeSql(d: DatasetMeta): string | null {
  const cols = datedColumns(d);
  if (!cols.length) return null;
  const parts: string[] = [];
  cols.forEach((col, ci) => {
    PARSES.forEach((parse, pi) => {
      const e = parse(ident(col));
      parts.push(
        `CAST(COUNT(${e}) AS DOUBLE) AS "c${ci}_${pi}_n"`,
        `STRFTIME(MIN(${e}), '%Y-%m-%d') AS "c${ci}_${pi}_lo"`,
        `STRFTIME(MAX(${e}), '%Y-%m-%d') AS "c${ci}_${pi}_hi"`,
      );
    });
  });
  return `SELECT ${parts.join(", ")} FROM ${ident(d.name)}`;
}

/** The spans one dataset's range row describes; columns no parse could read are left out. */
export function spansFromRow(d: DatasetMeta, row: Record<string, unknown> | undefined): DateSpan[] {
  if (!row) return [];
  const out: DateSpan[] = [];
  datedColumns(d).forEach((col, ci) => {
    let best = -1;
    let bestN = 0;
    PARSES.forEach((_, pi) => {
      const n = Number(row[`c${ci}_${pi}_n`] ?? 0);
      if (n > bestN) {
        best = pi;
        bestN = n;
      }
    });
    if (best < 0) return;
    const lo = row[`c${ci}_${best}_lo`];
    const hi = row[`c${ci}_${best}_hi`];
    if (typeof lo !== "string" || typeof hi !== "string") return;
    out.push({ table: d.name, column: col, earliest: lo, latest: hi });
  });
  return out;
}

/**
 * Every date span in scope. A dataset whose range query fails is skipped —
 * the plan is better without a range than not made at all.
 */
export async function readDateSpans(
  datasets: DatasetMeta[],
  run: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<DateSpan[]> {
  const dated = datasets.filter((d) => datedColumns(d).length > 0).slice(0, MAX_DATED_DATASETS);
  const spans = await Promise.all(
    dated.map(async (d) => {
      try {
        const sql = dateRangeSql(d);
        return sql ? spansFromRow(d, (await run(sql)).rows[0]) : [];
      } catch {
        return [];
      }
    }),
  );
  return spans.flat();
}

/**
 * The block every prompt is given. `forPlan` adds what "latest" means, which
 * only the planner acts on.
 */
export function describeDates(today: string, spans: DateSpan[], forPlan = false): string {
  const lines = [
    `TODAY: ${today}. A date on or before today is in the past — never call it a future date.`,
  ];
  if (spans.length) {
    lines.push(
      "DATES IN THE DATA (earliest → latest value present):",
      ...spans.map((s) => `- ${s.table}.${ident(s.column)}: ${s.earliest} → ${s.latest}`),
    );
  }
  if (forPlan) {
    lines.push(
      'The "latest", "most recent" or "last" year, quarter or month means the newest one the ' +
        "data holds" +
        (spans.length
          ? " (above)"
          : " — find it from the data, never from your own sense of the date") +
        ', not the calendar; "this year", "so far" and "the last 30 days" count back from today. ' +
        "Write date filters with the years the data actually covers.",
    );
  }
  return `\n\n${lines.join("\n")}`;
}
