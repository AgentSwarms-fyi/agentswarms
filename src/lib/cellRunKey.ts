import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/**
 * Shift+Enter in a notebook cell's editor: run the cell, and nothing else.
 *
 * FOUND IN R213: the notebook listened for Shift+Enter on a wrapper around
 * the editor. CodeMirror's standard keymap binds Shift-Enter to "insert a
 * newline", and it handles the key in the editor before the event reaches a
 * wrapper, so every Shift+Enter ran the cell AND added a blank line to it,
 * which autosave then kept. Bound here, in the editor's own keymap at the
 * highest precedence, the run is the binding that handles the key.
 */
export function cellRunKey(run: () => void) {
  return Prec.highest(
    keymap.of([
      {
        key: "Shift-Enter",
        run: () => {
          run();
          return true;
        },
      },
    ]),
  );
}
