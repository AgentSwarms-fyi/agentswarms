// Make a non-interactive element operable, not just clickable.
//
// A <Card onClick> / <div onClick> / <li onClick> renders as a plain element:
// the mouse works, and nothing else does. It is not in the tab order, Enter and
// Space do nothing, and it never reaches the accessibility tree — a screen
// reader is not told it is a control, so it is not announced as one.
//
// This was not cosmetic. On /knowledge the knowledge-base picker is a Card, so
// SELECTING A KNOWLEDGE BASE — the only way to see its documents — was
// mouse-only. Reading that page's accessibility tree returned a single button
// for the whole screen. The same shape governed picking a semantic model, a
// saved conversation, an IAM user and a dashboard.
//
// WCAG 2.1 SC 2.1.1 (Keyboard) is Level A, and "can a keyboard-only user
// operate it" is a question enterprise procurement asks in writing.
//
// Returns the four props a real button would have had. Prefer an actual
// <button> when the element is genuinely a button; this exists for the cases
// where a card or a table row is the control and changing the element would
// mean rewriting the layout.
import type { KeyboardEvent } from "react";

export type ClickableProps = {
  role: "button";
  tabIndex: 0;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
};

/**
 * @param onActivate what a click already did
 * @param label optional accessible name, when the element's text is not enough
 */
export function clickable(
  onActivate: () => void,
  label?: string,
): ClickableProps & {
  "aria-label"?: string;
} {
  return {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      // Enter and Space are what a real button responds to. Space is also the
      // page-scroll key, so it must be prevented once it has activated — an
      // element that both selects and scrolls the page away from itself is
      // worse than one that does nothing.
      if (e.key !== "Enter" && e.key !== " ") return;
      // A key pressed inside a nested control (a delete button, an input) has
      // already been handled by that control; re-firing the card's action here
      // would select the row as a side effect of typing in it.
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onActivate();
    },
    ...(label ? { "aria-label": label } : {}),
  };
}
