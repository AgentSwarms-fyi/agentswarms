// The pass rate an evaluation run is entitled to display.
//
// MEASURED on /evaluations: the page computed `d > 0 ? round(n/d*100) : 0`,
// so a run with 0 of 12 cases scored rendered "0% pass" — a failing grade for
// work that had not been marked. The avg-score card beside it showed "—" for
// the same run, so the page contradicted itself on a screen whose entire
// output is a verdict, and the worse half was the one that looked like data.
//
// Zero is a real pass rate (every scored case failed) and must stay sayable;
// "nothing scored yet" is not zero. That distinction is the whole module.

/** Percentage of scored cases that passed, or null when none are scored. */
export function passRate(passed: number, scored: number): number | null {
  if (!Number.isFinite(passed) || !Number.isFinite(scored)) return null;
  if (scored <= 0) return null;
  return Math.round((passed / scored) * 100);
}

/** Display form: "83%", or "—" when no case has been scored. */
export function formatPassRate(passed: number, scored: number): string {
  const r = passRate(passed, scored);
  return r === null ? "—" : `${r}%`;
}
