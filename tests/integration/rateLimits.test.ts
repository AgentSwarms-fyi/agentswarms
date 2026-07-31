// The cross-instance limiter, against a REAL database.
//
// tests/unit/rateLimit.test.ts mocks the RPC, so it proves the TypeScript side
// decides correctly and degrades safely. It cannot prove the SQL is right —
// and the SQL is where the governance guarantee actually lives. That is what
// this file is for.
//
// The property under test is the one that was broken: the ceiling an operator
// configures must be the ceiling they get, no matter how many app instances
// are counting. Two callers here stand in for two instances, because they
// share nothing except the database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admin, hasSupabase, testBucket, TEST_PREFIX } from "./setup";

describe.skipIf(!hasSupabase)("rate_limit_take", () => {
  const buckets: string[] = [];

  afterAll(async () => {
    // Leave the project exactly as we found it.
    await admin().from("rate_limit_hits").delete().like("bucket", `${TEST_PREFIX}%`);
    await admin().from("concurrency_leases").delete().like("bucket", `${TEST_PREFIX}%`);
  });

  async function take(bucket: string, max: number, windowSeconds = 60) {
    const { data, error } = await admin().rpc("rate_limit_take", {
      _bucket: bucket,
      _max: max,
      _window_seconds: windowSeconds,
    });
    if (error) throw new Error(error.message);
    return data as boolean;
  }

  it("allows exactly the configured number, then refuses", async () => {
    const b = testBucket("rl-basic");
    buckets.push(b);
    expect(await take(b, 3)).toBe(true);
    expect(await take(b, 3)).toBe(true);
    expect(await take(b, 3)).toBe(true);
    expect(await take(b, 3)).toBe(false);
  });

  it("holds the SAME ceiling across independent callers", async () => {
    // The actual regression: two app instances must not each get the full
    // allowance. Nothing is shared here but Postgres.
    const b = testBucket("rl-shared");
    buckets.push(b);
    const results = await Promise.all([take(b, 2), take(b, 2), take(b, 2), take(b, 2)]);
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it("counts each bucket separately", async () => {
    const a = testBucket("rl-a");
    const c = testBucket("rl-c");
    buckets.push(a, c);
    expect(await take(a, 1)).toBe(true);
    expect(await take(a, 1)).toBe(false);
    expect(await take(c, 1)).toBe(true);
  });

  it("slides: hits outside the window stop counting", async () => {
    const b = testBucket("rl-window");
    buckets.push(b);
    // A one-second window is enough to prove the window really moves without
    // making the suite sleep for a minute.
    expect(await take(b, 1, 1)).toBe(true);
    expect(await take(b, 1, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await take(b, 1, 1)).toBe(true);
  });
});

describe.skipIf(!hasSupabase)("concurrency_acquire / release", () => {
  afterAll(async () => {
    await admin().from("concurrency_leases").delete().like("bucket", `${TEST_PREFIX}%`);
  });

  async function acquire(bucket: string, max: number, lease = 900) {
    const { data, error } = await admin().rpc("concurrency_acquire", {
      _bucket: bucket,
      _max: max,
      _lease_seconds: lease,
    });
    if (error) throw new Error(error.message);
    return data as string | null;
  }

  async function release(id: string) {
    const { error } = await admin().rpc("concurrency_release", { _id: id });
    if (error) throw new Error(error.message);
  }

  it("caps simultaneous holders and frees on release", async () => {
    const b = testBucket("cc-basic");
    const first = await acquire(b, 2);
    const second = await acquire(b, 2);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(await acquire(b, 2)).toBeNull();

    await release(first!);
    const third = await acquire(b, 2);
    expect(third).toBeTruthy();
    await release(second!);
    await release(third!);
  });

  it("holds one cap across independent callers", async () => {
    const b = testBucket("cc-shared");
    const ids = await Promise.all([acquire(b, 2), acquire(b, 2), acquire(b, 2), acquire(b, 2)]);
    const granted = ids.filter(Boolean) as string[];
    expect(granted).toHaveLength(2);
    await Promise.all(granted.map(release));
  });

  it("an expired lease frees its slot — a crashed instance must self-heal", async () => {
    // Without this, one hard crash would permanently reduce the cap.
    const b = testBucket("cc-expiry");
    const held = await acquire(b, 1, 1); // 1-second lease
    expect(held).toBeTruthy();
    expect(await acquire(b, 1, 1)).toBeNull();

    await new Promise((r) => setTimeout(r, 1500));
    const afterExpiry = await acquire(b, 1, 1);
    expect(afterExpiry, "an expired lease must not hold the slot forever").toBeTruthy();
    await release(afterExpiry!);
  });

  it("releasing an unknown id is harmless", async () => {
    // The app releases in a finally block that can run after a lease expired.
    await expect(release("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });
});

describe.skipIf(!hasSupabase)("privilege boundary", () => {
  it("the limiter tables are not readable by an anonymous client", async () => {
    // RLS is on with no policies, so only the service role gets in. If this
    // ever starts returning rows, bucket names (which embed API key ids) leak.
    const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!anonKey || !process.env.SUPABASE_URL) return;
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(process.env.SUPABASE_URL, anonKey, {
      auth: { persistSession: false },
    });
    const { data } = await anon.from("rate_limit_hits").select("*").limit(1);
    expect(data ?? []).toHaveLength(0);
  });
});
