// A model's drift over time (R548), as rows a chart draws and a sentence.
//
// Two readings of the same measure, the population stability index against
// the training data: each batch run's own, and the day's live traffic (R545,
// one row a day from R548). They are different populations -
// a table scored in bulk, and the requests answered one at a time - so they
// are two lines on one axis, never averaged into one.
//
// Pure, so the page and a test agree.

/** How far back the chart reads. */
export const DRIFT_HISTORY_DAYS = 90;

export type BatchDriftPoint = { at: string; score: number; version: number | null };
export type DailyTrafficPoint = {
  day: string;
  score: number | null;
  rows: number;
  version: number | null;
};

/** One day on the chart. A day with no reading of a kind leaves it out. */
export type DriftHistoryRow = {
  day: string;
  /** The highest batch PSI that day, and how many runs measured it. */
  batch?: number;
  batchRuns?: number;
  /** The day's live-traffic PSI, and the rows behind it. */
  live?: number;
  liveRows?: number;
  /** The versions that answered that day, for the tooltip. */
  versions: number[];
};

const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * Batch runs and daily live verdicts, one row per day that has either,
 * oldest first. Several runs on one day show the highest: a chart that
 * averaged them would hide the run that crossed the threshold. Several
 * versions answering live traffic on one day (a canary) likewise.
 */
export function driftHistoryRows(
  batch: BatchDriftPoint[],
  daily: DailyTrafficPoint[],
): DriftHistoryRow[] {
  const rows = new Map<string, DriftHistoryRow>();
  const row = (day: string) => {
    let r = rows.get(day);
    if (!r) {
      r = { day, versions: [] };
      rows.set(day, r);
    }
    return r;
  };
  const addVersion = (r: DriftHistoryRow, v: number | null) => {
    if (v !== null && !r.versions.includes(v)) r.versions.push(v);
  };
  for (const b of batch) {
    if (!Number.isFinite(b.score)) continue;
    const r = row(dayOf(b.at));
    r.batch = r.batch === undefined ? b.score : Math.max(r.batch, b.score);
    r.batchRuns = (r.batchRuns ?? 0) + 1;
    addVersion(r, b.version);
  }
  for (const d of daily) {
    if (d.score === null || !Number.isFinite(d.score)) continue;
    const r = row(d.day);
    if (r.live === undefined || d.score > r.live) {
      r.live = d.score;
      r.liveRows = d.rows;
    }
    addVersion(r, d.version);
  }
  for (const r of rows.values()) r.versions.sort((a, b) => a - b);
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const fmt = (n: number) => n.toFixed(2);

/**
 * One sentence over the rows: how much was measured, the highest of each,
 * and how many days crossed the threshold. Null when nothing was measured.
 */
export function driftHistoryLine(rows: DriftHistoryRow[], threshold: number): string | null {
  const batch = rows.filter((r) => r.batch !== undefined);
  const live = rows.filter((r) => r.live !== undefined);
  if (!batch.length && !live.length) return null;
  const parts: string[] = [];
  const peak = (list: DriftHistoryRow[], key: "batch" | "live") =>
    list.reduce((a, b) => ((b[key] as number) > (a[key] as number) ? b : a));
  if (batch.length) {
    const runs = batch.reduce((n, r) => n + (r.batchRuns ?? 0), 0);
    const top = peak(batch, "batch");
    parts.push(
      `${runs} batch run${runs === 1 ? "" : "s"} measured, the highest PSI ${fmt(top.batch as number)} on ${top.day}`,
    );
  }
  if (live.length) {
    const top = peak(live, "live");
    parts.push(
      `live traffic measured on ${live.length} day${live.length === 1 ? "" : "s"}, the highest ${fmt(top.live as number)} on ${top.day}`,
    );
  }
  const over = rows.filter(
    (r) => (r.batch ?? -1) >= threshold || (r.live ?? -1) >= threshold,
  ).length;
  const tail =
    over === 0
      ? `; no day reached the alert threshold of ${fmt(threshold)}.`
      : `; ${over} day${over === 1 ? "" : "s"} reached the alert threshold of ${fmt(threshold)}.`;
  return `Over the last ${DRIFT_HISTORY_DAYS} days: ${parts.join("; ")}${tail}`;
}

// ── Drawing it (FOUND FROM THE UI, R548) ─────────────────────────────────────
//
// One run at PSI 6.3 put the threshold (0.25) and the moderate line (0.1) on
// the floor of a linear axis, so the chart could not show the one thing it is
// for. PSI is drawn on a log axis: 0.1, 0.25 and 6 are all readable.

/** A log axis cannot show 0; a reading below this is drawn on it, and the tooltip says the real one. */
export const DRIFT_PLOT_FLOOR = 0.01;

export type DriftPlotRow = DriftHistoryRow & { batchPlot?: number; livePlot?: number };

/** The rows with the values a log axis can draw beside the real ones. */
export function driftPlotRows(rows: DriftHistoryRow[]): DriftPlotRow[] {
  return rows.map((r) => ({
    ...r,
    ...(r.batch !== undefined ? { batchPlot: Math.max(r.batch, DRIFT_PLOT_FLOOR) } : {}),
    ...(r.live !== undefined ? { livePlot: Math.max(r.live, DRIFT_PLOT_FLOOR) } : {}),
  }));
}

/** The axis: from the floor to the next power of ten above everything drawn, ticked at powers of ten. */
export function driftAxis(
  rows: DriftHistoryRow[],
  threshold: number,
): { domain: [number, number]; ticks: number[] } {
  const top = Math.max(threshold, ...rows.flatMap((r) => [r.batch ?? 0, r.live ?? 0]));
  const max = 10 ** Math.ceil(Math.log10(top * 1.05));
  const ticks: number[] = [];
  for (let t = DRIFT_PLOT_FLOOR; t <= max * 1.0001; t *= 10) ticks.push(Number(t.toPrecision(1)));
  return { domain: [DRIFT_PLOT_FLOOR, max], ticks };
}
