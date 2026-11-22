// A page change must happen even when it cannot be animated.
//
// Route changes cross-fade through the browser's view transitions. A browser
// will not start one in a document nobody can see (a background tab, a
// minimised window): it aborts with "InvalidStateError: Transition was
// aborted because of invalid state. Document hidden" and rejects the promise
// the router waits on. The router then never commits the new page — the
// address changes and the old page stays. Found in R519's UI test: a link
// clicked as the tab went to the background left the reader on the page they
// had left, with the new address above it.
//
// So: animate when the document is visible, and otherwise change the page
// straight away. Nothing is lost — there is nobody to see the animation.

type Startable = { startViewTransition: (fn: () => Promise<void>) => Promise<void> };

/** Whether a page change may be animated now. */
export function canAnimatePageChange(doc: Pick<Document, "visibilityState"> | undefined): boolean {
  return !!doc && doc.visibilityState === "visible";
}

/** Wraps the router's transition so a hidden document changes page without one. */
export function guardViewTransitions<R extends Startable & { shouldViewTransition?: unknown }>(
  router: R,
  doc: () => Pick<Document, "visibilityState"> | undefined = () =>
    typeof document === "undefined" ? undefined : document,
): R {
  const animated = router.startViewTransition.bind(router);
  router.startViewTransition = (fn) => {
    if (canAnimatePageChange(doc())) return animated(fn);
    // The router clears its one-navigation override when it animates; do
    // the same, so it does not carry over to the next page change.
    router.shouldViewTransition = undefined;
    return fn();
  };
  return router;
}
