// A save that lands only on the version it was made from (sweep 9).
//
// An editor that writes its whole document wrote it over whatever was stored,
// so of two tabs on one notebook the later save silently undid the earlier
// one, while the first tab still said "Saved" (R283). A row whose trigger
// moves `updated_at` on every write already carries a version: the update is
// filtered on the `updated_at` this page read or last wrote, and returns the
// new one. A newer write from elsewhere leaves nothing to update, and the save
// says so instead of writing over it.

/** What one guarded save came to. */
export type GuardedSave =
  { ok: true; version: string } | { ok: false; stale: boolean; error: string };

/**
 * Reads the reply to `update(...).eq("updated_at", version).select("updated_at")`.
 * No row back means the row moved on since `version`: stale, not saved.
 */
export function readGuardedSave(
  res: { data: { updated_at: string }[] | null; error: { message: string } | null },
  what: string,
): GuardedSave {
  if (res.error) return { ok: false, stale: false, error: res.error.message };
  const row = res.data?.[0];
  if (!row) {
    return {
      ok: false,
      stale: true,
      error: `${what} was changed in another tab or session after this page read it`,
    };
  }
  return { ok: true, version: row.updated_at };
}

/**
 * Runs saves one at a time, in the order they were asked for. Two saves from
 * the same page in flight together would each carry the version read before
 * either landed, and the second would take the first for someone else's.
 */
export function makeSaveQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    // Runs after the last one whether that landed or threw.
    const next = tail.then(run, run);
    tail = next;
    return next;
  };
}
