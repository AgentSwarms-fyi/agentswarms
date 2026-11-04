// The counts of a pass that seals model call traces kept before R448, as the
// stored-files pass's audit row and the Customer keys card carry them. Pure:
// the card uses it too.

export type TracePass = {
  traces: number;
  /** Traces whose owner's key cannot be had now: left as they are. */
  unreadable: number;
  /** Traces that would have been sealed past the pass's limit. */
  left: boolean;
  failed: number;
  errors: string[];
};

/** The pass's counts, for the stored-files pass's audit detail (one row for all of them). */
export function tracePassDetail(t: TracePass): Record<string, unknown> {
  return {
    ...(t.traces ? { traces_sealed: t.traces } : {}),
    ...(t.unreadable ? { traces_unreadable: t.unreadable } : {}),
    ...(t.left ? { traces_left: true } : {}),
    ...(t.failed ? { traces_failed: t.failed } : {}),
    ...(t.errors.length ? { traces_errors: t.errors } : {}),
  };
}
