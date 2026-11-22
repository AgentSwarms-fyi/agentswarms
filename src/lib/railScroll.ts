// Keeping a row of a scrolling rail in view.
//
// The arithmetic is here, away from the component, because it is the part that
// can be wrong in a way nobody sees: a sign flipped scrolls the rail away from
// the row instead of toward it, and only on a screen short enough to scroll.

export type Edges = { top: number; bottom: number };

/**
 * How far a scrolling rail has to move for `row` to sit wholly inside it, with
 * `margin` to spare. Negative scrolls up, positive scrolls down, and 0 means
 * the row is already in view and nothing should move: a rail that re-centres
 * itself on every click is a rail that jumps under the pointer.
 */
export function revealDelta(rail: Edges, row: Edges, margin = 8): number {
  if (row.top < rail.top + margin) return row.top - rail.top - margin;
  if (row.bottom > rail.bottom - margin) return row.bottom - rail.bottom + margin;
  return 0;
}
