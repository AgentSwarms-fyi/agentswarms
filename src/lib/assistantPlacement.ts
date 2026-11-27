// Where the open assistant sits on a desktop screen: beside the page, or over it.
//
// The assistant opens as a column beside the page, and the page gives up that
// column's width rather than being covered by it. On a wide screen that is
// right. On a laptop it is not: with the app's sidebar open, a 1366px-wide
// window left the page 730px, and a page with a side panel of its own (the
// swarm canvas and its node inspector) was squeezed to a strip.
//
// So the page gives up the width only while it keeps enough of its own. When
// it would not, the assistant floats over the page's right edge instead, as it
// already covers the page on a phone, and the page keeps its full width.

/** The assistant's width, beside the page or over it (its `w-[380px]`). */
export const ASSISTANT_PANEL_WIDTH = 380;

/** The narrowest the page may be left beside the open assistant. */
export const MIN_PAGE_WIDTH_BESIDE_ASSISTANT = 960;

export type AssistantPlacement = "beside" | "over";

/**
 * `room` is the width the page and the assistant share: the area right of the
 * app's sidebar. It does not change when the assistant opens, closes or moves
 * between the two placements, so measuring it cannot make the panel flicker
 * between them.
 */
export function assistantPlacement(room: number): AssistantPlacement {
  return room - ASSISTANT_PANEL_WIDTH >= MIN_PAGE_WIDTH_BESIDE_ASSISTANT ? "beside" : "over";
}
