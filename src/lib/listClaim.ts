// What a list UI is entitled to claim about a read it may not have completed.
//
// The pattern this exists to stop: destructure only `data`, get null on
// failure, render `data ?? []`, and let the empty state speak. The page then
// says "you have none" whenever the truth is "we could not find out" — and
// those are the two readings a user cannot tell apart from the screen.
//
// MEASURED on /notebooks: a 403 on the list query produced a sidebar badge of
// 0 and "No notebooks yet — create one to start experimenting." for an account
// holding three notebooks, with no error text anywhere on the page.
//
// See also lib/kernelPanelState, which applies the same rule to the running
// kernels panel with its own visibility question attached.

export type ListClaimInput = {
  /** The read has returned, one way or the other. */
  loaded: boolean;
  /** Why the read failed, or null if it succeeded. */
  error: string | null;
  /** How many rows are currently held. */
  count: number;
};

export type ListClaim = {
  /** What to print in a count badge. Never a number the read did not support. */
  countLabel: string;
  /**
   * Which explanation the list should carry.
   * - "none"  — say nothing; either still loading, or there are rows to show
   * - "empty" — the read succeeded and there genuinely are none
   * - "error" — the read failed; the count and the emptiness are both unknown
   */
  message: "none" | "empty" | "error";
};

/** Printed instead of a count when no count can honestly be claimed. */
export const UNKNOWN_COUNT = "—";

export function listClaim(input: ListClaimInput): ListClaim {
  // A failed read outranks everything below: whatever is held is at best
  // stale, and its length is not an answer to "how many do I have".
  if (input.error) return { countLabel: UNKNOWN_COUNT, message: "error" };

  // Nothing has come back yet. A zero here is the absence of an answer, not
  // an answer of zero.
  if (!input.loaded) return { countLabel: UNKNOWN_COUNT, message: "none" };

  // The read succeeded, so both the count and the emptiness are facts.
  if (input.count === 0) return { countLabel: "0", message: "empty" };

  return { countLabel: String(input.count), message: "none" };
}

/**
 * May a debounced autosave write the editor's current state back?
 *
 * The rule is one-directional and worth stating on its own: an editor that
 * never successfully LOADED holds no version of the document, so anything it
 * writes is an erasure rather than an edit. When the notebook read fails the
 * page shows "It has not been deleted; nothing was saved over it" — VERIFIED
 * live by failing the read, waiting past the 1200ms debounce and re-reading
 * all three notebook rows byte-for-byte, with zero writes attempted.
 *
 * That promise is only as good as this guard, and the guard is easy to weaken
 * by accident: default `cells` to [] instead of null during a refactor and a
 * failed load quietly saves an empty notebook over a real one.
 */
export function mayAutosave(state: {
  /** A load has completed successfully and populated the editor. */
  hydrated: boolean;
  /** The editor's current content, or null when it holds none. */
  cells: unknown[] | null;
}): boolean {
  return state.hydrated && state.cells !== null;
}
