// Auto-saved fields, written one at a time and newest last (R293).
//
// The Budgets page wrote every keystroke as its own request. Typing 2500 sent
// 2, 25, 250 and 2500 together; they came back 2, 2500, 250, 25, and the cap
// stored was $25 while the field said 2500 and the status said Saved. A failed
// write also put back the value from before ITS keystroke, over the newer ones
// still on screen.
//
// A writer keeps at most one write in flight. Edits made meanwhile are merged
// into one waiting patch and written when the flight lands, so the last edit
// is always the last write. Each outcome is reported with the patch still
// waiting, if any, so the caller undoes a failure only in the fields nothing
// newer is about to write.

/** One write's reply, in the shape supabase-js answers with. */
export type WriteReply<R> = { data?: R | null; error: { message: string } | null };

export type PatchWriter<P extends object> = {
  /** Queue `patch`. Resolves once nothing is left to write. */
  set(patch: P): Promise<void>;
};

export function makePatchWriter<P extends object, R = unknown>(
  write: (patch: P) => Promise<WriteReply<R>>,
  on: {
    saved(patch: P, data: R | null | undefined, newer: P | null): void;
    failed(patch: P, error: { message: string }, newer: P | null): void;
  },
): PatchWriter<P> {
  let waiting: P | null = null;
  let flight: Promise<void> | null = null;

  const drain = async () => {
    while (waiting) {
      const patch = waiting;
      waiting = null;
      let reply: WriteReply<R>;
      try {
        reply = await write(patch);
      } catch (e) {
        reply = { error: { message: e instanceof Error ? e.message : String(e) } };
      }
      if (reply.error) on.failed(patch, reply.error, waiting);
      else on.saved(patch, reply.data, waiting);
    }
    flight = null;
  };

  return {
    set(patch) {
      waiting = { ...(waiting ?? {}), ...patch } as P;
      flight ??= drain();
      return flight;
    },
  };
}

/** The fields of `patch` that `newer` does not write again. */
export function fieldsLeft<P extends object>(patch: P, newer: P | null): (keyof P)[] {
  return (Object.keys(patch) as (keyof P)[]).filter((k) => !newer || !(k in newer));
}

/**
 * The number a typed amount stands for, or null while it stands for none.
 * An emptied field is not 0: `Number("")` is 0, and a cap of 0 is read as no
 * cap at all, so clearing the field on the way to a new figure removed the cap.
 */
export function typedAmount(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
