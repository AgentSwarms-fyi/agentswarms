/**
 * Cut a list that was fetched one row PAST its cap, and say whether it was.
 *
 * A list fetched AT its cap cannot tell "exactly cap rows" from "more than
 * cap rows", so every consumer presented the prefix as the whole — "Jobs
 * (20)" over thirty-five training jobs, the newest fifty prediction runs as
 * every run there was (R62). The caller asks for `cap + 1`; if that many came
 * back, the list has more and the extra row is the proof. The twin of
 * semanticTrim in lib/semanticLayer, for lists that are not semantic queries.
 */
export function capList<T>(rows: T[], cap: number): { rows: T[]; truncated: boolean } {
  return rows.length > cap
    ? { rows: rows.slice(0, cap), truncated: true }
    : { rows, truncated: false };
}
