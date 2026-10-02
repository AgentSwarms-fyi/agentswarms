// A model's health, as a sentence an agent can repeat.
//
// The platform already notices two things about a model in production: the
// rows it is asked to score DRIFTING from what it learned on (a PSI on every
// prediction run, an alert past the operator's threshold) and its accuracy
// DECAYING against outcomes that arrived later (an evaluation with a verdict).
// Both were told to the owner — a notification, an audit row — and to nobody
// else: an agent listing the model, or an analyst scoring with it, said
// nothing, so an answer could rest on a model whose owner had been warned
// about it that morning.
//
// This module turns the latest of each into the words that travel with the
// model wherever it is offered. Pure, so the agent tool, the analyst's
// planner and the Playground can all agree on the sentence, and a test can
// feed it readings.

export type DriftReading = {
  /** Population stability index of the most recent scored rows vs training. */
  score: number;
  /** The operator's alert threshold at the time it was read. */
  threshold: number;
  at: string;
};

export type EvaluationReading = {
  metric: string;
  value: number;
  baseline: number | null;
  /** (baseline - current) / |baseline|, sign-normalised so positive is worse. */
  decayRatio: number | null;
  verdict: "stable" | "degraded" | "improved" | null;
  at: string;
};

export type ModelHealth = {
  drift: DriftReading | null;
  evaluation: EvaluationReading | null;
  /**
   * What is currently wrong, as full sentences. Empty means nothing the
   * platform can see — which is not the same as healthy, and the summary
   * says which.
   */
  alerts: string[];
  /** One line for a prompt, a badge or a list entry. Null when nothing has been measured. */
  summary: string | null;
};

const day = (iso: string) => iso.slice(0, 10);
const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))));
const pct = (ratio: number) => `${Math.round(Math.abs(ratio) * 100)}%`;

export function describeModelHealth(
  drift: DriftReading | null,
  evaluation: EvaluationReading | null,
): ModelHealth {
  const alerts: string[] = [];
  const short: string[] = [];
  if (drift && drift.score >= drift.threshold) {
    alerts.push(
      `Drift: the rows scored on ${day(drift.at)} differ from the training data (PSI ${num(drift.score)} against the alert threshold ${num(drift.threshold)}); consider retraining before trusting new predictions.`,
    );
    short.push(`open drift alert (PSI ${num(drift.score)} on ${day(drift.at)})`);
  }
  if (evaluation?.verdict === "degraded") {
    const worse = evaluation.decayRatio !== null ? ` (${pct(evaluation.decayRatio)} worse)` : "";
    alerts.push(
      `Decay: ${evaluation.metric} ${num(evaluation.value)} against ${evaluation.baseline === null ? "its training score" : num(evaluation.baseline)} at training${worse}, measured on ${day(evaluation.at)}; consider retraining.`,
    );
    short.push(`degraded (${evaluation.metric} ${num(evaluation.value)} on ${day(evaluation.at)})`);
  } else if (evaluation?.verdict === "improved") {
    // Markedly better than its own validation score is a warning, not a
    // compliment: the outcome is usually leaking into the features.
    const better =
      evaluation.decayRatio !== null
        ? ` (${pct(evaluation.decayRatio)} better than at training)`
        : "";
    alerts.push(
      `Check: ${evaluation.metric} ${num(evaluation.value)} on ${day(evaluation.at)} is markedly better than at training${better} — usually an outcome leaking into the features or mismatched rows, not good news.`,
    );
    short.push(
      `suspiciously improved (${evaluation.metric} ${num(evaluation.value)} on ${day(evaluation.at)})`,
    );
  }
  let summary: string | null = short.length ? short.join("; ") : null;
  if (!summary && evaluation) {
    summary = `evaluated ${evaluation.verdict ?? "without a verdict"} on ${day(evaluation.at)} (${evaluation.metric} ${num(evaluation.value)})`;
  }
  if (!summary && drift) {
    summary = `no drift on ${day(drift.at)} (PSI ${num(drift.score)})`;
  }
  return { drift, evaluation, alerts, summary };
}

/** The line an agent tool or a planner carries beside the model's name. */
export function healthLine(health: ModelHealth | null | undefined): string | null {
  if (!health) return null;
  if (health.alerts.length) return `Health: ${health.alerts.join(" ")}`;
  return health.summary ? `Health: ${health.summary}.` : null;
}
