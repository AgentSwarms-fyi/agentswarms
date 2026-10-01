import { useEffect, useRef } from "react";

/**
 * Run `reset` when `open` turns true, and at no other time.
 *
 * FOUND IN R215: the Semantic Layer's "Add metric to dashboard" dialog reset
 * its form in an effect keyed on `[open, userId, payload]`. The page builds
 * `payload` inline, so every render of the page handed the dialog a new
 * object, and every click inside the dialog re-rendered the page: a typed
 * title reverted, the BI project picked snapped back, and the list refetched.
 * A form should be filled when it opens. `reset` is read at that moment, so it
 * sees the props of the render that opened it.
 */
export function useResetOnOpen(open: boolean, reset: () => void): void {
  const latest = useRef(reset);
  latest.current = reset;
  useEffect(() => {
    if (open) latest.current();
  }, [open]);
}
