// A share of real traffic, answered by the candidate.
//
// NO IMPORTS, like the other src/lib/ml*.ts modules, so the scorer, the panel
// and the tests read one set of rules.
//
// SHADOWING AND CANARY ARE NOT THE SAME PROMISE, and the difference is the
// whole reason this is a separate file rather than a flag on the other one:
//
//   A SHADOW answers nobody. Its answers are compared and thrown away, so the
//   worst a broken candidate can do is produce a bad report.
//
//   A CANARY ANSWERS PEOPLE. Some share of real callers get their answer from
//   a version nobody has approved. That is the point — it is the only way to
//   learn how the thing behaves in front of real traffic — but it means the
//   blast radius is real, and everything here exists to bound it.
//
// So what the two MEASURE differs too. Shadowing measures AGREEMENT, because
// both versions answered the same row and the answers can be lined up. A
// canary cannot measure agreement at all: each row was answered once, by one
// version, and there is no second answer to compare it against. What a canary
// measures is whether the candidate is FAILING — and, because a prediction is
// only as good as the version that made it, which version actually answered.

/** What the two sides have done since the canary started. */
export type MlCanaryTotals = {
  /** Requests the version in production answered. */
  primaryRequests: number;
  primaryErrors: number;
  /** Requests the candidate answered — real callers, real answers. */
  candidateRequests: number;
  candidateErrors: number;
};

export type MlCanaryVerdict =
  /** Too few requests through the candidate to say anything. */
  | "watching"
  /** The candidate is failing, and the version in production is not. */
  | "failing"
  /** Both sides are failing, so this is not evidence about the candidate. */
  | "endpoint-failing"
  /** Enough requests, no excess failures. */
  | "healthy";

/**
 * Requests through the candidate before any verdict is given.
 *
 * Twenty is not a statistical claim, it is a cost. Every one of these is a
 * real caller who got their answer from an unapproved version, so the number
 * is the smallest that makes the error rate mean anything rather than the
 * largest that would make it precise.
 */
export const MIN_CANDIDATE_REQUESTS = 20;

/**
 * The candidate's failure rate that counts as failing.
 *
 * Ten per cent — two in twenty — rather than a single failure, because one
 * transient timeout is not evidence that a model is bad, and rolling back on
 * it would make the canary unusable on any real network.
 */
export const ERROR_FLOOR = 0.1;

/**
 * How much worse than production the candidate must be.
 *
 * WITHOUT THIS the canary blames itself for everything. If the lakehouse is
 * down, or the feature view is returning nulls, BOTH sides fail — and rolling
 * back to a version that is failing just as hard fixes nothing while telling
 * the reader something false about the candidate.
 */
export const WORSE_THAN_PRIMARY_BY = 0.05;

/** Failures over requests, or null when nothing has been asked. */
export function errorRate(requests: number, errors: number): number | null {
  if (!Number.isFinite(requests) || requests <= 0) return null;
  return Math.min(1, Math.max(0, errors / requests));
}

/**
 * Does THIS request go to the candidate?
 *
 * `roll` is a number in [0, 1) — the caller supplies it so this stays pure and
 * so a test can walk the boundary instead of sampling at it.
 *
 * PER REQUEST, not per caller. A sticky split would let one unlucky caller
 * take every bad answer while the average looked fine, and a prediction has no
 * session to be sticky to anyway: the same features asked twice are the same
 * question, not a continuing conversation.
 */
export function routeToCandidate(percent: number, roll: number): boolean {
  const p = clampPercent(percent);
  if (p <= 0) return false;
  // A roll outside [0, 1) is not a roll, and it must not be read as "below the
  // threshold" — a mutation check found that dropping the 0% guard changed
  // nothing for well-behaved rolls but sent NEGATIVE ones across at any share,
  // including zero. Invalid input goes to production, which is the direction
  // that cannot surprise anybody.
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) return false;
  return roll < p / 100;
}

/** A share a person is allowed to set: a whole number of per cent, 0 to 100. */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * The share the candidate ACTUALLY answered.
 *
 * Reported next to the configured share rather than instead of it, because a
 * random split lands near the number and not on it, and a reader who sees only
 * "10%" when 13 of 100 went across has been told something that is not true.
 */
export function observedShare(totals: MlCanaryTotals): number | null {
  const total = totals.primaryRequests + totals.candidateRequests;
  if (total <= 0) return null;
  return totals.candidateRequests / total;
}

/** Requests still needed through the candidate before a verdict means anything. */
export function requestsUntilVerdict(totals: MlCanaryTotals): number {
  return Math.max(0, MIN_CANDIDATE_REQUESTS - totals.candidateRequests);
}

/** How the canary is going. */
export function canaryVerdict(totals: MlCanaryTotals): MlCanaryVerdict {
  if (totals.candidateRequests < MIN_CANDIDATE_REQUESTS) return "watching";
  const candidate = errorRate(totals.candidateRequests, totals.candidateErrors);
  if (candidate === null) return "watching";
  if (candidate < ERROR_FLOOR) return "healthy";
  // Failing — but is production failing too? Then the candidate is not what is
  // wrong, and saying it is would send somebody to fix the wrong thing.
  const primary = errorRate(totals.primaryRequests, totals.primaryErrors) ?? 0;
  // EPSILON, and it is not decoration. 0.15 - 0.1 is 0.04999999999999999 in
  // binary floating point, so a candidate exactly the margin worse than
  // production compared as NOT worse and was left serving. Measured, not
  // predicted: the boundary test is what found it. The rule says "at least
  // this much worse", so the comparison has to include its own boundary.
  return candidate - primary >= WORSE_THAN_PRIMARY_BY - 1e-9 ? "failing" : "endpoint-failing";
}

/**
 * Should the platform take the candidate out of the traffic by itself?
 *
 * Yes, and without asking. A canary is the one place where an unapproved model
 * is answering real callers, so the thing that notices it is failing has to be
 * the platform rather than a person watching a panel — nobody is watching at
 * three in the morning. The reason is written down so the endpoint can say
 * what it did and why.
 */
export function rollbackDecision(totals: MlCanaryTotals): {
  rollback: boolean;
  reason: string;
} {
  const verdict = canaryVerdict(totals);
  if (verdict !== "failing") {
    return { rollback: false, reason: reasonFor(verdict, totals) };
  }
  const candidate = errorRate(totals.candidateRequests, totals.candidateErrors) ?? 0;
  return {
    rollback: true,
    reason:
      `Rolled back: the candidate failed ${totals.candidateErrors} of ` +
      `${totals.candidateRequests} requests (${pct(candidate)}), against ` +
      `${pct(errorRate(totals.primaryRequests, totals.primaryErrors) ?? 0)} in production.`,
  };
}

function reasonFor(verdict: MlCanaryVerdict, totals: MlCanaryTotals): string {
  if (verdict === "watching") {
    return `Watching — ${requestsUntilVerdict(totals)} more requests through the candidate.`;
  }
  if (verdict === "endpoint-failing") {
    return "Both versions are failing, so this is not evidence about the candidate.";
  }
  return `Healthy — ${totals.candidateErrors} failures in ${totals.candidateRequests} requests.`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
