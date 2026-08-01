// Independent verification of the audit trail's hash chain.
//
// Each audit event carries sha256 over its own content plus the previous
// event's hash (migration 20260762000000). Editing or deleting a row breaks
// every link after it. The database can check this itself via
// audit_chain_verify(), but that is the weaker half of the guarantee: an
// attacker with service-role access can rewrite rows AND re-run the trigger, so
// a chain that only ever validates itself proves very little.
//
// The real property is that the NDJSON archive shipped off the box can be
// verified INDEPENDENTLY — outside the database, by a different implementation.
// Nothing could do that, which made the archive a copy of the data rather than
// evidence about it. This is that verifier.
//
// THE TRAP, and the reason this needs to be a shared module rather than a
// snippet in a runbook: the trigger hashes `detail::text`, which is Postgres's
// JSONB rendering, not JSON.stringify's. They differ in key ORDER and in
// SPACING, so the obvious implementation returns a different hash for every
// event and reports a perfectly intact trail as entirely tampered with. That
// was verified against real rows, not assumed.

import { createHash } from "node:crypto";

/** The fields the chain hashes, in the order the trigger concatenates them. */
export type ChainEvent = {
  chain_seq: number | string;
  chain_hash?: string | null;
  user_id?: string | null;
  action?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  resource_name?: string | null;
  detail?: unknown;
};

/**
 * Render a value the way Postgres renders `jsonb::text`.
 *
 * Two differences from JSON.stringify, both of which change the hash:
 *   - object keys are ordered by LENGTH first, then bytewise — not insertion
 *     order and not plain alphabetical
 *   - separators carry a space: `{"a": 1, "b": 2}`
 *
 * jsonb also drops duplicate keys and normalises numbers; neither can occur
 * here, because the value always arrives already parsed from jsonb.
 */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort(
      (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
    );
    const body = keys
      .map((k) => `${JSON.stringify(k)}: ${jsonbText((value as Record<string, unknown>)[k])}`)
      .join(", ");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** The genesis marker the trigger uses for the first link. */
export const GENESIS = "genesis";

/**
 * Recompute one event's hash. `prevHash` is null for the first link in the
 * range being verified.
 */
export function computeChainHash(prevHash: string | null, e: ChainEvent): string {
  const parts = [
    prevHash ?? GENESIS,
    String(e.chain_seq),
    e.user_id ?? "",
    e.action ?? "",
    e.resource_type ?? "",
    e.resource_id ?? "",
    e.resource_name ?? "",
    // `detail` defaults to {} in the trigger via COALESCE, not to null.
    e.detail === null || e.detail === undefined ? "{}" : jsonbText(e.detail),
  ];
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

export type ChainVerdict =
  | { ok: true; checked: number }
  | {
      ok: false;
      checked: number;
      firstBrokenSeq: number;
      reason: "hash-mismatch" | "sequence-gap" | "missing-hash";
    };

/**
 * Verify a run of events, ordered by chain_seq ascending.
 *
 * The FIRST event is not checked against a predecessor unless `genesis` is set:
 * retention deletes the oldest rows, so the earliest remaining event's
 * predecessor is legitimately gone. Every LINK after it must hold. Pass
 * `genesis: true` when verifying from the true start of the trail (an archive
 * that includes chain_seq 1), which additionally proves the head is original.
 */
export function verifyChain(events: ChainEvent[], opts: { genesis?: boolean } = {}): ChainVerdict {
  let prevHash: string | null = null;
  let prevSeq: number | null = null;
  let checked = 0;

  for (const e of events) {
    const seq = Number(e.chain_seq);
    checked++;

    if (!e.chain_hash) {
      return { ok: false, checked, firstBrokenSeq: seq, reason: "missing-hash" };
    }

    // A gap means a row was deleted from the middle of the trail.
    if (prevSeq !== null && seq !== prevSeq + 1) {
      return { ok: false, checked, firstBrokenSeq: seq, reason: "sequence-gap" };
    }

    const isFirst = prevSeq === null;
    if (!isFirst || opts.genesis) {
      const expected = computeChainHash(isFirst ? null : prevHash, e);
      if (expected !== e.chain_hash) {
        return { ok: false, checked, firstBrokenSeq: seq, reason: "hash-mismatch" };
      }
    }

    prevHash = e.chain_hash;
    prevSeq = seq;
  }

  return { ok: true, checked };
}
