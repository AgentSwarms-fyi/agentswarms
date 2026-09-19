// Arithmetic for an insight card, computed rather than asked for.
//
// The AI insight on "Sales by Region" read: EMEA $1.0M **48%**, AMER $837k
// **39%**, APJ $415k **19%** — three shares of one total that sum to 106%.
// No denominator makes that true, and the card is headed "What the data
// shows". The model had the rows and did the division itself.
//
// So the division stops being the model's job. This builds a short block of
// facts from the full snapshot — totals, ranges, and each category's share —
// and the prompt tells the model to quote it rather than derive anything. A
// language model is good at saying what a number means and bad at working out
// what the number is; this hands it the second half already done.
//
// It also closes a quieter gap: the prompt sends only the first 30 rows, so
// on a longer result the model was generalising from a sample while the card
// spoke about the whole. These figures are over every row.

/** Coerce to a finite number, the way a chart value would be read. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Epoch-shaped: a timestamp is not a measure, and must not be summed. */
function looksLikeEpoch(n: number): boolean {
  if (!Number.isInteger(n)) return false;
  const a = Math.abs(n);
  return (a >= 1e12 && a <= 4.102e12) || (a >= 1e9 && a <= 4.102e9);
}

function isMeasure(rows: Record<string, unknown>[], col: string): boolean {
  let seen = 0;
  let numeric = 0;
  let epochish = 0;
  let yearish = 0;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    seen++;
    const n = num(v);
    if (n === null) continue;
    numeric++;
    if (looksLikeEpoch(n)) epochish++;
    if (Number.isInteger(n) && n >= 1000 && n <= 9999) yearish++;
  }
  if (seen === 0 || numeric / seen < 0.8) return false;
  // A column of timestamps is a dimension wearing numbers, and summing it
  // produces a number with no meaning presented with the authority of a total.
  if (epochish / numeric >= 0.8) return false;
  // Same for a column that is ALL four-digit integers: 2023 + 2024 = 4047 is
  // not a fact about anything. This is the reading parseDateValue and the
  // report's column kinds already take of 2026, so the product is at least
  // consistent about it. The cost is a genuine measure whose every value
  // happens to land in 1000..9999 losing its total — an omitted fact, where
  // the alternative is a false one.
  return yearish !== numeric;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The measured shape of a widget's rows, before any of it becomes prose. */
export type InsightFacts = {
  rowCount: number;
  measures: { name: string; total: number; min: number; max: number; mean: number }[];
  /** The dimension the shares are broken down by, when shares are meaningful. */
  dimension: string | null;
  shares: { label: string; value: number; pct: number }[];
};

/**
 * Measure the rows.
 *
 * Split out from the prompt string so the same numbers can be used twice: once
 * to tell the model what is true, and once to check what it wrote. A digest
 * that only ever existed as prose could steer a model but never catch one.
 */
export function computeInsightFacts(
  columns: string[],
  rows: Record<string, unknown>[],
): InsightFacts | null {
  if (rows.length === 0) return null;
  const cols = columns.length ? columns : Object.keys(rows[0] ?? {});
  const measureNames = cols.filter((c) => isMeasure(rows, c));
  if (measureNames.length === 0) return null;
  const dimension = cols.find((c) => !measureNames.includes(c)) ?? null;

  const measures: InsightFacts["measures"] = [];
  for (const m of measureNames) {
    const vals = rows.map((r) => num(r[m])).filter((n): n is number => n !== null);
    if (vals.length === 0) continue;
    const sum = vals.reduce((a, b) => a + b, 0);
    measures.push({
      name: m,
      total: round2(sum),
      min: round2(Math.min(...vals)),
      max: round2(Math.max(...vals)),
      mean: round2(sum / vals.length),
    });
  }

  // Shares only where a share is a meaningful thing to state: one row per
  // category, nothing negative, and a positive total to divide by. A "share"
  // of a mixed-sign column (profit, variance) is arithmetic that means
  // nothing, and stating it would repeat the mistake in a new place.
  const shares: InsightFacts["shares"] = [];
  const first = measureNames[0];
  if (dimension && rows.length <= 25) {
    const vals = rows.map((r) => num(r[first]));
    const total = vals.reduce<number>((a, b) => a + (b ?? 0), 0);
    const allNonNegative = vals.every((v) => v === null || v >= 0);
    const labels = rows.map((r) => String(r[dimension] ?? "—"));
    const unique = new Set(labels).size === labels.length;
    if (allNonNegative && total > 0 && unique) {
      rows.forEach((_, i) => {
        const v = vals[i] ?? 0;
        shares.push({ label: labels[i], value: round2(v), pct: (v / total) * 100 });
      });
    }
  }

  return { rowCount: rows.length, measures, dimension, shares };
}

/**
 * The row cap a query imposed on itself, or null.
 *
 * Found by driving the product: the AI generated a widget titled "Revenue by
 * Region" whose SQL ended `ORDER BY total_revenue DESC LIMIT 1`, so the chart
 * drew one bar and the insight card then wrote "AMER accounts for 100% of the
 * total revenue" and "there are no other regions contributing to revenue".
 * Both sentences are TRUE of the rows the widget holds and false about the
 * business, which is the most dangerous shape a generated claim can take —
 * every figure in it verifies.
 *
 * A check on the prose cannot catch that, because the prose is not wrong about
 * its data. What has to change is what the model is told the data IS.
 */
export function queryRowLimit(sql: string | undefined): number | null {
  if (!sql) return null;
  const m = /\blimit\s+(\d+)\s*;?\s*$/i.exec(sql.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** The digest as the prompt carries it. */
export function formatInsightFacts(f: InsightFacts, rowLimit?: number | null): string {
  const lines: string[] = [`ROWS: ${f.rowCount}`];
  for (const m of f.measures) {
    lines.push(`${m.name}: total=${m.total} min=${m.min} max=${m.max} mean=${m.mean}`);
  }
  // Shares of a truncated result are shares of nothing. Stating them invites
  // exactly the "100% of the total" sentence this is here to prevent, so a
  // capped query gets the caveat INSTEAD of the percentages.
  if (rowLimit != null) {
    lines.push(
      `PARTIAL: the query ends with LIMIT ${rowLimit}, so these are the top ` +
        `${rowLimit} row(s) only and NOT the whole breakdown. The totals above ` +
        `cover just these rows. Do not state shares of a total, do not call ` +
        `anything 100%, and do not say other categories are absent — the query ` +
        `did not ask for them.`,
    );
  } else if (f.shares.length > 0 && f.dimension) {
    const parts = f.shares.map((s) => `${s.label}=${s.value} (${s.pct.toFixed(1)}%)`);
    lines.push(`SHARE OF ${f.measures[0].name} BY ${f.dimension}: ${parts.join(", ")}`);
    lines.push(`(these percentages are computed over every row and sum to 100%)`);
  }
  return lines.join("\n");
}

/**
 * A compact, authoritative digest of a widget's rows.
 *
 * Returns "" when there is nothing worth stating — no rows, or no measure to
 * total — so the caller can leave the prompt exactly as it was.
 */
export function insightFacts(
  columns: string[],
  rows: Record<string, unknown>[],
  sql?: string,
): string {
  const f = computeInsightFacts(columns, rows);
  return f ? formatInsightFacts(f, queryRowLimit(sql)) : "";
}
