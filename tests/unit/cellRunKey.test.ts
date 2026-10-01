// Shift+Enter in a Python notebook cell runs the cell and adds nothing to it.
//
// FOUND IN R213: the notebook listened for Shift+Enter on a wrapper around
// the editor, and CodeMirror's standard keymap binds Shift-Enter to "insert a
// newline". In the fixture notebook "r213 double run", every Shift+Enter ran
// the cell and also added a blank line to it, which autosave kept. These tests
// drive CodeMirror's own keymap dispatch with its real standard keymap.
import { standardKeymap } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap, runScopeHandlers, type EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { cellRunKey } from "@/lib/cellRunKey";

const SOURCE = "print(1)";

/** Press a key in an editor holding SOURCE, cursor at the end. */
function press(extensions: Extension[], key: { shiftKey: boolean }) {
  let state = EditorState.create({ doc: SOURCE, selection: { anchor: SOURCE.length }, extensions });
  // runScopeHandlers reads the state and hands the view to the command; the
  // commands here read `state` and call `dispatch`, which is all a view is
  // to them.
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: { state: EditorState }) {
      state = tr.state;
    },
  } as unknown as EditorView;
  const event = {
    type: "keydown",
    key: "Enter",
    keyCode: 13,
    shiftKey: key.shiftKey,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  } as KeyboardEvent;
  const handled = runScopeHandlers(view, event, "editor");
  return { handled, doc: state.doc.toString() };
}

describe("Shift+Enter in a notebook cell", () => {
  it("is, by CodeMirror's standard keymap alone, a newline (the R213 blank line)", () => {
    const { handled, doc } = press([keymap.of(standardKeymap)], { shiftKey: true });
    expect(handled).toBe(true);
    expect(doc).toBe(`${SOURCE}\n`);
  });

  it("runs the cell once and leaves its source as it was", () => {
    let runs = 0;
    const { handled, doc } = press([cellRunKey(() => (runs += 1)), keymap.of(standardKeymap)], {
      shiftKey: true,
    });
    expect(handled).toBe(true);
    expect(runs).toBe(1);
    expect(doc).toBe(SOURCE);
  });

  it("wins even when the editor's own keymap is listed first", () => {
    let runs = 0;
    const { doc } = press([keymap.of(standardKeymap), cellRunKey(() => (runs += 1))], {
      shiftKey: true,
    });
    expect(runs).toBe(1);
    expect(doc).toBe(SOURCE);
  });

  it("leaves a plain Enter to the editor: a newline, no run", () => {
    let runs = 0;
    const { doc } = press([cellRunKey(() => (runs += 1)), keymap.of(standardKeymap)], {
      shiftKey: false,
    });
    expect(runs).toBe(0);
    expect(doc).toBe(`${SOURCE}\n`);
  });
});
