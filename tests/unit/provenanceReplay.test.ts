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
const DIGEST_THEN = resultDigest(ROWS_THEN);

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
      columns: [],
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
      columns: [],
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
