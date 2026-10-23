import { describe, expect, it } from "vitest";

import { deleteKeepingAtLeastOne, type LastOneOps } from "@/utils/lastOneGuard";

type Row = { id: string; data: string };

const WORDS = {
  refusal: "A workbook keeps at least one sheet",
  missing: "This sheet no longer exists",
};

/**
 * A table two requests share.
 *
 * Every operation takes exactly one turn of the microtask queue, which is what
 * makes the race below deterministic: two deletes started together interleave
 * step for step — both read, then both remove, then both count. That is the
 * interleaving that emptied a real workbook on 2026-10-04, and it is the one
 * a count taken before the write cannot survive.
 */
function fakeTable(ids: string[]) {
  const rows = new Map<string, Row>(ids.map((id) => [id, { id, data: `cells of ${id}` }]));
  const restored: Row[] = [];
  const opsFor = (id: string): LastOneOps<Row> => ({
    read: async () => {
      await Promise.resolve();
      return rows.get(id) ?? null;
    },
    remove: async () => {
      await Promise.resolve();
      return rows.delete(id);
    },
    countRemaining: async () => {
      await Promise.resolve();
      return rows.size;
    },
    restore: async (row) => {
      await Promise.resolve();
      rows.set(row.id, row);
      restored.push(row);
    },
  });
  return { rows, restored, opsFor };
}

describe("deleteKeepingAtLeastOne", () => {
  it("deletes when others are left", async () => {
    const t = fakeTable(["a", "b", "c"]);
    expect(await deleteKeepingAtLeastOne(t.opsFor("a"), WORDS)).toEqual({ ok: true });
    expect([...t.rows.keys()]).toEqual(["b", "c"]);
    expect(t.restored).toEqual([]);
  });

  it("refuses to take the last one, and leaves it there", async () => {
    const t = fakeTable(["only"]);
    expect(await deleteKeepingAtLeastOne(t.opsFor("only"), WORDS)).toEqual({
      ok: false,
      error: WORDS.refusal,
    });
    // Put back whole: the cells came with it.
    expect(t.rows.get("only")).toEqual({ id: "only", data: "cells of only" });
    expect(t.restored).toEqual([{ id: "only", data: "cells of only" }]);
  });

  it("says so when the row is already gone", async () => {
    const t = fakeTable(["a", "b"]);
    expect(await deleteKeepingAtLeastOne(t.opsFor("gone"), WORDS)).toEqual({
      ok: false,
      error: WORDS.missing,
    });
    expect(t.rows.size).toBe(2);
  });

  // The round's own case: two deletes of DIFFERENT rows, arriving together on
  // a table that holds exactly two. Before this helper both passed a count
  // taken before the write and the table was emptied.
  it("never empties the table when two deletes of different rows interleave", async () => {
    const t = fakeTable(["one", "two"]);
    const [a, b] = await Promise.all([
      deleteKeepingAtLeastOne(t.opsFor("one"), WORDS),
      deleteKeepingAtLeastOne(t.opsFor("two"), WORDS),
    ]);
    expect(t.rows.size).toBeGreaterThanOrEqual(1);
    // One of them is told plainly that its delete did not happen, rather than
    // being told it worked while the table went empty.
    const refusals = [a, b].filter((r) => !r.ok);
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    for (const r of refusals) expect(r).toEqual({ ok: false, error: WORDS.refusal });
    // Whatever survived is whole, not a husk.
    for (const row of t.rows.values()) expect(row.data).toBe(`cells of ${row.id}`);
  });

  // The other race, and the likelier one: the same sheet deleted twice, which
  // is what a double-click or a retry looks like. One of them did it; the
  // other must be told it was already gone, not told it worked.
  it("tells the second of two deletes of the SAME row that it was already gone", async () => {
    const t = fakeTable(["one", "two"]);
    const [a, b] = await Promise.all([
      deleteKeepingAtLeastOne(t.opsFor("one"), WORDS),
      deleteKeepingAtLeastOne(t.opsFor("one"), WORDS),
    ]);
    expect([...t.rows.keys()]).toEqual(["two"]);
    const outcomes = [a, b].map((r) => (r.ok ? "ok" : r.error)).sort();
    expect(outcomes).toEqual([WORDS.missing, "ok"]);
  });

  it("puts the row back when the count after the delete fails", async () => {
    const t = fakeTable(["a", "b"]);
    const ops = t.opsFor("a");
    const r = await deleteKeepingAtLeastOne(
      { ...ops, countRemaining: () => Promise.reject(new Error("connection reset")) },
      WORDS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/put back/i);
      expect(r.error).toContain("connection reset");
    }
    expect(t.rows.has("a")).toBe(true);
  });

  it("throws, rather than refusing quietly, when the row cannot be put back", async () => {
    const t = fakeTable(["only"]);
    const ops = t.opsFor("only");
    await expect(
      deleteKeepingAtLeastOne(
        { ...ops, restore: () => Promise.reject(new Error("insert denied")) },
        WORDS,
      ),
    ).rejects.toThrow(/nothing is left/i);
    expect(t.rows.size).toBe(0);
  });
});
