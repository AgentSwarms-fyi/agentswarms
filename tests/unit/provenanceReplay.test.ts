// Replay asks two questions that look like one, and the whole value of the
// feature is in keeping them apart:
//
//   IS THE RECORD FAITHFUL?  Re-run against the snapshot in force at the time.
//   The lake at a snapshot is immutable, so this MUST reproduce the digest
//   stored on the audit row. A mismatch means our record and the data disagree.
//
//   DOES THE ANSWER STILL HOLD?  Re-run against today's data. A mismatch here
//   is the world moving on, not a fault.
//
// Collapsing these into one "replay ok" would hide an integrity failure behind
// an ordinary data update, so every test below checks that they stay separate.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resultDigest } from "@/utils/provenance/canonical";

const ROWS_THEN = [
  ["north", 100],
  ["south", 90],
];
const ROWS_NOW = [
  ["north", 175],
  ["south", 90],
];
const COLS = ["region", "amount"];
const DIGEST_THEN = resultDigest(COLS, ROWS_THEN);

const chain = vi.fn();
const runStatement = vi.fn();
const audited = vi.fn();

vi.mock("@/utils/provenance/decision.server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDecisionChain: (...a: unknown[]) => chain(...a),
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  runLakehouseStatement: (...a: unknown[]) => runStatement(...a),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: (...a: unknown[]) => audited(...a) }));

const lakeRead = (detail: Record<string, unknown>) => ({
  id: "e1",
  action: "warehouse.query",
  resource_type: "warehouse",
  resource_name: "lake",
  detail,
  created_at: "2026-09-03T02:05:12.000Z",
});

function makeChain(events: unknown[], snapshot: string | null = "167") {
  return {
    decision: {
      id: "dd3a53e5-1111-4222-8333-444444444444",
      user_id: "u1",
      kind: "chat_turn",
      root_ref: null,
      lakehouse_snapshot_id: snapshot,
      created_at: "2026-09-03T02:05:15.000Z",
    },
    traces: [],
    events,
    reproducible: snapshot !== null,
  };
}

async function subject() {
  return import("@/utils/provenance/replay.server");
}

beforeEach(() => {
  chain.mockReset();
  runStatement.mockReset();
  audited.mockReset();
});

describe("the result fingerprint", () => {
  // FOUND FROM THE UI, and the reason the digest takes columns + rows rather
  // than "whatever the caller is holding". executeWarehouseQuery returns rows
  // as OBJECTS keyed by column name (toObjects); runLakehouseStatement returns
  // ARRAYS of cells. The tool recorded one shape and replay computed the other,
  // so every lakehouse read replayed as "does NOT match the record" — a false
  // accusation of tampering, on data nothing had touched.
  //
  // These mocks agree by construction, so only a test on the REAL function can
  // catch a disagreement between the two shapes.
  it("is the same whether rows arrive as objects or as arrays", async () => {
    const { resultDigest } = await import("@/utils/provenance/canonical");
    const cols = ["id", "region", "amount"];
    const asArrays = [
      [1, "north", 100],
      [2, "south", 90],
    ];
    const asObjects = [
      { id: 1, region: "north", amount: 100 },
      { id: 2, region: "south", amount: 90 },
    ];
    expect(resultDigest(cols, asObjects)).toBe(resultDigest(cols, asArrays));
  });

  it("still notices the data actually changing", async () => {
    // The guard above must not have been bought by making everything equal.
    const { resultDigest } = await import("@/utils/provenance/canonical");
    const cols = ["id", "amount"];
    expect(resultDigest(cols, [[1, 100]])).not.toBe(resultDigest(cols, [[1, 101]]));
    expect(resultDigest(cols, [[1, 100]])).not.toBe(
      resultDigest(cols, [
        [1, 100],
        [2, 5],
      ]),
    );
  });

  it("treats a column rename as a different answer", async () => {
    const { resultDigest } = await import("@/utils/provenance/canonical");
    expect(resultDigest(["region"], [["north"]])).not.toBe(resultDigest(["area"], [["north"]]));
  });

  it("stamps its format, so an old digest is unknown rather than a mismatch", async () => {
    const { resultDigest, isComparableDigest } = await import("@/utils/provenance/canonical");
    expect(resultDigest(["a"], [[1]])).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(isComparableDigest("abc123")).toBe(false);
    expect(isComparableDigest(null)).toBe(false);
    expect(isComparableDigest(resultDigest(["a"], [[1]]))).toBe(true);
  });
});

describe("what can be replayed", () => {
  it("refuses a read with no recorded query, and says why", async () => {
    // Reads from before query recording shipped are permanently in this state.
    // Saying so is the point: an examiner counting reads must see the ones we
    // cannot check, rather than finding them silently absent.
    const { replayability } = await subject();
    const r = replayability(lakeRead({ provider: "lakehouse" }) as never);
    expect(r.sql).toBeNull();
    expect(r.reason).toMatch(/nothing can backfill them/);
  });

  it("refuses a store with no snapshot history, and names it", async () => {
    const { replayability } = await subject();
    const r = replayability(lakeRead({ provider: "postgres", sql: "SELECT 1" }) as never);
    expect(r.reason).toContain("postgres");
    expect(r.reason).toMatch(/no snapshot history/);
    // The sql is still surfaced -- it is evidence even when unreplayable.
    expect(r.sql).toBe("SELECT 1");
  });

  it("accepts a lakehouse read", async () => {
    const { replayability } = await subject();
    expect(
      replayability(lakeRead({ provider: "lakehouse", sql: "SELECT 1" }) as never).reason,
    ).toBeNull();
  });
});

describe("the two questions", () => {
  it("separates 'the record is faithful' from 'the data has moved'", async () => {
    // The core case: as-of reproduces the record (we are honest), while today
    // returns something different (the world moved). Both are true at once and
    // must be reported as different things.
    runStatement.mockImplementation(async (_u, _s, opts) => ({
      rows: opts?.asOfSnapshot ? ROWS_THEN : ROWS_NOW,
      row_count: 2,
      duration_ms: 12,
      columns: COLS.map((name) => ({ name, type: "VARCHAR" })),
      truncated: false,
      kind: "select",
    }));
    chain.mockResolvedValue(
      makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1", result_digest: DIGEST_THEN })]),
    );
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.summary.faithful).toBe(1);
    expect(res!.summary.unfaithful).toBe(0);
    expect(res!.summary.movedSince).toBe(1);
    expect(res!.reads[0].asOf!.matchesRecord).toBe(true);
    expect(res!.reads[0].current!.matchesRecord).toBe(false);
  });

  it("flags the serious case: history no longer matches the record", async () => {
    // An immutable snapshot returning something other than what we recorded
    // means the record cannot be trusted. This must never be reported as a
    // mere data change.
    runStatement.mockResolvedValue({
      rows: ROWS_NOW,
      row_count: 2,
      duration_ms: 9,
      columns: COLS.map((name) => ({ name, type: "VARCHAR" })),
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(
      makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1", result_digest: DIGEST_THEN })]),
    );
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.summary.unfaithful).toBe(1);
    expect(res!.summary.faithful).toBe(0);
  });

  it("reads the past as of the snapshot, and the present without one", async () => {
    runStatement.mockResolvedValue({
      rows: ROWS_THEN,
      row_count: 2,
      duration_ms: 5,
      columns: [],
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1" })]));
    const { replayDecision } = await subject();
    await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    const asOf = runStatement.mock.calls.map((c) => c[2]?.asOfSnapshot);
    expect(asOf).toContain("167");
    expect(asOf).toContain(null);
    // A cached result would be checking our cache, not the data.
    for (const call of runStatement.mock.calls) expect(call[2]?.useCache).toBe(false);
  });

  it("measures non-determinism instead of blaming the record for it", async () => {
    // FOUND FROM THE UI. `SELECT random()` replayed as "does NOT match the
    // record" -- the tampering verdict -- against a snapshot that cannot
    // change. The record was faithful; the query just does not answer the same
    // way twice. So on a mismatch the as-of query is run AGAIN against the same
    // immutable snapshot: two runs disagreeing with each other prove the query,
    // not the record, is the problem.
    let n = 0;
    runStatement.mockImplementation(async () => ({
      rows: [[++n]],
      row_count: 1,
      duration_ms: 3,
      columns: [{ name: "r", type: "DOUBLE" }],
      truncated: false,
      kind: "select",
    }));
    chain.mockResolvedValue(
      makeChain([
        lakeRead({ provider: "lakehouse", sql: "SELECT random()", result_digest: DIGEST_THEN }),
      ]),
    );
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.reads[0].asOf!.nondeterministic).toBe(true);
    expect(res!.reads[0].asOf!.matchesRecord).toBeNull();
    expect(res!.summary.unfaithful).toBe(0);
    expect(res!.summary.nondeterministic).toBe(1);
    // Today's comparison is meaningless too, and must not read as "moved on".
    expect(res!.reads[0].current!.matchesRecord).toBeNull();
    expect(res!.summary.movedSince).toBe(0);
    expect(res!.reads[0].reason).toMatch(/does not return the same result twice/);
  });

  it("still calls a genuine disagreement what it is", async () => {
    // The determinism check must not become a blanket excuse. When the query IS
    // deterministic -- two runs agreeing with each other -- a difference from
    // the record is exactly the serious case this feature exists to surface.
    runStatement.mockResolvedValue({
      rows: ROWS_NOW,
      row_count: 2,
      duration_ms: 4,
      columns: COLS.map((name) => ({ name, type: "VARCHAR" })),
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(
      makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1", result_digest: DIGEST_THEN })]),
    );
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.reads[0].asOf!.nondeterministic).toBeUndefined();
    expect(res!.summary.unfaithful).toBe(1);
    expect(res!.summary.nondeterministic).toBe(0);
  });

  it("pays for the determinism check only when something mismatched", async () => {
    // Two queries per read on the happy path would double the cost of every
    // replay for nothing.
    runStatement.mockResolvedValue({
      rows: ROWS_THEN,
      row_count: 2,
      duration_ms: 4,
      columns: COLS.map((name) => ({ name, type: "VARCHAR" })),
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(
      makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1", result_digest: DIGEST_THEN })]),
    );
    const { replayDecision } = await subject();
    await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    // Exactly two: one current, one as-of. No confirmation run.
    expect(runStatement).toHaveBeenCalledTimes(2);
    expect(runStatement.mock.calls.some((c) => c[2]?.auditVia === "replay-determinism-check")).toBe(
      false,
    );
  });

  it("reports an unreadable fingerprint as unknown, not as tampering", async () => {
    // A digest format change would otherwise fire the loudest alarm this
    // system has on every historical read at once, for a reason that has
    // nothing to do with the data.
    runStatement.mockResolvedValue({
      rows: ROWS_THEN,
      row_count: 2,
      duration_ms: 5,
      columns: COLS.map((name) => ({ name, type: "VARCHAR" })),
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(
      makeChain([
        lakeRead({ provider: "lakehouse", sql: "SELECT 1", result_digest: "deadbeefdeadbeef" }),
      ]),
    );
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.reads[0].asOf!.matchesRecord).toBeNull();
    expect(res!.summary.unfaithful).toBe(0);
  });

  it("does not report a match when nothing was recorded to match against", async () => {
    // The vacuous pass. With no stored digest the honest answer is "unknown",
    // and reporting it as faithful would manufacture assurance from absence.
    runStatement.mockResolvedValue({
      rows: ROWS_THEN,
      row_count: 2,
      duration_ms: 5,
      columns: [],
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1" })]));
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.reads[0].asOf!.matchesRecord).toBeNull();
    expect(res!.summary.faithful).toBe(0);
    expect(res!.summary.unfaithful).toBe(0);
  });
});

describe("what it leaves alone", () => {
  it("replays data reads only, never the answer's own audit row", async () => {
    runStatement.mockResolvedValue({
      rows: [],
      row_count: 0,
      duration_ms: 1,
      columns: [],
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(
      makeChain([
        lakeRead({ provider: "lakehouse", sql: "SELECT 1" }),
        {
          id: "e2",
          action: "agent.chat",
          resource_type: "agent",
          resource_name: "a",
          detail: { sql: "SELECT 999" },
          created_at: "2026-09-03T02:05:15.000Z",
        },
      ]),
    );
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.reads).toHaveLength(1);
    expect(runStatement.mock.calls.every((c) => c[1] !== "SELECT 999")).toBe(true);
  });

  it("cannot check the past when no snapshot was recorded", async () => {
    runStatement.mockResolvedValue({
      rows: ROWS_NOW,
      row_count: 2,
      duration_ms: 3,
      columns: [],
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(
      makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1" })], null),
    );
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.reads[0].asOf).toBeNull();
    expect(res!.reads[0].reason).toMatch(/only be run against today's data/);
  });

  it("reports an error as an answer instead of failing the replay", async () => {
    // A grant revoked since the decision is a real, reportable finding.
    runStatement.mockRejectedValue(new Error('Schema "analytics" is not accessible'));
    chain.mockResolvedValue(makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1" })]));
    const { replayDecision } = await subject();
    const res = await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(res!.reads[0].current!.error).toContain("not accessible");
    expect(res!.reads[0].current!.matchesRecord).toBeNull();
  });

  it("records the check without joining the chain it is checking", async () => {
    // Stamping the replay with the decision id would add rows to that
    // decision's own provenance -- inflating the very read count it verifies.
    runStatement.mockResolvedValue({
      rows: ROWS_THEN,
      row_count: 2,
      duration_ms: 4,
      columns: [],
      truncated: false,
      kind: "select",
    });
    chain.mockResolvedValue(makeChain([lakeRead({ provider: "lakehouse", sql: "SELECT 1" })]));
    const { replayDecision } = await subject();
    await replayDecision("u1", "dd3a53e5-1111-4222-8333-444444444444");
    expect(audited).toHaveBeenCalledTimes(1);
    const arg = audited.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.action).toBe("provenance.replay");
    expect(arg.decisionId).toBeUndefined();
  });

  it("returns null for a decision that is not the caller's", async () => {
    chain.mockResolvedValue(null);
    const { replayDecision } = await subject();
    expect(await replayDecision("u2", "dd3a53e5-1111-4222-8333-444444444444")).toBeNull();
  });
});
