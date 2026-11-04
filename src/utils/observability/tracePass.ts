// The counts of the passes that seal model call traces kept before R448 and swarm
// run traces kept before R449, as the
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

export type RunPass = {
  runs: number;
  steps: number;
  /** The links between steps, with what passed along them. */
  edges: number;
  /** The saved state of runs still going or parked. */
  checkpoints: number;
  /** Rows whose owner's key cannot be had now: left as they are. */
  unreadable: number;
  /** Rows that would have been sealed past the pass's limit. */
  left: boolean;
  failed: number;
  errors: string[];
};

/** The pass's counts, for the stored-files pass's audit detail (one row for all of them). */
export function runPassDetail(p: RunPass): Record<string, unknown> {
  return {
    ...(p.runs ? { swarm_runs_sealed: p.runs } : {}),
    ...(p.steps ? { run_steps_sealed: p.steps } : {}),
    ...(p.edges ? { run_links_sealed: p.edges } : {}),
    ...(p.checkpoints ? { run_checkpoints_sealed: p.checkpoints } : {}),
    ...(p.unreadable ? { runs_unreadable: p.unreadable } : {}),
    ...(p.left ? { runs_left: true } : {}),
    ...(p.failed ? { runs_failed: p.failed } : {}),
    ...(p.errors.length ? { runs_errors: p.errors } : {}),
  };
}

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
