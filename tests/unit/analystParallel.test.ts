// Running analysis steps concurrently. Two failures here are silent rather
// than loud, which is what makes them worth pinning:
//   - a result landing at the wrong index attributes one query's numbers to
//     another query's goal, and every downstream stage believes it;
//   - a cache shared across sources, or across time, serves a number that is
//     no longer true with nothing on screen saying so.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ANALYST_STEP_CONCURRENCY,
  createTurnCache,
  mapWithConcurrency,
  resultCacheKey,
} from "@/lib/analystParallel";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("bounded concurrent mapping", () => {
  it("preserves input order regardless of completion order", async () => {
    // The slowest item is FIRST, so anything that collects results as they
    // finish will reorder them.
    const out = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms, i) => {
      await tick(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:20", "2:10", "3:0"]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(5);
        inFlight--;
        return 1;
      },
    );
    expect(peak).toBe(3);
  });

  it("runs everything even when one item throws, then reports the error", async () => {
    // Steps mutate their own object as they go; abandoning in-flight work
    // would leave the trace half-written.
    const done: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
        await tick(5);
        if (n === 1) throw new Error("step 1 failed");
        done.push(n);
        return n;
      }),
    ).rejects.toThrow("step 1 failed");
    expect(done.sort()).toEqual([0, 2, 3]);
  });

  it("reports the FIRST error when several fail", async () => {
    await expect(
      mapWithConcurrency([0, 1], 1, async (n) => {
        throw new Error(`fail ${n}`);
      }),
    ).rejects.toThrow("fail 0");
  });

  it("handles an empty list and a nonsense limit", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
    const out = await mapWithConcurrency([1, 2], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4]);
  });

  it("caps the width at the number of items", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 99, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
      return 1;
    });
    expect(peak).toBe(2);
  });

  it("uses a bounded default", () => {
    expect(ANALYST_STEP_CONCURRENCY).toBeGreaterThan(1);
    expect(ANALYST_STEP_CONCURRENCY).toBeLessThanOrEqual(4);
  });
});

describe("the cache key", () => {
  it("ignores formatting the generator varies between calls", () => {
    expect(resultCacheKey("local", "SELECT  a\n FROM t")).toBe(
      resultCacheKey("local", "select a from t"),
    );
  });

  it("does NOT share a result between two sources", () => {
    // Same SELECT, different warehouse, different answer.
    expect(resultCacheKey("wh:a", "SELECT 1")).not.toBe(resultCacheKey("wh:b", "SELECT 1"));
  });

  it("keeps genuinely different SQL apart", () => {
    expect(resultCacheKey("local", "SELECT a FROM t")).not.toBe(
      resultCacheKey("local", "SELECT b FROM t"),
    );
  });

  it("cannot be rearranged into another pair's key", () => {
    // With a whitespace separator, ("wh:a", "b c") and ("wh:a b", "c") collide
    // — two different sources sharing one cached result.
    expect(resultCacheKey("wh:a", "b c")).not.toBe(resultCacheKey("wh:a b", "c"));
  });

  it("contains no control characters", () => {
    // A NUL separator slipped in once and made every line-oriented tool treat
    // the source file as binary, which is how it was found.
    const key = resultCacheKey("local", "SELECT 1");
    const hasControl = [...key].some((c) => c.charCodeAt(0) < 32);
    expect(hasControl).toBe(false);
  });
});

describe("the per-turn cache", () => {
  it("issues one query for two identical steps", async () => {
    const cache = createTurnCache<number>();
    let calls = 0;
    const run = () =>
      cache.run(resultCacheKey("local", "SELECT 1"), async () => {
        calls++;
        await tick(5);
        return 42;
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    // The point of caching the PROMISE: a value-cache would miss here,
    // because both steps start before either finishes.
    expect(calls).toBe(1);
    expect(cache.size()).toBe(1);
  });

  it("issues separate queries for different SQL", async () => {
    const cache = createTurnCache<number>();
    let calls = 0;
    const run = (sql: string) =>
      cache.run(resultCacheKey("local", sql), async () => {
        calls++;
        return 1;
      });
    await Promise.all([run("SELECT 1"), run("SELECT 2")]);
    expect(calls).toBe(2);
  });

  it("does NOT cache a failure — the next step gets a real attempt", async () => {
    // Warehouses time out. One transient error must not poison the turn.
    const cache = createTurnCache<number>();
    let calls = 0;
    const run = () =>
      cache.run(resultCacheKey("local", "SELECT 1"), async () => {
        calls++;
        if (calls === 1) throw new Error("timeout");
        return 7;
      });
    await expect(run()).rejects.toThrow("timeout");
    await expect(run()).resolves.toBe(7);
    expect(calls).toBe(2);
  });

  it("is per-turn: a new cache re-runs everything", async () => {
    // Between two questions the data can move. Carrying results across would
    // show a number that is no longer true with nothing saying so.
    let calls = 0;
    const fn = async () => {
      calls++;
      return 1;
    };
    await createTurnCache<number>().run(resultCacheKey("local", "SELECT 1"), fn);
    await createTurnCache<number>().run(resultCacheKey("local", "SELECT 1"), fn);
    expect(calls).toBe(2);
  });
});

describe("the wiring", () => {
  const src = readFileSync("src/lib/aiAnalyst.ts", "utf8");

  it("runs the steps through the bounded mapper", () => {
    expect(src).toContain("mapWithConcurrency(");
    expect(src).toContain("ANALYST_STEP_CONCURRENCY");
  });

  it("keeps writing each result at its OWN index", () => {
    // The mapper preserves order, but the loop body also assigns by index —
    // both must stay true or the self-check reads the wrong numbers.
    const loop = src.slice(src.indexOf("mapWithConcurrency("));
    const body = loop.slice(0, loop.indexOf("if (turn.steps.every("));
    expect(body).toContain("results[i] = ");
    expect(body).not.toContain("results.push(");
  });

  it("routes queries through the turn cache", () => {
    expect(src).toContain("createTurnCache");
    expect(src).toContain("resultCacheKey(");
  });
});
