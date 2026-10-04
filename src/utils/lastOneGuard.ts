// Keeping the last one of something, when two requests arrive at once.
//
// FOUND IN R246. Two guards in this codebase had the same shape:
//
//   const { count } = await sb.from(T).select("id", { count: "exact", head: true })…;
//   if ((count ?? 0) <= 1) return { ok: false, error: "…keeps at least one…" };
//   await sb.from(T).delete().eq("id", id);
//
// The count and the delete are two round trips. Two requests that arrive
// together both read 2, both pass the guard, and both delete. The thing the
// guard exists to protect is gone, and each caller was told it worked.
//
// Measured, not argued. Two browser tabs, each holding the real confirmation
// dialog over a different sheet of a two-sheet workbook, both confirms fired
// at the same millisecond. The workbook was left with no sheets and will not
// open again: the editor sits on "Opening…" forever, and the control that
// could add a sheet back is inside the editor that never renders.
//
// There is no transaction to reach for: these run over PostgREST, a statement
// per request. What there is instead is an order that cannot lie. A count
// taken BEFORE the write describes a past the write may have changed. A count
// taken AFTER the write describes the present. So write, then look, and put
// the row back if looking says you are the one who emptied it.
//
// That is only safe because these rows carry their own data — a sheet tab's
// cells live in its own `grid` column, a superadmin role is the pair
// (user_id, role) — so the row read before the delete restores it whole. A
// row whose children cascade would need a different answer, and this helper
// is the wrong tool for it.
//
// Every interleaving: a request restores only if it sees zero after its own
// delete, and nothing deletes after a restore. The last request to count
// therefore sees either a row somebody else restored, or zero — and then
// restores. Two racers can both restore, which puts both rows back and tells
// both callers the delete did not happen. Nothing is lost, and the count
// never settles at zero.
//
// What this does NOT do is hold the invariant at every instant. Between the
// second delete and the restore that follows it the table is briefly empty,
// and a third request reading in that window sees zero. That window is why
// the other half of R246 exists: a workbook with no sheets now says so and
// offers to add one, instead of sitting on "Opening…" forever. Settling at
// zero was the unrecoverable failure; passing through zero is survivable, and
// only honestly so because the reader was taught to survive it.

/** What a caller must be able to do for its guard to be un-raceable. */
export type LastOneOps<Row> = {
  /** The row about to go, read whole, so it can be put back. */
  read: () => Promise<Row | null>;
  /** Remove it. Resolves false if there was no row to remove. */
  remove: () => Promise<boolean>;
  /** How many are left, counted after the removal. */
  countRemaining: () => Promise<number>;
  /** Put the row back exactly as it was. */
  restore: (row: Row) => Promise<void>;
};

/** What to say, in the caller's own words about its own subject. */
export type LastOneWords = {
  /** The delete would have taken the last one: "A workbook keeps at least one sheet". */
  refusal: string;
  /** There was no such row: "This sheet no longer exists". */
  missing: string;
};

export type LastOneResult = { ok: true } | { ok: false; error: string };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Delete one row while keeping at least one, safely against a request that is
 * deleting a different one at the same moment.
 *
 * Throws only when the invariant is broken AND could not be repaired — the one
 * outcome a caller must not report as an ordinary refusal.
 */
export async function deleteKeepingAtLeastOne<Row>(
  ops: LastOneOps<Row>,
  words: LastOneWords,
): Promise<LastOneResult> {
  const row = await ops.read();
  if (row === null) return { ok: false, error: words.missing };

  if (!(await ops.remove())) return { ok: false, error: words.missing };

  let left: number;
  try {
    left = await ops.countRemaining();
  } catch (e) {
    // We cannot tell whether we just took the last one, so assume we did.
    // Deleting again is one more click; a workbook that will not open is not
    // recoverable from the UI at all.
    await putBack(ops, row, `${words.refusal} (the remaining ones could not be counted)`);
    return {
      ok: false,
      error: `It was put back: the remaining ones could not be counted, so it was not safe to let this be the last one. ${message(e)}`,
    };
  }

  if (left > 0) return { ok: true };

  await putBack(ops, row, words.refusal);
  return { ok: false, error: words.refusal };
}

/** Restore, or say plainly that the invariant is broken and we could not fix it. */
async function putBack<Row>(ops: LastOneOps<Row>, row: Row, why: string): Promise<void> {
  try {
    await ops.restore(row);
  } catch (e) {
    throw new Error(`${why} — and putting it back failed, so nothing is left: ${message(e)}`);
  }
}
