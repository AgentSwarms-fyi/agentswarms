// The rules for splitting ROWS across containers rather than candidates.
//
// The slice arithmetic is checked as a PROPERTY — every row used belongs to
// exactly one worker — swept over many shapes, rather than by asserting three
// hand-picked offsets. A gap is data the user believes was trained on and was
// not; an overlap weights part of the data twice inside the average. Neither
// announces itself in a metric.
import { describe, expect, it } from "vitest";

import {
  MIN_ROWS_PER_WORKER,
  parallelPlan,
  parallelWarnings,
  partitionSql,
  workerForHash,
  type ParallelPlan,
} from "@/lib/mlDataParallel";

const ok = (r: ReturnType<typeof parallelPlan>): ParallelPlan => {
  expect(r.ok, "ok" in r && !r.ok ? r.reason : "").toBe(true);
  return (r as { ok: true; plan: ParallelPlan }).plan;
};

describe("when splitting the rows is worth it", () => {
  it("refuses when the rows already fit in one container", () => {
    // Splitting a dataset that fits pays k container starts to make the model
    // slightly worse. There is no version of that which is a feature.
    const r = parallelPlan({ totalRows: 20_000, perWorker: 2_000_000, maxWorkers: 8 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("fit in one container");
  });

  it("refuses when each worker would see too little to learn from", () => {
    // 60k rows over 8 workers is 7.5k each, under the measured floor. The
    // platform samples the old way instead — a fast answer that is worse than
    // the slow one is not an improvement.
    const r = parallelPlan({
      totalRows: 60_000,
      perWorker: 10_000,
      maxWorkers: 8,
      minRowsPerWorker: MIN_ROWS_PER_WORKER,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("below the 25,000 needed");
  });

  it("refuses when the instance allows only one container", () => {
    const r = parallelPlan({ totalRows: 10_000_000, perWorker: 2_000_000, maxWorkers: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("only one training container");
  });

  it("and refuses nonsense rather than planning around it", () => {
    expect(parallelPlan({ totalRows: 0, perWorker: 2_000_000, maxWorkers: 8 }).ok).toBe(false);
    expect(parallelPlan({ totalRows: 1e6, perWorker: 0, maxWorkers: 8 }).ok).toBe(false);
    expect(parallelPlan({ totalRows: Number.NaN, perWorker: 2_000_000, maxWorkers: 8 }).ok).toBe(
      false,
    );
  });

  it("uses only as many workers as the rows need", () => {
    // 8M rows at 2M each needs four, not the eight on offer. An idle worker
    // is a container start and a slot somebody else wanted.
    const plan = ok(parallelPlan({ totalRows: 8_000_000, perWorker: 2_000_000, maxWorkers: 8 }));
    expect(plan.workers).toBe(4);
    expect(plan.rowsUsed).toBe(8_000_000);
  });

  it("and is capped by what the instance allows, leaving rows out honestly", () => {
    // 100M rows, four containers of 2M: 8M get used and 92M do not.
    // The plan says so rather than implying the fit saw everything.
    const plan = ok(parallelPlan({ totalRows: 100_000_000, perWorker: 2_000_000, maxWorkers: 4 }));
    expect(plan.workers).toBe(4);
    expect(plan.rowsUsed).toBe(8_000_000);
    expect(plan.totalRows).toBe(100_000_000);
    const warned = parallelWarnings(plan).join(" ");
    expect(warned).toContain("8,000,000 of 100,000,000 rows");
    expect(warned).toContain("The rest were left out");
  });

  it("and says plainly when it did see everything", () => {
    const plan = ok(parallelPlan({ totalRows: 8_000_000, perWorker: 2_000_000, maxWorkers: 8 }));
    expect(parallelWarnings(plan).join(" ")).toContain("all 8,000,000 rows");
  });

  it("every plan admits what pasting is, not just what it covered", () => {
    // The accuracy statement travels with the model. A reader who is told only
    // the row count would reasonably assume one fit over all of them.
    const plan = ok(parallelPlan({ totalRows: 8_000_000, perWorker: 2_000_000, maxWorkers: 8 }));
    const warned = parallelWarnings(plan).join(" ");
    expect(warned).toContain("not identical to one fit over everything");
    expect(warned).toContain("beats fitting once on a sample");
  });
});

describe("every row belongs to exactly one worker", () => {
  it("the modulo covers each hash once, with no gap and no overlap", () => {
    // A PROPERTY over many hashes rather than three examples. A row counted
    // twice weights that evidence twice inside the average; a row counted by
    // nobody is data the user believes was trained on. Neither shows up in a
    // score, which is why this is swept.
    for (const workers of [2, 3, 4, 5, 8, 16]) {
      const seen = new Array<number>(workers).fill(0);
      for (let h = -5_000n, i = 0; i < 10_000; i++, h += 1n) {
        const w = workerForHash(h, workers);
        expect(w, `hash ${h} at ${workers} workers`).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThan(workers);
        seen[w]++;
      }
      // And it spreads them: a partition function that sent everything to
      // worker 0 would satisfy "exactly once" and be useless.
      for (const count of seen) expect(count).toBeGreaterThan(0);
    }
  });

  it("a negative hash lands in range rather than outside it", () => {
    // DuckDB's hash is unsigned but JavaScript's % keeps the sign, so the
    // naive version returns -3 for some rows and those rows belong to no
    // worker at all.
    expect(workerForHash(-1n, 4)).toBe(3);
    expect(workerForHash(-4n, 4)).toBe(0);
    expect(workerForHash(-7n, 4)).toBe(1);
  });

  it("the SQL asks for the same partition the arithmetic does", () => {
    // The two must agree or the rows a worker trains on are not the rows
    // anybody thinks it trained on.
    expect(partitionSql(["a", "b"], 2, 4)).toBe('(hash("a", "b") % 4) = 2');
    expect(partitionSql(["a"], 0, 1)).toBe("TRUE");
  });

  it("and quotes identifiers rather than trusting them", () => {
    // A column named with a quote is a column name, like everywhere else in
    // this codebase.
    expect(partitionSql(['we"ird'], 0, 2)).toBe('(hash("we""ird") % 2) = 0');
  });

  it("an index outside the plan gets no predicate at all", () => {
    // A worker reporting late with a stale index must not silently read
    // partition zero and have it averaged in twice.
    expect(partitionSql(["a"], -1, 4)).toBeNull();
    expect(partitionSql(["a"], 4, 4)).toBeNull();
    expect(partitionSql([], 0, 4)).toBeNull();
  });
});
