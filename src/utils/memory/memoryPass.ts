// The counts of a pass that seals what agents kept before R445 (memory items,
// conversation summaries, scratchpads), as the stored-files pass's audit row
// and the Customer keys card carry them. Pure: the card uses it too.

export type MemoryPass = {
  /** Long-term memory items sealed now. */
  items: number;
  summaries: number;
  scratchpads: number;
  /** Values whose owner's key cannot be had now (refused, a conflict): left as they are. */
  unreadable: number;
  /** Values that would have been sealed past the pass's limit. */
  left: boolean;
  failed: number;
  errors: string[];
};

/** The pass's counts, for the stored-files pass's audit detail (one row for both). */
export function memoryPassDetail(m: MemoryPass): Record<string, unknown> {
  return {
    ...(m.items ? { memory_items_sealed: m.items } : {}),
    ...(m.summaries ? { summaries_sealed: m.summaries } : {}),
    ...(m.scratchpads ? { scratchpads_sealed: m.scratchpads } : {}),
    ...(m.unreadable ? { memory_unreadable: m.unreadable } : {}),
    ...(m.left ? { memory_left: true } : {}),
    ...(m.failed ? { memory_failed: m.failed } : {}),
    ...(m.errors.length ? { memory_errors: m.errors } : {}),
  };
}
