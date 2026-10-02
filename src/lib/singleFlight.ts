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

/**
 * One run per key at a time, where a call for a key already in flight joins
 * that run and gets its result, instead of being dropped.
 *
 * FOUND IN R213: a Python notebook cell's Run button was disabled while the
 * cell ran, but Shift+Enter ran it again, so a double Shift+Enter executed it
 * twice on the kernel. And the kernel start had the same gap: a second run
 * during the start was handed the runtime before it had connected, and
 * answered "Server runtime not connected". Cells are keyed by id, so one
 * cell's run never blocks another's, and Run all reaching a cell already
 * running waits for that run's result.
 */
export function sharedFlight<A extends unknown[], R>(
  keyOf: (...args: A) => string,
  call: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const inFlight = new Map<string, Promise<R>>();
  return (...args: A) => {
    const key = keyOf(...args);
    const joined = inFlight.get(key);
    if (joined) return joined;
    // The async wrapper turns a synchronous throw into a rejection, so the
    // entry is always set before it can be cleared.
    const run = (async () => call(...args))();
    inFlight.set(key, run);
    const clear = () => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    };
    run.then(clear, clear);
    return run;
  };
}

/** sharedFlight for a component's handler, stable and calling the latest. */
export function useSharedFlight<A extends unknown[], R>(
  keyOf: (...args: A) => string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const latest = useRef({ keyOf, fn });
  latest.current = { keyOf, fn };
  const [guarded] = useState(() =>
    sharedFlight(
      (...args: A) => latest.current.keyOf(...args),
      (...args: A) => latest.current.fn(...args),
    ),
  );
  return guarded;
}
