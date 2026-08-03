// Deciding what a repeated Idempotency-Key means.
//
// Extracted from routes/api/swarm.run so the branch table can be tested without
// a database. The endpoint's promise is that "repeating a key returns the
// original result instead of re-running (and re-billing) the swarm", so every
// branch here is a billing decision.

export type IdempotencyRow = {
  status: "in_progress" | "completed" | "failed";
  request_hash: string;
  response: unknown;
  run_id: string | null;
};

export type IdempotencyVerdict =
  /** No prior record, or a failed one that may be retried — claim and run. */
  | { action: "claim" }
  /** Same key, same body, already finished — hand back what it returned. */
  | { action: "replay"; response: unknown }
  /** Same key, still running. */
  | { action: "in_progress"; runId: string | null }
  /** Same key, DIFFERENT body — a client bug, and the one case worth shouting about. */
  | { action: "mismatch" };

/**
 * What to do about an existing idempotency record.
 *
 * The mismatch check comes FIRST and applies to every status. A key reused with
 * a different body is a client bug, and answering it with the previous body's
 * result would be handing back an unrelated run's output — quietly, and looking
 * exactly like success.
 */
export function idempotencyVerdict(
  existing: IdempotencyRow | null | undefined,
  requestHash: string,
): IdempotencyVerdict {
  if (!existing) return { action: "claim" };
  if (existing.request_hash !== requestHash) return { action: "mismatch" };
  if (existing.status === "completed" && existing.response != null) {
    return { action: "replay", response: existing.response };
  }
  if (existing.status === "in_progress") {
    return { action: "in_progress", runId: existing.run_id };
  }
  // 'failed', or 'completed' with nothing stored — the run did not produce a
  // result anyone can be handed, so a retry is allowed to take it over.
  return { action: "claim" };
}
