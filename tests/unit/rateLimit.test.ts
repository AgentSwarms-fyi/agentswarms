// Request limiting — the per-instance primitives and the cross-instance ones.
//
// These enforce documented governance ceilings (SWARM_RUN_RATE_LIMIT_PER_MIN,
// SWARM_RUN_MAX_CONCURRENT) and had no tests at all, which is how "the limit is
// counted per process" survived long enough to become an N-instance multiplier.
//
// The global variants talk to Postgres, so what is tested here is everything
// around that call: the allow/deny decision, that a full bucket is refused, and
// above all that a DATABASE FAILURE degrades to the in-process limiter instead
// of failing every request. Behaviour inside the SQL functions belongs to
// tests/integration, which runs against a real database.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireSlot,
  acquireSlotGlobal,
  envInt,
  rateLimited,
  rateLimitedGlobal,
  releaseSlot,
} from "@/utils/rateLimit.server";

// Each test uses its own bucket name: the module holds process-wide state, and
// sharing a bucket between tests would make them order-dependent.
let n = 0;
const bucket = () => `test-bucket-${++n}-${Math.random()}`;

describe("rateLimited (per instance)", () => {
  it("allows up to the limit, then refuses", () => {
    const b = bucket();
    expect(rateLimited(b, 3)).toBe(false);
    expect(rateLimited(b, 3)).toBe(false);
    expect(rateLimited(b, 3)).toBe(false);
    expect(rateLimited(b, 3)).toBe(true);
  });

  it("counts each bucket separately", () => {
    const a = bucket();
    const c = bucket();
    expect(rateLimited(a, 1)).toBe(false);
    expect(rateLimited(a, 1)).toBe(true);
    // A different key must be unaffected by a noisy neighbour.
    expect(rateLimited(c, 1)).toBe(false);
  });

  it("a limit of zero refuses everything", () => {
    expect(rateLimited(bucket(), 0)).toBe(true);
  });

  it("forgets hits once the window has passed", () => {
    vi.useFakeTimers();
    try {
      const b = bucket();
      expect(rateLimited(b, 1)).toBe(false);
      expect(rateLimited(b, 1)).toBe(true);
      vi.advanceTimersByTime(61_000);
      expect(rateLimited(b, 1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("acquireSlot / releaseSlot (per instance)", () => {
  it("caps simultaneous holders", () => {
    const b = bucket();
    expect(acquireSlot(b, 2)).toBe(true);
    expect(acquireSlot(b, 2)).toBe(true);
    expect(acquireSlot(b, 2)).toBe(false);
  });

  it("frees a slot on release", () => {
    const b = bucket();
    expect(acquireSlot(b, 1)).toBe(true);
    expect(acquireSlot(b, 1)).toBe(false);
    releaseSlot(b);
    expect(acquireSlot(b, 1)).toBe(true);
  });

  it("an over-release cannot mint extra capacity", () => {
    // A double release in a finally block must not push the counter negative
    // and hand out more slots than the cap.
    const b = bucket();
    expect(acquireSlot(b, 1)).toBe(true);
    releaseSlot(b);
    releaseSlot(b);
    releaseSlot(b);
    expect(acquireSlot(b, 1)).toBe(true);
    expect(acquireSlot(b, 1)).toBe(false);
  });
});

describe("envInt", () => {
  afterEach(() => {
    delete process.env.TEST_KNOB;
  });

  it("falls back when unset, blank, zero, negative or unparseable", () => {
    expect(envInt("TEST_KNOB", 7)).toBe(7);
    for (const v of ["", "0", "-1", "abc"]) {
      process.env.TEST_KNOB = v;
      expect(envInt("TEST_KNOB", 7), `value ${JSON.stringify(v)}`).toBe(7);
    }
  });

  it("reads a positive integer", () => {
    process.env.TEST_KNOB = "42";
    expect(envInt("TEST_KNOB", 7)).toBe(42);
  });
});

// ── Cross-instance variants ────────────────────────────────────────────────

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => rpc(...args) },
}));

describe("rateLimitedGlobal", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("allows when the database says the hit was recorded", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await rateLimitedGlobal(bucket(), 30)).toBe(false);
    expect(rpc).toHaveBeenCalledWith("rate_limit_take", expect.objectContaining({ _max: 30 }));
  });

  it("refuses when the database says the bucket is full", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await rateLimitedGlobal(bucket(), 30)).toBe(true);
  });

  it("falls back to the per-instance limiter when the database errors", async () => {
    // The property that matters: a Postgres blip must not 429 every caller.
    rpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    const b = bucket();
    expect(await rateLimitedGlobal(b, 2)).toBe(false);
    expect(await rateLimitedGlobal(b, 2)).toBe(false);
    // ...but the fallback is a real limiter, not an open door.
    expect(await rateLimitedGlobal(b, 2)).toBe(true);
  });

  it("falls back when the rpc call throws outright", async () => {
    rpc.mockImplementation(async () => {
      throw new Error("network down");
    });
    expect(await rateLimitedGlobal(bucket(), 1)).toBe(false);
  });
});

describe("acquireSlotGlobal", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("returns a releasable slot when one is available", async () => {
    rpc.mockResolvedValue({ data: "lease-1", error: null });
    const slot = await acquireSlotGlobal(bucket(), 5, 900);
    expect(slot).not.toBeNull();
    await slot!.release();
    expect(rpc).toHaveBeenCalledWith("concurrency_release", { _id: "lease-1" });
  });

  it("returns null when the bucket is full", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await acquireSlotGlobal(bucket(), 5, 900)).toBeNull();
  });

  it("release is idempotent", async () => {
    // The async path releases in a detached task while the outer finally may
    // also fire; releasing twice must not free someone else's slot.
    rpc.mockResolvedValue({ data: "lease-2", error: null });
    const slot = await acquireSlotGlobal(bucket(), 5, 900);
    await slot!.release();
    await slot!.release();
    const releases = rpc.mock.calls.filter((c) => c[0] === "concurrency_release");
    expect(releases).toHaveLength(1);
  });

  it("a failed release does not throw at the caller", async () => {
    rpc.mockResolvedValueOnce({ data: "lease-3", error: null });
    const slot = await acquireSlotGlobal(bucket(), 5, 900);
    rpc.mockImplementation(async () => {
      throw new Error("gone");
    });
    await expect(slot!.release()).resolves.toBeUndefined();
  });

  it("falls back to per-instance slots when the database errors", async () => {
    rpc.mockImplementation(async () => {
      throw new Error("down");
    });
    const b = bucket();
    const first = await acquireSlotGlobal(b, 1, 900);
    expect(first).not.toBeNull();
    // The fallback still enforces the cap.
    expect(await acquireSlotGlobal(b, 1, 900)).toBeNull();
    await first!.release();
    expect(await acquireSlotGlobal(b, 1, 900)).not.toBeNull();
  });

  it("never asks for a lease shorter than a minute", async () => {
    rpc.mockResolvedValue({ data: "lease-4", error: null });
    await acquireSlotGlobal(bucket(), 5, 1);
    expect(rpc).toHaveBeenCalledWith(
      "concurrency_acquire",
      expect.objectContaining({ _lease_seconds: 60 }),
    );
  });
});
