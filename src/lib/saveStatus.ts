/** What the last auto-save did: nothing yet, landed, or failed and why. */
export type SaveState = { ok: true; at: Date } | { ok: false; error: string; at: Date } | null;

/**
 * The words a settings page may use for its auto-save.
 *
 * FOUND FROM THE UI. The Budgets page saved every change optimistically,
 * dropped the write's error, and had a button that toasted "All settings
 * auto-saved" on every click — so a monthly cap whose save was rejected read
 * "$1.79 / $25.00" until a reload put the old $20.00 back (R66). The status
 * is derived from what the last write actually did, and a failure names
 * itself.
 */
export function saveStatusText(state: SaveState): string {
  if (state === null) return "Settings auto-save on change";
  const when = state.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return state.ok ? `Saved ${when}` : `Not saved — ${state.error}`;
}
