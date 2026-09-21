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
