import { useRef, useState } from "react";

/**
 * A function that runs once at a time, whichever path calls it.
 *
 * FOUND IN R211 (sweep 5, "a guard only the button honours"): the Lakehouse
 * editor's Run button was `disabled={running}`, but Ctrl+Enter in the editor
 * called the same run() with no such check. One INSERT and two quick
 * Ctrl+Enters wrote two rows. A disabled button guards one path; a flag the
 * function itself holds guards them all, and it is set at once, before any
 * render, so two key events in one tick cannot both pass it.
 */
export function singleFlight<A extends unknown[]>(
  call: (...args: A) => unknown,
): (...args: A) => Promise<void> {
  let busy = false;
  return async (...args: A) => {
    if (busy) return;
    busy = true;
    try {
      await call(...args);
    } finally {
      busy = false;
    }
  };
}

/**
 * singleFlight for a component's handler. The returned function is stable
 * and always calls the latest `fn`, so it reads current state.
 */
export function useSingleFlight<A extends unknown[]>(
  fn: (...args: A) => unknown,
): (...args: A) => Promise<void> {
  const latest = useRef(fn);
  latest.current = fn;
  const [guarded] = useState(() => singleFlight((...args: A) => latest.current(...args)));
  return guarded;
}
