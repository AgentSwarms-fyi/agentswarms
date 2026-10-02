// What the swarm canvas opens first, from the owner's list of swarms.
//
// FOUND IN R110. The canvas read that list, dropped the error, and took a
// failed read for an owner with no swarms: it created "My First Swarm" and
// opened it, whatever swarm had been asked for. Driven: Open on "R109 chat
// echo" with the list read refused gave four refused reads, a POST 201, and
// an empty canvas named "My First Swarm"; the gallery went from 18 swarms
// to 19. Nothing said the list had not been read.

export type InitialSwarm<R> =
  /** The list could not be read: open nothing, create nothing, say so. */
  | { kind: "failed"; error: string }
  /** Open this row. `requestedMissing`: another swarm was asked for and is not in the list. */
  | { kind: "open"; row: R; requestedMissing: boolean }
  /** The owner really has no swarms yet: make the first one. */
  | { kind: "create-first"; requestedMissing: boolean };

export function chooseInitialSwarm<R extends { id: string }>(args: {
  rows: R[] | null;
  error: { message: string } | null;
  requestedId?: string | null;
}): InitialSwarm<R> {
  if (args.error) return { kind: "failed", error: args.error.message };
  const rows = args.rows ?? [];
  const requested = args.requestedId ? rows.find((r) => r.id === args.requestedId) : undefined;
  if (requested) return { kind: "open", row: requested, requestedMissing: false };
  const requestedMissing = !!args.requestedId;
  if (rows.length > 0) return { kind: "open", row: rows[0], requestedMissing };
  return { kind: "create-first", requestedMissing };
}
