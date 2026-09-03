// Replay: run a decision's recorded data reads again and say, in plain terms,
// whether the answer's ground has moved.
//
// A passport records what happened. Replay is the check that the record is
// worth anything, and it answers two different questions that are easy to
// confuse:
//
//   IS THE RECORD FAITHFUL? Re-run the query against the snapshot that was in
//   force when the answer was given. The lake at a snapshot is immutable, so
//   this must reproduce the result fingerprint stored on the audit row at the
//   time. If it does not, the record and the data disagree and the passport
//   should not be trusted.
//
//   DOES THE ANSWER STILL HOLD? Re-run the same query against the data as it
//   is now. A difference here is not a fault -- it is the world moving on --
//   but it is exactly what someone re-reading a six-month-old answer needs to
//   know before acting on it.
//
// The distinction matters because only the first is a check on us. Collapsing
// them into one "replay succeeded" verdict would hide a real integrity failure
// behind an ordinary data update.
//
// WHAT IS NOT REPLAYABLE IS SAID SO, SPECIFICALLY. A read with no recorded
// query, or one that went to a store with no snapshot history, returns a
// reason rather than being quietly dropped -- an examiner counting reads must
// see the ones this cannot check.
import { auditEvent } from "@/utils/audit.server";
import { runLakehouseStatement } from "@/utils/lakehouse/core.server";

import { isDataRead } from "./actions";
import { isComparableDigest, resultDigest } from "./canonical";
import { getDecisionChain, type DecisionEvent } from "./decision.server";

/** One re-run, against one point in time. */
export type ReplayRun = {
  /** Fingerprint of what the query returns now, at this point in time. */
  digest: string | null;
  /**
   * Whether that matches the fingerprint recorded when the answer was given.
   * Null means the comparison could not be made — no recorded fingerprint, an
   * unreadable one, an error, or a query that does not answer the same way
   * twice. Never guess `false` for any of those.
   */
  matchesRecord: boolean | null;
  /**
   * The same query, run twice against the SAME immutable snapshot, returned
   * two different results — so the query is not deterministic and nothing can
   * be concluded from comparing it to anything.
   */
  nondeterministic?: boolean;
  rowCount: number | null;
  durationMs: number | null;
  error: string | null;
};

export type ReplayRead = {
  eventId: string;
  action: string;
  resource: string | null;
  sql: string | null;
  recordedDigest: string | null;
  recordedRowCount: number | null;
  /** Against the snapshot in force when the answer was given. */
  asOf: ReplayRun | null;
  /** Against the data as it is today. */
  current: ReplayRun | null;
  /** Why this read could not be re-run, when it could not. */
  reason: string | null;
};

export type ReplayResult = {
  decisionId: string;
  snapshot: string | null;
  reads: ReplayRead[];
  summary: {
    /** Reads that were actually re-run. */
    replayed: number;
    /** Re-running as of the original snapshot reproduced the recorded result. */
    faithful: number;
    /** The record and the historical data disagree — the serious case. */
    unfaithful: number;
    /** Same query, different answer today. Not a fault; worth knowing. */
    movedSince: number;
    /** The query does not answer the same way twice, so it proves nothing. */
    nondeterministic: number;
    notReplayable: number;
  };
};

function detailOf(e: DecisionEvent): Record<string, unknown> {
  return (e.detail ?? {}) as Record<string, unknown>;
}

function str(d: Record<string, unknown>, k: string): string | null {
  return typeof d[k] === "string" ? (d[k] as string) : null;
}

/**
 * Can this read be re-run against a point in time?
 *
 * Only the lakehouse keeps snapshot history. A read of an external Postgres or
 * of an uploaded dataset can be re-run, but there is no "as it was" to run it
 * against, so a difference would be uninterpretable — it could equally be the
 * data changing or the record being wrong, which is precisely the ambiguity
 * replay exists to remove. Those are reported as not replayable, with the
 * reason, rather than half-checked.
 */
export function replayability(e: DecisionEvent): {
  sql: string | null;
  /**
   * `time-travel` — the store can be read as it was, so the record itself can
   * be checked. `current-only` — the query can be re-run against today's data,
   * which answers whether the answer still holds but cannot verify the record.
   * `null` — nothing can be run at all.
   */
  mode: "time-travel" | "current-only" | null;
  reason: string | null;
} {
  const d = detailOf(e);
  const sql = str(d, "sql");
  if (!sql) {
    return {
      sql: null,
      mode: null,
      reason:
        "No query text was recorded for this read, so there is nothing to re-run. Reads made before query recording shipped are permanently in this state — nothing can backfill them.",
    };
  }
  const provider = str(d, "provider");
  if (e.action === "lakehouse.select" || provider === "lakehouse") {
    return { sql, mode: "time-travel", reason: null };
  }
  // An external warehouse can be re-queried, just not as it was. That answers
  // half the question honestly, and half is worth more than nothing: "does
  // this answer still hold?" is what someone acting on an old number needs.
  // What it cannot do is verify the record, and the reason says so rather than
  // letting a green tick imply it.
  if (e.action === "warehouse.query" && provider) {
    return {
      sql,
      mode: "current-only",
      reason: `${provider} keeps no snapshot history, so the record itself cannot be verified — only whether the data has changed since. A difference below may equally mean the data moved or the query is not deterministic; there is no unchanged snapshot to tell them apart.`,
    };
  }
  return {
    sql,
    mode: null,
    reason: `This read went to ${provider ?? e.action}, which this instance cannot re-run: there is no wired executor for it here, and guessing one would risk running the query somewhere it did not come from.`,
  };
}

/**
 * Re-run a read that went to an external warehouse, against today's data.
 *
 * Deliberately the SAME entry point the agent tool used, so the fingerprint is
 * computed over a result produced the same way. Ownership is enforced by the
 * loader's `ownerUserId` filter — documented as the security decision even when
 * the service-role client is passed — so a replay cannot reach a connection the
 * caller may not use, and a grant revoked since surfaces as an error rather
 * than a silent success.
 */
async function runCurrentOnWarehouse(
  userId: string,
  connectionName: string | null,
  sql: string,
  rowCap: number,
  recordedDigest: string | null,
): Promise<ReplayRun> {
  const started = Date.now();
  try {
    if (!connectionName) throw new Error("The read did not record which connection it used");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
    const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
    const conn = await loadWarehouseConnectionForUser(
      supabaseAdmin,
      { name: connectionName },
      userId,
    );
    const res = await executeWarehouseQuery(conn.config, sql, rowCap, { userId });
    const digest = resultDigest(
      res.columns.map((c) => c.name),
      res.rows,
    );
    return {
      digest,
      matchesRecord: isComparableDigest(recordedDigest) ? digest === recordedDigest : null,
      rowCount: res.row_count,
      durationMs: Date.now() - started,
      error: null,
    };
  } catch (e) {
    return {
      digest: null,
      matchesRecord: null,
      rowCount: null,
      durationMs: null,
      error: (e as Error).message.slice(0, 400),
    };
  }
}

async function runOnce(
  userId: string,
  sql: string,
  rowCap: number,
  recordedDigest: string | null,
  asOfSnapshot: string | null,
): Promise<ReplayRun> {
  try {
    const res = await runLakehouseStatement(userId, sql, {
      rowCap,
      // Never a cached result: a replay that returned a cached row would be
      // checking our cache rather than the data.
      useCache: false,
      auditVia: asOfSnapshot ? "replay-as-of" : "replay-current",
      asOfSnapshot,
    });
    const digest = resultDigest(
      res.columns.map((c) => c.name),
      res.rows,
    );
    // Unknown-format digests compare to nothing. Reporting one as a mismatch
    // would accuse the record of being wrong on the strength of a fingerprint
    // this build cannot even reproduce.
    let matchesRecord = isComparableDigest(recordedDigest) ? digest === recordedDigest : null;
    let nondeterministic: boolean | undefined;

    // FOUND FROM THE UI. `SELECT random()` replayed as "does NOT match the
    // record" — the tampering verdict — against a snapshot that cannot change.
    // The record was perfectly faithful; the query simply does not answer the
    // same way twice. Rather than guess which it is, MEASURE it: run the same
    // query against the same immutable snapshot again. Two runs that disagree
    // with each other prove the query is non-deterministic, and nothing can be
    // concluded about the record. Two runs that agree with each other but
    // differ from the record are a genuine disagreement.
    //
    // Only on a mismatch, and only against a pinned snapshot — the extra query
    // is the price of not making a false accusation, and it is never paid on
    // the happy path.
    if (matchesRecord === false && asOfSnapshot) {
      const again = await runLakehouseStatement(userId, sql, {
        rowCap,
        useCache: false,
        auditVia: "replay-determinism-check",
        asOfSnapshot,
      });
      const confirm = resultDigest(
        again.columns.map((c) => c.name),
        again.rows,
      );
      if (confirm !== digest) {
        nondeterministic = true;
        matchesRecord = null;
      }
    }

    return {
      digest,
      matchesRecord,
      nondeterministic,
      rowCount: res.row_count,
      durationMs: res.duration_ms,
      error: null,
    };
  } catch (e) {
    // An access error here is a real answer, not a crash: a grant revoked
    // since the decision means this reader can no longer see what the answer
    // saw, and that is worth stating plainly.
    return {
      digest: null,
      matchesRecord: null,
      rowCount: null,
      durationMs: null,
      error: (e as Error).message.slice(0, 400),
    };
  }
}

/**
 * Re-run one decision's data reads. Owner-scoped throughout: the chain is
 * loaded for this user, and each query runs under this user's own grants and
 * row policies, so replay can never read more than the caller may read.
 */
export async function replayDecision(
  userId: string,
  decisionId: string,
): Promise<ReplayResult | null> {
  const chain = await getDecisionChain(userId, decisionId);
  if (!chain) return null;
  const snapshot = chain.decision.lakehouse_snapshot_id;
  const reads: ReplayRead[] = [];

  for (const e of chain.events.filter((ev) => isDataRead(ev.action))) {
    const d = detailOf(e);
    const recordedDigest = str(d, "result_digest");
    const recordedRowCount = typeof d.row_count === "number" ? d.row_count : null;
    const { sql, mode, reason } = replayability(e);
    const base = {
      eventId: e.id,
      action: e.action,
      resource: e.resource_name,
      sql,
      recordedDigest,
      recordedRowCount,
    };
    if (mode === null) {
      reads.push({ ...base, asOf: null, current: null, reason });
      continue;
    }
    // Match the cap the read itself used, or the fingerprints would differ for
    // no reason but truncation.
    const rowCap = typeof d.row_cap === "number" ? d.row_cap : 200;
    if (mode === "current-only") {
      // No snapshot to read as-of, so there is no faithfulness verdict to give
      // and none is invented. `reason` already says what this can and cannot
      // establish.
      reads.push({
        ...base,
        asOf: null,
        current: await runCurrentOnWarehouse(
          userId,
          e.resource_name,
          sql as string,
          rowCap,
          recordedDigest,
        ),
        reason,
      });
      continue;
    }
    const current = await runOnce(userId, sql as string, rowCap, recordedDigest, null);
    const asOf =
      snapshot && !snapshot.startsWith("nosnap")
        ? await runOnce(userId, sql as string, rowCap, recordedDigest, snapshot)
        : null;
    // A query that does not answer the same way twice cannot be compared to
    // anything -- including today's data, where a difference would otherwise
    // read as "the world moved on" when it is only the query being itself.
    if (asOf?.nondeterministic && current) {
      current.matchesRecord = null;
      current.nondeterministic = true;
    }
    reads.push({
      ...base,
      asOf,
      current,
      reason: asOf?.nondeterministic
        ? "This query does not return the same result twice against the same unchanged snapshot, so nothing can be concluded by comparing it — check it by hand, or make it deterministic (an explicit ORDER BY, no random() or now())."
        : asOf
          ? null
          : "No lakehouse snapshot was recorded for this decision, so the read could only be run against today's data.",
    });
  }

  const summary = {
    replayed: reads.filter((r) => r.current !== null).length,
    faithful: reads.filter((r) => r.asOf?.matchesRecord === true).length,
    // Only a measured disagreement counts. A non-deterministic query is
    // excluded by construction: matchesRecord is null, not false.
    unfaithful: reads.filter((r) => r.asOf?.matchesRecord === false).length,
    movedSince: reads.filter((r) => r.current?.matchesRecord === false).length,
    nondeterministic: reads.filter((r) => r.asOf?.nondeterministic === true).length,
    notReplayable: reads.filter((r) => r.current === null).length,
  };

  // A replay is itself an event worth recording: it reads data, and someone
  // asking later who checked this answer, when, and what they found deserves an
  // answer. No decisionId: the check is ABOUT the decision, not part of it, and
  // stamping it would inflate the very read count it exists to verify.
  auditEvent({
    userId,
    action: "provenance.replay",
    resourceType: "decision",
    resourceName: decisionId,
    detail: { ...summary, snapshot },
  });

  return { decisionId, snapshot, reads, summary };
}
