// Put text where a field's cursor is (R495).
//
// The insert menus (components/templates/TemplateInsert.tsx) put a picked
// reference into a text field at the cursor rather than at the end, so it lands
// mid-sentence where it is wanted. Kept apart from the components so the
// component file exports components only (fast refresh).
import { useEffect, useRef, type RefObject } from "react";

export type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * `value` with `text` put where the field's cursor is (replacing a selection),
 * and where the cursor goes after it. With no field, at the end.
 */
export function insertAtCaret(
  el: Pick<TextField, "selectionStart" | "selectionEnd"> | null,
  value: string,
  text: string,
): { value: string; caret: number } {
  const at = Math.min(el?.selectionStart ?? value.length, value.length);
  const to = Math.min(Math.max(el?.selectionEnd ?? at, at), value.length);
  return { value: value.slice(0, at) + text + value.slice(to), caret: at + text.length };
}

/**
 * An insert function for one field: puts the text at its cursor, then gives the
 * field focus back with the cursor after what was inserted, so typing carries on.
 *
 * FOUND IN THE UI TEST. A field nobody has clicked into still reports a cursor
 * — at 0 — so picking from the menu first put the reference BEFORE the text
 * already there. Until the field has had focus, the pick goes at the end; once
 * it has, the browser keeps its cursor through the menu, and that is used.
 */
export function useInsertAtCaret<T extends TextField>(
  value: string,
  onChange: (next: string) => void,
): { ref: RefObject<T | null>; insert: (text: string) => void } {
  const ref = useRef<T | null>(null);
  const touched = useRef(false);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (e.target && e.target === ref.current) touched.current = true;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  const insert = (text: string) => {
    const el = ref.current;
    const next = insertAtCaret(touched.current ? el : null, value, text);
    onChange(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };
  return { ref, insert };
}
