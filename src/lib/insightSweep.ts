// Automatic insight sweeps: what a dashboard would tell you if you asked it
// every obvious question, without you asking.
//
// The arithmetic is NOT new. Trends and outliers come from analystSeries
// (least-squares slope; median/MAD outliers, because the outlier inflates the
// very standard deviation a naive check would judge it by). What this module
// adds is SELECTION — deciding which widgets can honestly be swept, which
// findings clear a stated bar, and how to rank them — plus the one thing a
// proactive feature gets wrong most often:
//
//   A SWEEP THAT FOUND NOTHING MUST NOT SAY THERE IS NOTHING WRONG.
//
// "No insights" reads as "all clear" and is used as reassurance. What we
// actually know is narrower: N widgets were examined, M could not be, and
// nothing in the first group crossed these specific thresholds. Every part of
// that sentence matters, so describeSweep says all of it and never the short
// version.
//
// WHY WIDGETS GET SKIPPED, AND WHY SAYING SO IS THE POINT:
//
//   • Truncated snapshots. A widget whose last refresh hit the row cap holds
//     an arbitrary subset. Every claim here is an aggregate — a share, a
//     slope, a total — so computing one over a partial result produces a
//     confident number about data that was cut off mid-way. Refused, with the
//     remedy named.
//   • Mixed-sign measures. "EMEA is 62% of the total" is meaningless when the
//     total nets profits against losses; a share of a signed sum can exceed
//     100% or flip sign. Concentration is refused on those, while trend and
//     outliers — which do not divide by a total — still run.
//   • Too little history. Five points minimum for a trend, per analystSeries.
//     A line through three points fits perfectly and predicts nothing.
//
// Nothing here talks to a database, a model, or React.
import { readSeries, seriesFrom, MIN_SERIES_POINTS } from "@/lib/analystSeries";

export type SweepWidget = {
  id: string;
  title: string;
  kind?: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  /** Last refresh filled the snapshot to the row cap — totals are partial. */
  truncated?: boolean;
};

export type FindingKind = "trend" | "anomaly" | "concentration";

export type Finding = {
  kind: FindingKind;
  widgetId: string;
  widgetTitle: string;
  /** One sentence, already phrased for a reader. */
  headline: string;
  /**
   * How far past its OWN threshold this finding cleared, as a multiple.
   * 1.0 sits exactly on the bar; 3.0 cleared it by three times.
   *
   * This is what makes an outlier and a trend comparable at all. It is a
   * defensible ordering, not a measurement of importance — a 4x trend and a
   * 4x outlier are not equally interesting to every reader, and nothing here
   * pretends to know which one they care about.
   */
  materiality: number;
  /** The numbers behind the sentence, so a reader can check it. */
  detail: Record<string, number | string>;
};

export type SweepSkip = { widgetId: string; widgetTitle: string; reason: string };

export type SweepThresholds = {
  /** Absolute robust z-score (median/MAD) a point must reach. */
  anomalyScore: number;
  /** Slope per period as a fraction of the mean. */
  trendPctPerPeriod: number;
  /** Top member's share of a non-negative total. */
  concentrationShare: number;
  /** Fewest categories before "one of them is most of it" is trivially true. */
  concentrationMinMembers: number;
};

export const SWEEP_THRESHOLDS: SweepThresholds = {
  // Matches analystSeries, which is where the outliers actually come from.
  anomalyScore: 3,
  // 2% per period compounds to ~27% over a year — below that, a "trend" on a
  // dozen points is mostly noise wearing a direction.
  trendPctPerPeriod: 0.02,
  concentrationShare: 0.6,
  // With two members one is always ≥50%, and with three ≥33%. Below four,
  // "concentrated" describes the number of categories, not the business.
  concentrationMinMembers: 4,
};

export type SweepResult = {
  findings: Finding[];
  sweptCount: number;
  skipped: SweepSkip[];
  thresholds: SweepThresholds;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The first column whose values are numbers, excluding one named column. */
function measureColumn(
  columns: string[],
  rows: Record<string, unknown>[],
  exclude?: string,
): string | null {
  return columns.find((c) => c !== exclude && rows.some((r) => isNum(r[c]))) ?? null;
}

/** The first column that is not the measure — the thing being broken down by. */
function categoryColumn(
  columns: string[],
  rows: Record<string, unknown>[],
  measure: string,
): string | null {
  return (
    columns.find((c) => c !== measure && rows.every((r) => !isNum(r[c]) || r[c] === null)) ?? null
  );
}

/**
 * One member dominating a total.
 *
 * Refuses on any negative value. A share is `part ÷ total`, and when the
 * total nets losses against profits that fraction can exceed 1, go negative,
 * or explode as the total approaches zero — each of which renders as a
 * confident percentage that means nothing.
 */
function concentrationFinding(w: SweepWidget, columns: string[], rows: Record<string, unknown>[]) {
  const measure = measureColumn(columns, rows);
  if (!measure) return null;
  const category = categoryColumn(columns, rows, measure);
  if (!category) return null;

  const members = rows
    .filter((r) => isNum(r[measure]))
    .map((r) => ({ label: String(r[category] ?? ""), value: r[measure] as number }));
  if (members.length < SWEEP_THRESHOLDS.concentrationMinMembers) return null;
  if (members.some((m) => m.value < 0)) return null;

  const total = members.reduce((a, m) => a + m.value, 0);
  if (total <= 0) return null;
  const top = members.reduce((a, m) => (m.value > a.value ? m : a));
  const share = top.value / total;
  if (share < SWEEP_THRESHOLDS.concentrationShare) return null;

  return {
    kind: "concentration" as const,
    widgetId: w.id,
    widgetTitle: w.title,
    headline: `${top.label} is ${(share * 100).toFixed(0)}% of ${measure} across ${members.length} ${category} values.`,
    materiality: share / SWEEP_THRESHOLDS.concentrationShare,
    detail: { share, top: top.label, value: top.value, total, members: members.length },
  };
}

/**
 * Sweep one widget.
 *
 * Returns findings AND, when nothing could be examined, the reason — the
 * caller needs both to say honestly what was covered.
 */
export function sweepWidget(w: SweepWidget): { findings: Finding[]; skip?: string } {
  if (w.kind && w.kind !== "chart") {
    return { findings: [], skip: "not a data widget" };
  }
  const rows = Array.isArray(w.rows) ? w.rows : [];
  const columns = Array.isArray(w.columns) && w.columns.length > 0 ? w.columns : keysOf(rows);
  if (rows.length === 0) return { findings: [], skip: "no data snapshot to examine" };
  if (w.truncated) {
    // Every finding below is an aggregate over the whole result. Over a
    // capped one they are aggregates over an arbitrary prefix.
    return {
      findings: [],
      skip: "the snapshot hit its row cap, so any total or share would be computed from part of the data",
    };
  }
  if (columns.length === 0) return { findings: [], skip: "no columns to examine" };

  const findings: Finding[] = [];

  const points = seriesFrom(columns, rows);
  if (points) {
    const reading = readSeries(points);
    if (reading) {
      const pct = reading.slopePctPerPeriod;
      if (pct !== null && Math.abs(pct) >= SWEEP_THRESHOLDS.trendPctPerPeriod) {
        findings.push({
          kind: "trend",
          widgetId: w.id,
          widgetTitle: w.title,
          headline: `${reading.direction === "rising" ? "Rising" : "Falling"} ${(Math.abs(pct) * 100).toFixed(1)}% per period across ${points.length} periods (${reading.first.label} → ${reading.last.label}).`,
          materiality: Math.abs(pct) / SWEEP_THRESHOLDS.trendPctPerPeriod,
          detail: {
            direction: reading.direction,
            pctPerPeriod: pct,
            periods: points.length,
            from: reading.first.label,
            to: reading.last.label,
          },
        });
      }
      for (const a of reading.anomalies) {
        findings.push({
          kind: "anomaly",
          widgetId: w.id,
          widgetTitle: w.title,
          headline: `${a.label} is unusually ${a.direction} at ${a.value.toLocaleString()} — ${Math.abs(a.score).toFixed(1)} MAD from the median.`,
          materiality: Math.abs(a.score) / SWEEP_THRESHOLDS.anomalyScore,
          detail: { label: a.label, value: a.value, score: a.score, direction: a.direction },
        });
      }
    }
  }

  const conc = concentrationFinding(w, columns, rows);
  if (conc) findings.push(conc);

  if (findings.length === 0) {
    // Examined and clean is NOT the same as skipped, so no reason is
    // returned — this widget counts towards coverage.
    return { findings: [] };
  }
  return { findings };
}

function keysOf(rows: Record<string, unknown>[]): string[] {
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}

/** Sweep a dashboard's widgets, ranked by how far each finding cleared its bar. */
export function sweepDashboard(widgets: SweepWidget[], limit = 8): SweepResult {
  const findings: Finding[] = [];
  const skipped: SweepSkip[] = [];
  let sweptCount = 0;

  for (const w of Array.isArray(widgets) ? widgets : []) {
    if (!w || typeof w !== "object" || typeof w.id !== "string") continue;
    const out = sweepWidget(w);
    if (out.skip) {
      skipped.push({ widgetId: w.id, widgetTitle: w.title, reason: out.skip });
      continue;
    }
    sweptCount++;
    findings.push(...out.findings);
  }

  findings.sort((a, b) => b.materiality - a.materiality);
  return { findings: findings.slice(0, limit), sweptCount, skipped, thresholds: SWEEP_THRESHOLDS };
}

/**
 * What the sweep actually established, in one paragraph.
 *
 * The empty case is the one that matters. "No insights found" is read as an
 * all-clear, and this sweep cannot support that: it looked at some widgets,
 * could not look at others, and applied specific bars. Saying all three is
 * the difference between a summary and a false reassurance.
 */
export function describeSweep(r: SweepResult): string {
  const swept = `${r.sweptCount} widget${r.sweptCount === 1 ? "" : "s"}`;
  const couldNot =
    r.skipped.length > 0
      ? ` ${r.skipped.length} could not be swept and ${r.skipped.length === 1 ? "is" : "are"} listed below.`
      : "";
  if (r.findings.length === 0) {
    return (
      `Swept ${swept}. Nothing crossed the thresholds — trend ≥ ` +
      `${(r.thresholds.trendPctPerPeriod * 100).toFixed(0)}% per period, outliers ≥ ` +
      `${r.thresholds.anomalyScore} MAD, one member ≥ ` +
      `${(r.thresholds.concentrationShare * 100).toFixed(0)}% of a total. ` +
      `That is not the same as nothing being wrong: this sweep only looks at ` +
      `what is already on the dashboard.${couldNot}`
    );
  }
  const n = r.findings.length;
  return `Swept ${swept} and found ${n} thing${n === 1 ? "" : "s"} worth a look, strongest first.${couldNot}`;
}

/** Group findings by widget, for rendering beside each card. */
export function findingsByWidget(r: SweepResult): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of r.findings) {
    const list = out.get(f.widgetId);
    if (list) list.push(f);
    else out.set(f.widgetId, [f]);
  }
  return out;
}

/** The minimum history a trend needs, re-exported so the UI can say so. */
export { MIN_SERIES_POINTS };
