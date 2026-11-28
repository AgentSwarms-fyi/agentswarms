// How far a numbered list in rendered markdown is indented: far enough for its
// widest number.
//
// A list's numbers are drawn in the space to the left of its items, and that
// space was fixed (1.25rem): room for "9." and no more. Once lists kept the
// number they start at, an answer of "10." drew its "1" past the edge of the
// message, where it was cut off, so the chat said "0." (and "2." for "12.").
// Lists that run to 10 items had the same cut, unseen while everything
// started at 1 and few answers ran that long.
import { Children, isValidElement, type ReactNode } from "react";

/** The list's last number: where it starts, plus its items after the first. */
export function lastListNumber(start: number | undefined, items: ReactNode): number {
  const count = Children.toArray(items).filter(isValidElement).length;
  return (start ?? 1) + Math.max(count, 1) - 1;
}

/**
 * The left margin a numbered list needs, or undefined when the usual 1.25rem
 * holds its numbers (one digit). Each number is its digits and a full stop,
 * in the list's own font: `ch` is the width of a digit in it.
 */
export function numberedListIndent(last: number): string | undefined {
  const digits = String(Math.max(0, Math.trunc(last))).length;
  return digits <= 1 ? undefined : `calc(${digits + 1}ch + 0.5rem)`;
}
