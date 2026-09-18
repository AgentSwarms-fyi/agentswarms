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

/**
 * A compact, authoritative digest of a widget's rows.
 *
 * Returns "" when there is nothing worth stating — no rows, or no measure to
 * total — so the caller can leave the prompt exactly as it was.
 */
export function insightFacts(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = columns.length ? columns : Object.keys(rows[0] ?? {});
  const measures = cols.filter((c) => isMeasure(rows, c));
  if (measures.length === 0) return "";
  const dimension = cols.find((c) => !measures.includes(c)) ?? null;

  const lines: string[] = [`ROWS: ${rows.length}`];

  for (const m of measures) {
    const vals = rows.map((r) => num(r[m])).filter((n): n is number => n !== null);
    if (vals.length === 0) continue;
    const sum = vals.reduce((a, b) => a + b, 0);
    lines.push(
      `${m}: total=${round2(sum)} min=${round2(Math.min(...vals))} ` +
        `max=${round2(Math.max(...vals))} mean=${round2(sum / vals.length)}`,
    );
  }

  // Shares only where a share is a meaningful thing to state: one row per
  // category, nothing negative, and a positive total to divide by. A "share"
  // of a mixed-sign column (profit, variance) is arithmetic that means
  // nothing, and stating it would repeat the mistake in a new place.
  const first = measures[0];
  if (dimension && rows.length <= 25) {
    const vals = rows.map((r) => num(r[first]));
    const total = vals.reduce<number>((a, b) => a + (b ?? 0), 0);
    const allNonNegative = vals.every((v) => v === null || v >= 0);
    const labels = rows.map((r) => String(r[dimension] ?? "—"));
    const unique = new Set(labels).size === labels.length;
    if (allNonNegative && total > 0 && unique) {
      const parts = rows.map((r, i) => {
        const v = vals[i] ?? 0;
        return `${labels[i]}=${round2(v)} (${((v / total) * 100).toFixed(1)}%)`;
      });
      lines.push(`SHARE OF ${first} BY ${dimension}: ${parts.join(", ")}`);
      lines.push(`(these percentages are computed over every row and sum to 100%)`);
    }
  }

  return lines.join("\n");
}
