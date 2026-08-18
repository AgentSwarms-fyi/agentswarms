// Which panel, if any, may be crowned "best" in the Prompt Compare table.
//
// MEASURED on /prompt-compare with three panels, two answering and one failing
// fast: the failed model was highlighted green as the Response-time winner at
// 0.1s, against 2.0s and 2.7s from the two that actually answered. It had
// produced no content at all. The old rule was `minIdx` over the raw values —
// and a request that errors still records a duration, so failing quickly beat
// answering correctly.
//
// Two rules, both about what a comparison is entitled to say:
//
//   1. A panel that did not produce an answer is not a competitor. Its speed
//      measures how fast it failed, which is not the quantity on display.
//   2. A winner over a field where the rivals' values are UNKNOWN is not a
//      winner. If only one panel has a known cost — the others returned no
//      usage — then "cheapest" is a comparison of one, and the highlight
//      claims a ranking that was never computed.

export type ComparablePanel = {
  /** The panel produced an answer (non-empty content, no error). */
  answered: boolean;
  /** The metric's value for this panel, or null when it could not be measured. */
  value: number | null;
};

/**
 * Index of the winning panel, or -1 when no honest winner exists.
 *
 * Lower is better for every metric this is used for (time, cost).
 */
export function winnerIndex(panels: ComparablePanel[]): number {
  const eligible = panels.map((p, i) => ({ ...p, i })).filter((p) => p.answered && p.value != null);

  // Nothing to crown, or only one panel is comparable at all: a field of one
  // has no winner. Highlighting it would present "the only measurable value"
  // as "the best value".
  if (eligible.length < 2) return -1;

  let best = -1;
  let bestVal = Infinity;
  for (const p of eligible) {
    if ((p.value as number) < bestVal) {
      bestVal = p.value as number;
      best = p.i;
    }
  }
  return best;
}

/**
 * A note for the comparison, when some panels could not take part — so the
 * reader knows the ranking covers fewer models than the table shows.
 */
export function comparisonCaveat(panels: ComparablePanel[]): string | null {
  const excluded = panels.filter((p) => !p.answered).length;
  const unmeasured = panels.filter((p) => p.answered && p.value == null).length;
  if (excluded === 0 && unmeasured === 0) return null;
  const parts: string[] = [];
  if (excluded > 0) parts.push(`${excluded} did not answer`);
  if (unmeasured > 0) parts.push(`${unmeasured} reported no figure`);
  return `ranking excludes ${parts.join(" and ")}`;
}
