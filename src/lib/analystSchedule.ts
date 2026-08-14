// Re-running a saved analysis on a cadence.
//
// A SCHEDULE RE-RUNS THE QUERIES, IT DOES NOT RE-ASK THE QUESTION. The
// tempting design is to hand the question back to the model every morning, and
// it is wrong: the analyst re-plans, so consecutive runs can answer the same
// sentence with different SQL. A number you watch over time whose definition
// moves underneath you is the exact failure the semantic layer exists to
// prevent, and a schedule is the surface where it would happen daily and
// invisibly. So the steps are PINNED: the SQL that ran is the SQL that runs
// again, and a genuinely new analysis is a question you ask.
//
// WHICH LEAVES THE PROSE BEHIND. The findings were written from the previous
// numbers. Re-synthesizing them automatically would put a model's paragraph
// in front of a reader who was not there to judge it; keeping them silently
// beside fresh numbers is worse. Both are avoidable: the turn is marked
// `answerStale`, the same mechanism an edited step already uses, and the
// reader rewrites the findings when they want them.
//
// A HUMAN VERDICT SURVIVES, and that is deliberate rather than an oversight.
// The fingerprint covers each step's SQL and the governed model that compiled
// it — neither changed — and the rule was always that the same SQL over
// refreshed data is the same checked work. What the verdict never covered is
// the write-up, which is why the stale marker above matters.
//
// WHAT CHANGED IS COMPUTED, NOT NARRATED. Same discipline as the driver
// analysis and the what-if delta: a model asked to eyeball two tables produces
// a plausible difference, and a plausible difference reads exactly as
// confident as a correct one.
import { scenarioDelta, type MetricDelta } from "@/lib/analystScenario";
import type { AnalystStep, AnalystTurn } from "@/lib/aiAnalyst";

export type ScheduleCadence = "hourly" | "daily" | "weekly";

/**
 * Why this analysis cannot be scheduled, or null when it can.
 *
 * Returned as a reason rather than a boolean because every one of these is
 * something the user can act on, and "Schedule" sitting there disabled with no
 * explanation is its own small dishonesty.
 */
export function scheduleRefusal(turn: AnalystTurn | undefined): string | null {
  if (!turn) return "Ask a question first — there is no analysis to refresh.";
  if (turn.clarify) {
    return "This analysis stopped to ask a question. Answer it, then schedule the result.";
  }
  const runnable = (turn.steps ?? []).filter((s) => (s.sql ?? "").trim().length > 0);
  if (runnable.length === 0) {
    return "This analysis ran no queries, so a schedule would have nothing to re-run.";
  }
  return null;
}

/** The steps a scheduled run will re-execute, in order. */
export function pinnedSteps(turn: AnalystTurn): AnalystStep[] {
  return (turn.steps ?? []).filter((s) => (s.sql ?? "").trim().length > 0);
}

/** One step's fresh result, as the runner produced it. */
export type StepResult =
  | { columns: string[]; rows: Record<string, unknown>[]; rowCount: number }
  | { error: string };

/**
 * Fold fresh results back into the turn.
 *
 * Only results move. The goal, the SQL, the chart spec, the governed
 * disclosure and the verdict are all carried through untouched — a refresh
 * that rewrote any of them would be answering a different question under the
 * same heading. Scenarios are DROPPED: a what-if computed against last
 * week's numbers is not a what-if against this week's, and leaving it beside
 * refreshed measurements invites exactly the comparison it cannot support.
 */
export function refreshedTurn(turn: AnalystTurn, results: StepResult[]): AnalystTurn {
  let i = 0;
  const steps = (turn.steps ?? []).map((s) => {
    if (!(s.sql ?? "").trim()) return s;
    const r = results[i++];
    if (!r) return s;
    if ("error" in r) return { ...s, error: r.error, status: "error" as const };
    const { scenario: _dropped, ...rest } = s;
    return {
      ...rest,
      columns: r.columns,
      rows: r.rows,
      rowCount: r.rowCount,
      error: undefined,
      status: "done" as const,
    };
  });
  return {
    ...turn,
    steps,
    // The findings predate these numbers. Say so rather than re-synthesizing
    // behind the reader's back.
    answerStale: true,
    at: turn.at,
  };
}

/**
 * What moved between two runs of the same analysis.
 *
 * Precise where a comparison is safe — a single-row result has one obvious
 * counterpart — and a row count where it is not. Grouped results have a
 * row-MATCHING problem, and matching wrongly is worse than not comparing:
 * "EMEA fell 12%" against the wrong row is a fabricated finding.
 */
export function analysisChanges(before: AnalystTurn, after: AnalystTurn): string[] {
  const out: string[] = [];
  const b = before.steps ?? [];
  const a = after.steps ?? [];
  for (let i = 0; i < a.length; i++) {
    const bs = b[i];
    const as = a[i];
    if (!bs || !as) continue;
    const label = as.goal || `Step ${i + 1}`;
    if (as.error) {
      out.push(`${label}: failed — ${as.error}`);
      continue;
    }
    const bRows = bs.rows ?? [];
    const aRows = as.rows ?? [];
    if (bRows.length === 1 && aRows.length === 1) {
      const metrics = numericKeys(aRows[0]);
      for (const d of scenarioDelta(metrics, bRows, aRows)) {
        // A metric that did not move is not a change. Listing it would make
        // the digest announce "what changed" over a page of numbers that
        // didn't — which is how a report earns being ignored.
        if (d.change === 0) continue;
        out.push(`${label} — ${describeDelta(d)}`);
      }
      continue;
    }
    const bc = bs.rowCount ?? bRows.length;
    const ac = as.rowCount ?? aRows.length;
    if (bc !== ac) out.push(`${label}: ${bc} → ${ac} rows`);
  }
  return out;
}

/** Numeric columns of a single result row — the ones worth comparing. */
function numericKeys(row: Record<string, unknown> | undefined): string[] {
  return Object.entries(row ?? {})
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([k]) => k);
}

/**
 * One delta as a sentence.
 *
 * `scenarioDelta` names its sides baseline/scenario because that is what it
 * was built for; here they are the previous run and this one. The arithmetic
 * is identical and deliberately not repeated — including the rule that a
 * percentage change from zero is not a number.
 */
export function describeDelta(d: MetricDelta): string {
  const pct = d.pctChange === null ? "" : `, ${(d.pctChange * 100).toFixed(1)}%`;
  const sign = d.change >= 0 ? "+" : "";
  return `${d.metric}: ${d.baseline} → ${d.scenario} (${sign}${d.change}${pct})`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The cadence in words, so the UI never shows a bare cron-ish tuple. */
export function describeSchedule(
  cadence: ScheduleCadence,
  atHour: number,
  weekday: number,
): string {
  const hh = `${String(Math.max(0, Math.min(23, Math.trunc(atHour)))).padStart(2, "0")}:00 UTC`;
  if (cadence === "hourly") return "Every hour, on the hour";
  if (cadence === "daily") return `Every day at ${hh}`;
  return `Every ${WEEKDAYS[((Math.trunc(weekday) % 7) + 7) % 7]} at ${hh}`;
}

/**
 * The digest a run sends.
 *
 * Says plainly when nothing moved. A scheduled report that only ever arrives
 * with news teaches people that silence means "not run"; one that always
 * claims news teaches them to ignore it.
 */
export function runDigest(
  analysisTitle: string,
  changes: string[],
): { title: string; body: string } {
  if (changes.length === 0) {
    return {
      title: `Refreshed — "${analysisTitle}"`,
      body: "The queries re-ran and nothing measurable changed.",
    };
  }
  return {
    title: `What changed — "${analysisTitle}"`,
    body: changes.join("\n").slice(0, 800),
  };
}
