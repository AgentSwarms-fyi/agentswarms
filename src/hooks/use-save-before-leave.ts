// Leaving an editor that saves as it goes (sweep 8).
//
// Such an editor saves a moment after the last keystroke, on a timer the page
// clears when it unmounts. Leaving inside that moment, or after a save that
// failed, dropped the edit without a word: the page said "Unsaved changes" and
// then was gone (R279). While something is unsaved, a link first saves it and
// asks only when that save fails; closing the tab gets the browser's question,
// since nothing can be awaited there.

import { useBlocker } from "@tanstack/react-router";

import { confirmAsk } from "@/components/ui/confirm-dialog";

/**
 * Whether to stop a link: save first, and ask only when the save fails.
 * `ask` resolves true to leave anyway.
 */
export async function holdForSave(
  saveNow: () => Promise<string | null>,
  ask: (error: string) => Promise<boolean>,
): Promise<boolean> {
  let error: string | null;
  try {
    error = await saveNow();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (error === null) return false;
  return !(await ask(error));
}

export function useSaveBeforeLeave(opts: {
  /** Something the editor holds is not saved: a save is due, in flight or failed. */
  unsaved: boolean;
  /** Save what the editor holds now. Resolves null once saved, else why it was not. */
  saveNow: () => Promise<string | null>;
  /** The item's name as saved, for the question. */
  name: string;
  /** Set while the page reloads itself on purpose, so the tab does not ask. */
  reloading?: { current: boolean };
}) {
  const { unsaved, saveNow, name, reloading } = opts;
  useBlocker({
    shouldBlockFn: () =>
      holdForSave(saveNow, (error) =>
        confirmAsk({
          title: `Leave without saving "${name}"?`,
          body: `The latest changes could not be saved: ${error}. Leaving drops them.`,
          actionLabel: "Leave anyway",
        }),
      ),
    enableBeforeUnload: () => unsaved && !reloading?.current,
    disabled: !unsaved,
  });
}
