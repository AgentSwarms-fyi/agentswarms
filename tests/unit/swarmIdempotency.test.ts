// Idempotency on the public swarm run endpoint.
//
// The endpoint's promise: "repeating a key returns the original result instead
// of re-running (and re-billing) the swarm". Every branch here is a billing
// decision, and the claim that follows was not atomic — see the last block.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { idempotencyVerdict, type IdempotencyRow } from "@/utils/swarmIdempotency";

const row = (over: Partial<IdempotencyRow> = {}): IdempotencyRow => ({
  status: "completed",
  request_hash: "h1",
  response: { output: "done", runId: "r1" },
  run_id: "r1",
  ...over,
});

describe("a key that has never been seen", () => {
  it("is claimed and run", () => {
    expect(idempotencyVerdict(null, "h1")).toEqual({ action: "claim" });
    expect(idempotencyVerdict(undefined, "h1")).toEqual({ action: "claim" });
  });
});

describe("the same key with the same body", () => {
  it("replays the stored response instead of running again", () => {
    const v = idempotencyVerdict(row(), "h1");
    expect(v).toEqual({ action: "replay", response: { output: "done", runId: "r1" } });
  });

  it("reports a run still in flight rather than starting a second one", () => {
    expect(idempotencyVerdict(row({ status: "in_progress", response: null }), "h1")).toEqual({
      action: "in_progress",
      runId: "r1",
    });
  });

  it("lets a failed attempt be retried", () => {
    expect(idempotencyVerdict(row({ status: "failed", response: null }), "h1")).toEqual({
      action: "claim",
    });
  });

  it("re-runs when a record says completed but stored nothing to hand back", () => {
    // Replaying `null` as if it were the answer would return a success-shaped
    // body with no output in it.
    expect(idempotencyVerdict(row({ status: "completed", response: null }), "h1")).toEqual({
      action: "claim",
    });
  });
});

describe("the same key with a different body", () => {
  it("is refused, whatever state the previous run is in", () => {
    // The mismatch check has to come FIRST. Handing back the earlier body's
    // result would return an unrelated run's output, quietly, looking exactly
    // like success.
    for (const status of ["completed", "in_progress", "failed"] as const) {
      expect(idempotencyVerdict(row({ status }), "h2"), status).toEqual({ action: "mismatch" });
    }
  });

  it("does not treat an empty hash as a match for everything", () => {
    expect(idempotencyVerdict(row({ request_hash: "" }), "h1")).toEqual({ action: "mismatch" });
    expect(idempotencyVerdict(row(), "")).toEqual({ action: "mismatch" });
  });
});

describe("the claim itself must be atomic", () => {
  // THE BUG. The verdict above is only advice; the write that follows decides
  // whether two racers both run. It was an upsert, which SUCCEEDS FOR BOTH:
  // two concurrent requests with the same key each read no row, each upserted,
  // and each ran the swarm. That is double work and double billing in exactly
  // the situation idempotency exists to cover, because proxy retries and
  // at-least-once queues are concurrent by nature.
  //
  // Correctness here is a database property — UNIQUE (api_key_id,
  // idempotency_key) makes insert() fail for the loser — so this asserts the
  // shape of the write rather than simulating Postgres.
  const src = readFileSync("src/routes/api/swarm.run.ts", "utf8");
  const claim = src.slice(src.indexOf("── Idempotency"), src.indexOf("const input ="));

  it("claims with insert, not upsert", () => {
    expect(claim).toContain(".insert({");
    expect(claim, "upsert lets both racers through").not.toContain(".upsert(");
  });

  it("takes over a failed record only while it is still failed", () => {
    // The retry path cannot be an unconditional update, or two retriers both
    // win it.
    expect(claim).toMatch(/\.eq\("status", "failed"\)/);
  });

  it("refuses when the row is already claimed by someone else", () => {
    expect(claim).toMatch(/if \(!taken\)[\s\S]{0,200}409/);
  });

  it("still relies on the uniqueness constraint that makes this work", () => {
    const mig = readFileSync(
      "supabase/migrations/20260752000000_embed_retention_idempotency_webhooks.sql",
      "utf8",
    );
    expect(mig).toContain("UNIQUE (api_key_id, idempotency_key)");
  });
});
