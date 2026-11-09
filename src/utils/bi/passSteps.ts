// The step guard every step of the scheduler pass runs through (runCronPass,
// refresh.server.ts).
//
// Two rules, both older than this file, now in one place:
//
// - A failed step is FOLDED, never fatal: one sweep must not stop the others.
//   It is also recorded, not only warned about. MEASURED (R57): /api/bi/cron
//   answered { ok: true, processed: 0, … } over a pass whose schedule read had
//   failed, and nothing anywhere said so.
// - (R463) Once the lease is lost (another runner may be doing this work now)
//   or SIGTERM has arrived (the process is about to stop), no further step
//   STARTS. A step already running finishes; the ones not reached are named in
//   the pass's errors and wait for the next pass.

export type PassSteps = {
  /** Run one named step, or skip it once the pass has stopped. */
  step<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T>;
  /** Every recorded failure, plus (after finish()) why the pass stopped early. */
  errors: string[];
  /** Record the early stop, if any. Call once, after the last step. */
  finish(): string[];
};

export function createPassSteps(opts: {
  /** True once this runner may no longer be the only one. */
  lost: () => boolean;
  /** True once the process has received SIGTERM. */
  draining: () => boolean;
  warn?: (message: string, detail?: string) => void;
}): PassSteps {
  const warn = opts.warn ?? ((m, d) => console.warn(m, ...(d === undefined ? [] : [d])));
  const errors: string[] = [];
  const skipped: string[] = [];
  let stoppedBecause: string | null = null;

  const fold = <T>(step: string, e: unknown, value: T): T => {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`[${step}] failed:`, msg);
    errors.push(`${step}: ${msg}`);
    return value;
  };

  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    stoppedBecause ??= opts.lost()
      ? "the scheduler lease passed to another runner"
      : opts.draining()
        ? "this process is shutting down"
        : null;
    if (stoppedBecause) {
      skipped.push(name);
      return fallback;
    }
    try {
      return await fn();
    } catch (e) {
      return fold(name, e, fallback);
    }
  };

  const finish = () => {
    if (stoppedBecause) {
      const msg = `stopped early because ${stoppedBecause}; ${skipped.length} step(s) left for the next pass: ${skipped.join(", ")}`;
      warn(`[scheduler] ${msg}`);
      errors.push(`scheduler: ${msg}`);
    }
    return errors;
  };

  return { step, errors, finish };
}
