// R463: the scheduler lease fails closed, is short, and is renewed while a
// pass runs, so several replicas can run for availability without running
// the same pass twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: { code?: string; message: string } | null };

// Each update().….select()/await resolves to the next programmed result.
const results: Result[] = [];
const calls: { kind: "claim" | "renew" | "release"; patch: Record<string, unknown> }[] = [];

function chain(patch: Record<string, unknown>) {
  const filters: string[] = [];
  const kind = (): "claim" | "renew" | "release" =>
    filters.includes("or") ? "claim" : patch.locked_until === null ? "release" : "renew";
  const settle = (): Promise<Result> => {
    calls.push({ kind: kind(), patch });
    const next = results.shift() ?? { data: [{ name: "scheduler" }], error: null };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const builder: Record<string, unknown> = {
    eq: () => {
      filters.push("eq");
      return builder;
    },
    or: () => {
      filters.push("or");
      return builder;
    },
    select: () => settle(),
    then: (onOk: (r: Result) => unknown, onErr?: (e: unknown) => unknown) =>
      settle().then(onOk, onErr),
  };
  return builder;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ update: (patch: Record<string, unknown>) => chain(patch) }) },
}));

const lock = await import("@/utils/cronLock.server");

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("claiming", () => {
  it("holds it when the conditional update matches the row", async () => {
    results.push({ data: [{ name: "scheduler" }], error: null });
    expect(await lock.claimCronLease("scheduler")).toBe("held");
    expect(await lock.acquireCronLease("scheduler")).toBe(true);
  });

  it("is busy when another runner holds it", async () => {
    results.push({ data: [], error: null });
    expect(await lock.claimCronLease("scheduler")).toBe("busy");
  });

  it("FAILS CLOSED on an error: the pass is skipped, not run unguarded", async () => {
    results.push({ data: null, error: { code: "57014", message: "canceling statement" } });
    expect(await lock.claimCronLease("scheduler")).toBe("error");
    results.push({ data: null, error: { code: "57014", message: "canceling statement" } });
    expect(await lock.acquireCronLease("scheduler")).toBe(false);
  });

  it("…and on a thrown network failure too", async () => {
    results.push(new Error("fetch failed") as unknown as Result);
    expect(await lock.acquireCronLease("scheduler")).toBe(false);
  });

  it("runs unleased where the table does not exist yet, as one instance always did", async () => {
    results.push({
      data: null,
      error: { code: "42P01", message: 'relation "cron_locks" does not exist' },
    });
    expect(await lock.claimCronLease("scheduler")).toBe("unleased");
    results.push({
      data: null,
      error: { message: "Could not find the table 'public.cron_locks' in the schema cache" },
    });
    expect(await lock.acquireCronLease("scheduler")).toBe(true);
  });

  it("claims for two minutes by default, not ten", async () => {
    const before = Date.now();
    await lock.claimCronLease("scheduler");
    const until = Date.parse(String(calls[0].patch.locked_until));
    expect(until - before).toBeGreaterThanOrEqual(119_000);
    expect(until - before).toBeLessThanOrEqual(121_000);
  });
});

describe("holding it while a pass runs", () => {
  it("renews every third of the lease, and stays held while renewals land", async () => {
    vi.useFakeTimers();
    const lease = lock.holdCronLease("scheduler", "held", 60_000);
    for (let i = 0; i < 6; i++) {
      results.push({ data: [{ name: "scheduler" }], error: null });
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(calls.filter((c) => c.kind === "renew").length).toBe(6);
    expect(lease.lost()).toBe(false); // two full lease lengths later
    lease.stop();
  });

  it("is lost the moment a renewal finds another holder", async () => {
    vi.useFakeTimers();
    const lease = lock.holdCronLease("scheduler", "held", 60_000);
    results.push({ data: [], error: null });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lease.lost()).toBe(true);
    lease.stop();
  });

  it("is lost once failed renewals have let the secured time run out", async () => {
    vi.useFakeTimers();
    const lease = lock.holdCronLease("scheduler", "held", 60_000);
    for (let i = 0; i < 2; i++) {
      results.push({ data: null, error: { message: "timeout" } });
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(lease.lost()).toBe(false); // 40 s in: still inside the first 60
    results.push({ data: null, error: { message: "timeout" } });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(lease.lost()).toBe(true);
    lease.stop();
  });

  it("an unleased runner (no table) has nothing to lose", () => {
    const lease = lock.holdCronLease("scheduler", "unleased", 60_000);
    expect(lease.lost()).toBe(false);
    lease.stop();
  });

  it("stop() ends renewing", async () => {
    vi.useFakeTimers();
    const lease = lock.holdCronLease("scheduler", "held", 60_000);
    lease.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.filter((c) => c.kind === "renew").length).toBe(0);
  });

  it("a renewal does not move updated_at, so 'last pass began' stays the claim time", async () => {
    vi.useFakeTimers();
    const lease = lock.holdCronLease("scheduler", "held", 60_000);
    await vi.advanceTimersByTimeAsync(20_000);
    const renew = calls.find((c) => c.kind === "renew");
    expect(renew?.patch).not.toHaveProperty("updated_at");
    lease.stop();
  });
});

describe("the pass uses it", () => {
  it("stops STARTING steps once the lease is lost or SIGTERM arrives, and says which it skipped", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
    const pass = src.slice(
      src.indexOf("export async function runCronPass"),
      src.indexOf("// ── In-process scheduler"),
    );
    expect(pass).toContain('const lease = holdCronLease("scheduler", claim);');
    expect(pass).toMatch(/lost: \(\) => lease\.lost\(\),\s*draining: isDraining,/);
    expect(pass).toContain("lease.stop();");
    // Every step goes through the guard (driven in cronPassFailures.test.ts):
    // no step is awaited bare any more.
    expect(pass).not.toMatch(/\.catch\(\(e\) => fold\(/);
    expect(pass.match(/await step\(/g)?.length).toBeGreaterThanOrEqual(28);
  });
});
