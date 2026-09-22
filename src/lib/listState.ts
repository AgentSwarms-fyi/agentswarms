export type ListState = "loading" | "error" | "empty" | "list";

/**
 * What a list surface may show, from what it knows.
 *
 * FOUND FROM THE UI. A list page that dropped its read's error had exactly
 * two states, "loading" and "here are the rows", so a read that failed was
 * an empty array and the page said "No agents yet" with a "New Agent" call
 * to action — over seven agents it could not read (R64). An error is its own
 * state, ahead of "empty" and ahead of "loading": a read that failed is not
 * still loading, and it is not nothing.
 */
export function listState(args: {
  loaded: boolean;
  error: string | null;
  count: number;
}): ListState {
  if (args.error) return "error";
  if (!args.loaded) return "loading";
  return args.count === 0 ? "empty" : "list";
}

/**
 * The count a tab or heading may show for a list in that state.
 *
 * FOUND FROM THE UI (R76). The Knowledge Bases page put `docs.length` on
 * its Documents tab, and `docs` was the previous base's list until the next
 * base's read landed — so the tab read "Documents (12)" over a base with
 * none, for the seven seconds its read spent failing and after it had. A
 * count is a claim about rows the page has read; while it has none it says
 * so, and when the read failed it says that.
 */
export function listCountLabel(state: ListState, count: number): string {
  if (state === "error") return "?";
  if (state === "loading") return "\u2026";
  return String(count);
}
