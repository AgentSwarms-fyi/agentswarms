// The home dashboard's status band, as a pure derivation: what the seven
// health checks answered, and what the band may therefore say. Kept out of
// the component file so it can be imported by tests and the page without
// tripping fast refresh.

export type Attention = {
  /** What is wrong, in the words the owner would use. */
  label: string;
  /** How many; null when the check itself could not be read. */
  count: number | null;
  to: string;
  /** Why the check could not be read, when count is null. */
  error?: string;
};

export type BandSummary = {
  state: "loading" | "ok" | "attention" | "unknown";
  /** Things that need attention, summed over the checks that answered. */
  total: number;
  /** Checks that could not be read. */
  unknown: number;
  text: string;
};

/**
 * What the band may say, from what the checks answered.
 *
 * FOUND FROM THE UI. A failed count used to land as `count ?? 0`, so a
 * dashboard whose reads had all failed said "Everything is running" — the
 * most reassuring possible way to display "we have no idea". A check that
 * could not be read is said so, and is never the ground for "everything".
 */
export function bandSummary(items: Attention[], loading: boolean): BandSummary {
  const live = items.filter((i) => (i.count ?? 0) > 0);
  const unknown = items.filter((i) => i.count === null).length;
  const total = live.reduce((n, i) => n + (i.count ?? 0), 0);
  const checks = `${unknown} check${unknown === 1 ? "" : "s"} could not be read`;
  if (loading) return { state: "loading", total, unknown, text: "Checking the platform…" };
  if (live.length === 0 && unknown === 0) {
    return { state: "ok", total, unknown, text: "Everything is running" };
  }
  if (live.length === 0) {
    return {
      state: "unknown",
      total,
      unknown,
      text: `Nothing failing among what could be checked — ${checks}`,
    };
  }
  const needs = `${total} thing${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`;
  return {
    state: "attention",
    total,
    unknown,
    text: unknown > 0 ? `${needs} · ${checks}` : needs,
  };
}
