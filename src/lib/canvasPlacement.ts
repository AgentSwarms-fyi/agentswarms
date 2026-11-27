// Where a node added from the palette lands on the swarm canvas.
//
// A node clicked in from the palette was put at a random spot in a fixed area
// of the canvas's own coordinates (x 200-500, y 100-400), wherever the canvas
// had been panned or zoomed to. Once you had moved around a larger swarm, that
// area was usually off screen, so the node appeared out of sight and you had
// to scroll to find it. A node dragged in was placed by the pointer's distance
// from the canvas's corner, also ignoring pan and zoom, so it did not land
// where it was dropped either.
//
// Now a dropped node lands under the pointer, and a clicked one in the middle
// of what you can see; a few clicks in a row step down-right instead of
// stacking exactly on top of each other.

/** Half the size a new node is drawn at (at least 180px wide, about 80 tall). */
export const NEW_NODE_HALF = { x: 90, y: 40 };

/** How far each further click moves the next node, and how close counts as "on top". */
export const STACK_STEP = 32;

type Point = { x: number; y: number };

/** The top-left a new node gets so that its middle is at `center`. */
export function nodeCornerAt(center: Point): Point {
  return { x: center.x - NEW_NODE_HALF.x, y: center.y - NEW_NODE_HALF.y };
}

/**
 * The top-left for a node clicked in, centred on `center` (the middle of the
 * visible canvas, in canvas coordinates), moved a step down-right past each
 * node already at that spot. `taken` are the top-left corners of the nodes on
 * the canvas.
 */
export function clickedNodeCorner(center: Point, taken: readonly Point[]): Point {
  let spot = nodeCornerAt(center);
  const occupied = (p: Point) =>
    taken.some((t) => Math.abs(t.x - p.x) < STACK_STEP && Math.abs(t.y - p.y) < STACK_STEP);
  for (let i = 0; i < 50 && occupied(spot); i++) {
    spot = { x: spot.x + STACK_STEP, y: spot.y + STACK_STEP };
  }
  return spot;
}
