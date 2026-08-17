// What the "Running kernels" panel is entitled to say.
//
// The panel exists for one moment: you were refused a new kernel with "you
// already have the maximum of N", and you came to free a slot. In that moment
// the difference between "the runtime says you have none" and "the runtime did
// not answer" is the whole difference between a working page and a dead end —
// and they used to render identically, because a failed read set the list to
// `[]` and an empty list hid the panel entirely.
//
// Hiding it also hid the Refresh button, so the one screen that could have
// resolved the contradiction offered no way to retry.
//
// Pure, because the rule is worth stating once and testing directly: an empty
// list is a CLAIM, and only a runtime that answered is allowed to make it.

export type KernelPanelInput = {
  /** The server runtime feature is switched on for this deployment. */
  enabled: boolean;
  /** Sessions the runtime reported, or null if it has not answered yet. */
  sessions: unknown[] | null;
  /** Why the last read failed, or null if it succeeded. */
  error: string | null;
};

export type KernelPanelState = {
  /** Render the panel at all. */
  visible: boolean;
  /** The count, or null when no count can honestly be claimed. */
  liveCount: number | null;
  /** Show the "could not read" explanation. */
  showError: boolean;
};

export function kernelPanelState(input: KernelPanelInput): KernelPanelState {
  const hidden = { visible: false, liveCount: null, showError: false } as const;

  // The runtime is off for this deployment: there is nothing to be wrong about.
  if (!input.enabled) return hidden;

  // A FAILED READ KEEPS THE PANEL. Hiding it here is what made an unreachable
  // runtime indistinguishable from an idle one.
  if (input.error) {
    return { visible: true, liveCount: null, showError: true };
  }

  // Not answered yet, and no error — still loading. Nothing to assert.
  if (input.sessions === null) return hidden;

  // The runtime ANSWERED and said none. That is a fact, and the panel has
  // nothing to add.
  if (input.sessions.length === 0) return hidden;

  return { visible: true, liveCount: input.sessions.length, showError: false };
}
