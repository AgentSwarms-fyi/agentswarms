// Parallel offset windows, and the four things that went wrong at once.
//
// `lib/sqlEngine` loads a whole dataset into the in-page SQL engine five windows
// at a time. What a user's query answers — and what the AI SQL path reads — is
// whatever this put into the engine. The loop:
//
//   let stop = false;
//   for (const { data: chunk, error: rowErr } of results) {
//     if (rowErr || !chunk || chunk.length === 0) { stop = true; break; }
//     allRows.push(...);
//     if (chunk.length < PAGE) { stop = true; break; }
//   }
//   if (stop) break;
//   pageIndex += PARALLEL_PAGES;
//
//   1. a window's ERROR became `stop`, so one failed request out of five
//      registered the table with whatever the other four returned;
//   2. no ORDER BY, while issuing five concurrent windows — Postgres promises
//      no order without one, so the windows were not even guaranteed to be
//      consistent with each other;
//   3. the first short window ended the entire read;
//   4. offsets were `pageIndex * PAGE`, the REQUEST size, so a server handing
//      back less than a full page left a hole at every window boundary.
//
// Unlike the earlier rounds in this sweep, the algorithm here is exercised
// directly rather than replicated: it was lifted into `lib/pagedSelect` beside
// the sequential pager precisely so these could be real tests.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { selectAllWindows } from "@/lib/pagedSelect";

/** A table that clamps every window to `cap`, as PostgREST does. */
function table(total: number, cap: number) {
  let windows = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  return {
    stats: () => ({ windows, peakInFlight }),
    count: async () => total,
    fetchWindow: async (from: number, size: number) => {
      windows++;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return Array.from({ length: Math.max(0, Math.min(size, cap, total - from)) }, (_, i) => ({
        id: from + i,
      }));
    },
  };
}

describe("selectAllWindows", () => {
  it("reads every row exactly once when the server honours the page size", async () => {
    const t = table(12_500, 1000);
    const rows = await selectAllWindows<{ id: number }>({
      count: t.count,
      fetchWindow: t.fetchWindow,
      concurrency: 5,
      pageSize: 1000,
    });

    expect(rows).toHaveLength(12_500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(12_500);
  });

  it("reads every row when the server's cap is SMALLER than the page asked for", async () => {
    // The hole-maker. Windows sized to the request would have skipped
    // 400-999, 1400-1999, and so on, at every boundary.
    const t = table(5000, 400);
    const rows = await selectAllWindows<{ id: number }>({
      count: t.count,
      fetchWindow: t.fetchWindow,
      concurrency: 5,
      pageSize: 1000,
    });

    expect(rows).toHaveLength(5000);
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(ids[0]).toBe(0);
    expect(ids[ids.length - 1]).toBe(4999);
    expect(new Set(ids).size).toBe(5000);
  });

  it("actually runs windows concurrently", async () => {
    // The reason this shape exists at all. A sequential pager would be correct
    // too, and slower; if the concurrency ever silently became 1 the fix would
    // have cost the feature its speed without anyone noticing.
    const t = table(10_000, 1000);
    await selectAllWindows<{ id: number }>({
      count: t.count,
      fetchWindow: t.fetchWindow,
      concurrency: 5,
      pageSize: 1000,
    });
    expect(t.stats().peakInFlight).toBeGreaterThan(1);
  });

  it("aborts the whole load when ONE window fails", async () => {
    // Not "returns what the others gave". The old loop registered a table from
    // the surviving windows of the batch, and a query answered from it.
    const t = table(10_000, 1000);
    let calls = 0;
    await expect(
      selectAllWindows<{ id: number }>({
        count: t.count,
        concurrency: 5,
        pageSize: 1000,
        label: "orders",
        fetchWindow: async (from, size) => {
          calls++;
          if (calls === 4) throw new Error("statement timeout");
          return t.fetchWindow(from, size);
        },
      }),
    ).rejects.toThrow("statement timeout");
  });

  it("refuses when the rows do not add up to the count", async () => {
    // The check that makes parallel offsets safe. A server that quietly drops a
    // window shows up here rather than in a query result.
    const short = {
      count: async () => 5000,
      fetchWindow: async (from: number, size: number) =>
        from > 2000
          ? []
          : Array.from({ length: Math.min(size, 1000) }, (_, i) => ({ id: from + i })),
    };
    await expect(
      selectAllWindows<{ id: number }>({
        ...short,
        concurrency: 5,
        pageSize: 1000,
        label: "orders",
      }),
    ).rejects.toThrow(/read \d+ of 5000 rows/);
  });

  it("accepts MORE rows than the count, which is an insert and not a gap", async () => {
    const t = table(3000, 1000);
    const rows = await selectAllWindows<{ id: number }>({
      count: async () => 2500, // a stale count: 500 rows arrived mid-load
      fetchWindow: t.fetchWindow,
      concurrency: 5,
      pageSize: 1000,
    });
    expect(rows.length).toBeGreaterThanOrEqual(2500);
  });

  it("handles a table smaller than one window without a second request", async () => {
    const t = table(120, 1000);
    const rows = await selectAllWindows<{ id: number }>({
      count: t.count,
      fetchWindow: t.fetchWindow,
      concurrency: 5,
      pageSize: 1000,
    });
    expect(rows).toHaveLength(120);
    expect(t.stats().windows).toBe(1);
  });

  it("refuses a table that claims rows and returns none", async () => {
    await expect(
      selectAllWindows<{ id: number }>({
        count: async () => 900,
        fetchWindow: async () => [],
        concurrency: 5,
        pageSize: 1000,
        label: "orders",
      }),
    ).rejects.toThrow(/reports 900 rows but returned none/);
  });

  it("asks for nothing beyond an empty table", async () => {
    const t = table(0, 1000);
    const rows = await selectAllWindows<{ id: number }>({
      count: t.count,
      fetchWindow: t.fetchWindow,
      concurrency: 5,
      pageSize: 1000,
    });
    expect(rows).toEqual([]);
    expect(t.stats().windows).toBe(1);
  });
});

describe("what sqlEngine actually does with it", () => {
  const SRC = readFileSync("src/lib/sqlEngine.ts", "utf8");

  it("loads the dataset through the checked parallel reader", () => {
    expect(SRC).toContain("await selectAllWindows<Record<string, unknown>>({");
    expect(SRC).toContain("concurrency: PARALLEL_PAGES,");
  });

  it("orders each window by a unique column", () => {
    expect(SRC).toContain('.order("id", { ascending: true })');
  });

  it("no longer folds a window's error into a stop flag", () => {
    expect(SRC).not.toMatch(/let stop = false;/);
    expect(SRC).not.toMatch(/pageIndex \+= PARALLEL_PAGES/);
  });

  it("throws on a failed window rather than registering a partial table", () => {
    expect(SRC).toMatch(/if \(error\) throw new Error\(`could not read/);
  });

  it("does not register an EMPTY table when a shared read fails", () => {
    // `if (rpcErr || !Array.isArray(data)) return [];` answered a failed read
    // with "no results", which is what an empty dataset answers too.
    expect(SRC).toMatch(/if \(rpcErr\) throw new Error\(`could not read shared dataset/);
    expect(SRC).not.toMatch(/if \(rpcErr \|\| !Array\.isArray\(data\)\) return \[\];/);
  });
});
