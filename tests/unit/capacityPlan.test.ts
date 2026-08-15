// Capacity planning. The dangerous failure here is not running out of space —
// that is visible. It is a capacity system that silently changes what a query
// answers: evicting something and quietly returning less data, or resolving a
// mode nobody can explain. Eviction may cost SPEED and must never cost
// CORRECTNESS, and every one of these tests exists to hold that line.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  describeCapacity,
  describeEviction,
  describeRowCap,
  formatBytes,
  planEviction,
  resolveMode,
  type MirrorEntry,
} from "@/lib/capacityPlan";

const MB = 1024 * 1024;

const entry = (over: Partial<MirrorEntry> = {}): MirrorEntry => ({
  tableId: "t1",
  name: "orders",
  bytes: 10 * MB,
  rows: 100_000,
  mode: "auto",
  lastUsedAt: "2026-08-14T00:00:00.000Z",
  ...over,
});

describe("resolving a storage mode", () => {
  it("honours an explicit choice, whatever the size", () => {
    // The point of choosing is that the choice wins. A heuristic that
    // overrides the user is a setting that lies.
    //
    // Both cases sit where AUTO would decide the OPPOSITE — 1 row would be
    // left direct, 200k would be mirrored. Picking sizes the heuristic already
    // agrees with proves nothing: the branch could be deleted and the test
    // would still pass.
    expect(resolveMode({ mode: "import", rows: 1, minRows: 5000, maxRows: 1e6 }).mode).toBe(
      "import",
    );
    expect(resolveMode({ mode: "direct", rows: 200_000, minRows: 5000, maxRows: 1e6 }).mode).toBe(
      "direct",
    );
  });

  it("leaves a tiny dataset direct — a mirror would not pay for itself", () => {
    const d = resolveMode({ mode: "auto", rows: 100, minRows: 5000, maxRows: 1e6 });
    expect(d.mode).toBe("direct");
    expect(d.reason).toContain("too small");
  });

  it("leaves a huge dataset direct rather than monopolising the budget", () => {
    const d = resolveMode({ mode: "auto", rows: 5_000_000, minRows: 5000, maxRows: 1e6 });
    expect(d.mode).toBe("direct");
    expect(d.reason).toContain("above the mirror limit");
  });

  it("mirrors what sits in between", () => {
    expect(resolveMode({ mode: "auto", rows: 200_000, minRows: 5000, maxRows: 1e6 }).mode).toBe(
      "import",
    );
  });

  it("always gives a reason", () => {
    // A mode nobody can explain is a mode nobody trusts.
    for (const rows of [1, 200_000, 9e9]) {
      for (const mode of ["auto", "import", "direct"] as const) {
        const d = resolveMode({ mode, rows, minRows: 5000, maxRows: 1e6 });
        expect(d.reason.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("choosing what to evict", () => {
  it("evicts nothing when it already fits", () => {
    const plan = planEviction([entry({ bytes: 5 * MB })], 100 * MB);
    expect(plan.evict).toEqual([]);
    expect(plan.overBy).toBe(0);
  });

  it("treats a budget of zero as unlimited, not as evict-everything", () => {
    // .env keys ship as "" by convention; Number("") is 0, and a naive
    // implementation would drop every mirror the moment nobody set a budget.
    const plan = planEviction([entry(), entry({ tableId: "t2" })], 0);
    expect(plan.evict).toEqual([]);
  });

  it("drops the least recently used first", () => {
    const plan = planEviction(
      [
        entry({ tableId: "old", name: "old", bytes: 10 * MB, lastUsedAt: "2026-01-01T00:00:00Z" }),
        entry({ tableId: "new", name: "new", bytes: 10 * MB, lastUsedAt: "2026-08-01T00:00:00Z" }),
      ],
      15 * MB,
    );
    expect(plan.evict.map((e) => e.tableId)).toEqual(["old"]);
  });

  it("drops a never-used mirror before anything that has been read", () => {
    const plan = planEviction(
      [
        entry({ tableId: "read", name: "read", lastUsedAt: "2020-01-01T00:00:00Z" }),
        entry({ tableId: "never", name: "never", lastUsedAt: null }),
      ],
      15 * MB,
    );
    expect(plan.evict.map((e) => e.tableId)).toEqual(["never"]);
  });

  it("keeps a PINNED dataset until every auto one has gone", () => {
    // A person saying "keep this" outranks a heuristic guessing what matters,
    // even when the pinned one is older.
    const plan = planEviction(
      [
        entry({
          tableId: "pinned",
          name: "pinned",
          mode: "import",
          lastUsedAt: "2020-01-01T00:00:00Z",
        }),
        entry({ tableId: "auto", name: "auto", mode: "auto", lastUsedAt: "2026-08-01T00:00:00Z" }),
      ],
      15 * MB,
    );
    expect(plan.evict.map((e) => e.tableId)).toEqual(["auto"]);
  });

  it("stops as soon as it fits rather than clearing the cache", () => {
    const plan = planEviction(
      [
        entry({ tableId: "a", bytes: 10 * MB, lastUsedAt: "2026-01-01T00:00:00Z" }),
        entry({ tableId: "b", bytes: 10 * MB, lastUsedAt: "2026-02-01T00:00:00Z" }),
        entry({ tableId: "c", bytes: 10 * MB, lastUsedAt: "2026-03-01T00:00:00Z" }),
      ],
      25 * MB,
    );
    expect(plan.evict).toHaveLength(1);
    expect(plan.keptBytes).toBe(20 * MB);
  });

  it("says so when the budget could not hold anything at all", () => {
    // Eviction always reaches zero bytes, so a plan can never truly "fail" —
    // what it can do is leave NOTHING mirrored, which means the budget is
    // buying nothing and only costing speed. That is the signal worth having.
    const plan = planEviction([entry({ bytes: 100 * MB })], 1 * MB);
    expect(plan.clearedAll).toBe(true);
    expect(plan.keptBytes).toBe(0);
    expect(describeEviction(plan)).toContain("Nothing is mirrored now");
  });

  it("does NOT claim everything went when some mirrors survived", () => {
    const plan = planEviction(
      [
        entry({ tableId: "a", bytes: 10 * MB, lastUsedAt: "2026-01-01T00:00:00Z" }),
        entry({ tableId: "b", bytes: 10 * MB, lastUsedAt: "2026-02-01T00:00:00Z" }),
      ],
      15 * MB,
    );
    expect(plan.clearedAll).toBe(false);
    expect(describeEviction(plan)).not.toContain("Nothing is mirrored");
  });

  it("ignores datasets that hold nothing", () => {
    const plan = planEviction(
      [entry({ bytes: 0 }), entry({ tableId: "t2", bytes: 30 * MB })],
      10 * MB,
    );
    expect(plan.evict.map((e) => e.tableId)).toEqual(["t2"]);
  });
});

describe("what the reader is told", () => {
  it("names the datasets it dropped", () => {
    // "Some mirrors were evicted" makes a slow dashboard unexplainable later.
    const plan = planEviction(
      [entry({ tableId: "a", name: "orders" }), entry({ tableId: "b", name: "customers" })],
      5 * MB,
    );
    const msg = describeEviction(plan)!;
    expect(msg).toContain("orders");
    expect(msg).toContain("customers");
  });

  it("says eviction costs speed, NOT correctness", () => {
    // The single most important sentence in this feature.
    const plan = planEviction([entry({ bytes: 30 * MB })], 1 * MB);
    expect(describeEviction(plan)).toContain("still answer correctly");
  });

  it("says nothing when nothing was evicted", () => {
    expect(describeEviction(planEviction([entry()], 100 * MB))).toBeNull();
  });

  it("states the budget even when there is room left", () => {
    // "How much room do I have" is the question the page exists to answer.
    expect(describeCapacity(10 * MB, 100 * MB)).toContain("100 MB");
    expect(describeCapacity(10 * MB, 100 * MB)).toContain("10%");
  });

  it("says plainly when no budget is set", () => {
    expect(describeCapacity(10 * MB, 0)).toContain("no budget set");
  });

  it("formats bytes readably", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});

describe("the mirror layer honours all of this", () => {
  const srv = readFileSync("src/utils/data/parquet.server.ts", "utf8");

  it("reads the dataset's stored mode rather than assuming auto", () => {
    // A setting the writer ignores is a setting that lies to the person who
    // changed it.
    const fn = srv.slice(srv.indexOf("export async function refreshDatasetMirror"));
    const body = fn.slice(0, fn.indexOf("// Page the rows out ONCE"));
    expect(body).toContain('.select("id, name, columns, user_id, data_loaded_at, storage_mode")');
    expect(body).toContain("table.storage_mode as StorageMode");
    expect(body).toContain("resolveMode({");
  });

  it("drops the mirror when the resolved mode is direct", () => {
    const fn = srv.slice(srv.indexOf("export async function refreshDatasetMirror"));
    const body = fn.slice(0, fn.indexOf("// Page the rows out ONCE"));
    expect(body).toContain('if (decision.mode === "direct")');
    expect(body).toContain("dropDatasetMirror(args)");
  });

  it("treats a BLANK budget as no budget, never as zero", () => {
    // .env keys ship as "": Number("") is 0, and 0 through a naive read means
    // "budget of nothing", which evicts every mirror in the workspace.
    const fn = srv.slice(srv.indexOf("function mirrorBudgetBytes"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain('(process.env.MIRROR_BUDGET_BYTES ?? "").trim()');
    expect(body).toContain("if (!raw) return 0;");
  });

  it("ranks eviction by last USE, stamped on read", () => {
    // Stamping the write would evict the stable table nobody changes,
    // precisely because nobody changes it.
    expect(srv).toContain("touchMirror(meta.tableId)");
    expect(srv).toContain("parquet_last_used_at");
  });

  it("tells the owner what it evicted", () => {
    const sweep = srv.slice(srv.indexOf("Budget: bring each workspace"));
    expect(sweep).toContain("describeEviction(plan)");
    expect(sweep).toContain("notifyUser");
  });
});

describe("a row cap is a different kind of loss", () => {
  it("discloses a truncated result", () => {
    // Eviction costs speed; a row cap costs COMPLETENESS, and only the second
    // one changes what the numbers mean.
    const msg = describeRowCap({ returned: 50_000, cap: 50_000, mode: "direct" })!;
    expect(msg).toContain("partial result");
    expect(msg).toContain("50,000");
  });

  it("stays quiet when the result fit", () => {
    expect(describeRowCap({ returned: 10, cap: 50_000, mode: "import" })).toBeNull();
  });
});
