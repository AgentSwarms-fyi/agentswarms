// The one way the server reads and writes a dataset's rows (R451).
//
// Behaviour here is what each site did by hand, so these pin what those sites
// relied on: a stable order, a page's error kept, a cap that says it stopped,
// batches that stop at the first failure. The last block holds every server file
// to this module: rows of a user under a customer key are to be sealed here, and
// a path around it would read ciphertext as data, or write plaintext beside it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = [string, ...unknown[]];

const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  // What each terminal call answers, in order.
  answers: [] as unknown[],
}));

/** A builder that records its calls and answers from the queue when awaited. */
function builder(calls: unknown[][], answers: unknown[]) {
  const q: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "order", "limit", "delete", "insert", "update", "gte"]) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return q;
    };
  }
  q.range = (from: number, to: number) => {
    calls.push(["range", from, to]);
    return Promise.resolve(answers.shift());
  };
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve(answers.shift()).then(ok);
  q.rpc = (...args: unknown[]) => {
    calls.push(["rpc", ...args]);
    return Promise.resolve(answers.shift());
  };
  return q;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return builder(h.calls, h.answers);
  },
}));

import { __setKeyHierarchyForTests } from "@/utils/providers/crypto.server";
import { missingKeyStore } from "../fixtures/keyStores";
import {
  clearDatasetRows,
  countDatasetRows,
  deleteDatasetRowsSince,
  insertDatasetRows,
  mergeDatasetRows,
  moveDatasetRows,
  newestDatasetRow,
  sampleDatasetRows,
  scanDatasetRows,
} from "@/utils/data/datasetRows.server";

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "00000000-0000-4000-8000-00000000a11c";
const called = (m: string) => (h.calls as Call[]).filter((c) => c[0] === m);

beforeEach(() => {
  h.calls.length = 0;
  h.answers.length = 0;
  // Nobody here is under a customer key: this file is about the plain path.
  __setKeyHierarchyForTests(missingKeyStore());
});
afterEach(() => __setKeyHierarchyForTests(null));

describe("reading a dataset's rows", () => {
  it("gives back the rows themselves, from the one table, in a stable order", async () => {
    h.answers.push({ data: [{ row: { a: 1 } }, { row: { a: 2 } }], error: null });
    h.answers.push({ data: [], error: null });
    const r = await scanDatasetRows(T, 100);
    expect(r).toEqual({ rows: [{ a: 1 }, { a: 2 }], truncated: false });
    expect(called("from")[0]).toEqual(["from", "user_data_rows"]);
    expect(called("select")[0]).toEqual(["select", "row"]);
    expect(called("eq")[0]).toEqual(["eq", "table_id", T]);
    // Offsets over no order are not a sequence.
    expect(called("order")[0]).toEqual(["order", "id", { ascending: true }]);
  });

  it("says when the cap stopped it", async () => {
    h.answers.push({ data: [{ row: { a: 1 } }, { row: { a: 2 } }], error: null });
    // One more row settles whether the cap bit.
    h.answers.push({ data: [{ row: { a: 3 } }], error: null });
    const r = await scanDatasetRows(T, 2);
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(2);
  });

  it("does not take a failed page for the end of the table", async () => {
    h.answers.push({ data: null, error: { message: "statement timeout" } });
    await expect(scanDatasetRows(T, 100)).rejects.toThrow("statement timeout");
  });

  it("reads through the caller's client when it is given one, so its row security applies", async () => {
    const mine: unknown[][] = [];
    const sb = builder(mine, [{ data: [], error: null }]);
    await scanDatasetRows(T, 100, sb as never);
    expect(mine[0]).toEqual(["from", "user_data_rows"]);
    expect(h.calls).toEqual([]);
  });

  it("takes a sample through the caller's client, up to the limit", async () => {
    const mine: unknown[][] = [];
    const sb = builder(mine, [{ data: [{ row: { a: 1 } }], error: null }]);
    expect(await sampleDatasetRows(T, 25, sb as never)).toEqual([{ a: 1 }]);
    expect(mine).toContainEqual(["limit", 25]);
    expect(mine).toContainEqual(["eq", "table_id", T]);
  });

  it("gives no rows for a sample that could not be read", async () => {
    const sb = builder([], [{ data: null, error: { message: "x" } }]);
    expect(await sampleDatasetRows(T, 25, sb as never)).toEqual([]);
  });

  it("counts without reading the rows, and keeps the error", async () => {
    h.answers.push({ count: 7, error: null });
    expect(await countDatasetRows(T)).toEqual({ count: 7, error: null });
    expect(called("select")[0]).toEqual(["select", "id", { count: "exact", head: true }]);
    h.answers.push({ count: null, error: { message: "down" } });
    expect(await countDatasetRows(T)).toEqual({ count: null, error: { message: "down" } });
  });
});

describe("writing a dataset's rows", () => {
  it("clears one dataset, and says when it could not", async () => {
    h.answers.push({ error: null });
    expect(await clearDatasetRows(T)).toEqual({ error: null });
    expect(called("delete")).toHaveLength(1);
    expect(called("eq")[0]).toEqual(["eq", "table_id", T]);
    h.answers.push({ error: { message: "locked" } });
    expect(await clearDatasetRows(T)).toEqual({ error: { message: "locked" } });
  });

  it("inserts in batches, each row under the dataset", async () => {
    h.answers.push({ error: null }, { error: null }, { error: null });
    const rows = Array.from({ length: 1200 }, (_, i) => ({ i }));
    expect(await insertDatasetRows(T, OWNER, rows)).toEqual({ error: null });
    const batches = called("insert").map((c) => c[1] as Array<{ table_id: string; row: unknown }>);
    expect(batches.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(batches[2]![199]).toEqual({ table_id: T, row: { i: 1199 } });
  });

  it("stops at the first batch that fails, and returns why", async () => {
    h.answers.push({ error: { message: "disk full" } }, { error: null });
    const rows = Array.from({ length: 700 }, (_, i) => ({ i }));
    expect(await insertDatasetRows(T, OWNER, rows)).toEqual({ error: { message: "disk full" } });
    expect(called("insert")).toHaveLength(1);
  });

  it("writes nothing for no rows", async () => {
    expect(await insertDatasetRows(T, OWNER, [])).toEqual({ error: null });
    expect(h.calls).toEqual([]);
  });

  it("finds a prep flow's watermark by a column's value, newest first", async () => {
    h.answers.push({ data: [{ row: { day: "2026-11-05" } }], error: null });
    expect(await newestDatasetRow(T, "day")).toEqual({ day: "2026-11-05" });
    expect(called("order")[0]).toEqual(["order", "row->>day", { ascending: false }]);
    expect(called("limit")[0]).toEqual(["limit", 1]);
  });

  it("has no watermark on an empty dataset, which sends the flow to a full build", async () => {
    h.answers.push({ data: [], error: null });
    expect(await newestDatasetRow(T, "day")).toBeNull();
    h.answers.push({ data: null, error: { message: "x" } });
    expect(await newestDatasetRow(T, "day")).toBeNull();
  });

  it("deletes only the range a refresh rebuilds, of the one dataset", async () => {
    h.answers.push({ error: null });
    await deleteDatasetRowsSince(T, "day", "2026-11-01");
    expect(called("eq")[0]).toEqual(["eq", "table_id", T]);
    expect(called("gte")[0]).toEqual(["gte", "row->>day", "2026-11-01"]);
  });

  it("moves an upload's rows from its staging dataset", async () => {
    h.answers.push({ error: null });
    await moveDatasetRows("staging", "target", OWNER);
    expect(called("update")[0]).toEqual(["update", { table_id: "target" }]);
    expect(called("eq")[0]).toEqual(["eq", "table_id", "staging"]);
  });

  it("merges in the database, and reads back what it did in either shape", async () => {
    const args = { targetId: "t", stagingId: "s", key: "id", owner: OWNER };
    h.answers.push({ data: [{ updated: 3, inserted: 4 }], error: null });
    expect(await mergeDatasetRows(args)).toEqual({ updated: 3, inserted: 4, error: null });
    expect(called("rpc")[0]).toEqual([
      "rpc",
      "merge_dataset_rows",
      { p_target: "t", p_staging: "s", p_key: "id" },
    ]);
    h.answers.push({ data: { updated: 1, inserted: 2 }, error: null });
    expect(await mergeDatasetRows(args)).toEqual({ updated: 1, inserted: 2, error: null });
    h.answers.push({ data: null, error: { message: "no" } });
    expect(await mergeDatasetRows(args)).toEqual({
      updated: 0,
      inserted: 0,
      error: { message: "no" },
    });
  });
});

describe("what the sites do with it", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  // In order, each before the next: a swap or a restore that goes on past a
  // failed clear appends to the old rows, and the dataset comes out doubled.
  const inOrder = (src: string, marks: string[]) => {
    let at = 0;
    for (const m of marks) {
      const i = src.indexOf(m, at);
      expect(i, m).toBeGreaterThanOrEqual(at);
      at = i + m.length;
    }
  };

  it("an upload writes what it buffered, to its staging dataset", () => {
    const src = read("src/utils/data/ingest.server.ts");
    expect(src).toContain("this.writer ??= datasetWriter(this.stagingId, this.owner);");
    expect(src).toContain("await (await this.writer).insert(slice as DatasetRow[]);");
  });

  it("an upload's swap clears, stops if it could not, then moves, and stops again", () => {
    inOrder(read("src/utils/data/ingest.server.ts"), [
      "const { error: delErr } = await clearDatasetRows(existing.id);",
      "if (delErr) throw",
      "const { error: moveErr } = await moveDatasetRows(",
      "if (moveErr) throw",
    ]);
  });

  it("a restore clears, stops if it could not, then writes the version's rows", () => {
    inOrder(read("src/utils/bi/versions.server.ts"), [
      "const { error: delErr } = await clearDatasetRows(version.table_id);",
      "if (delErr) throw",
      "const { error: insErr } = await insertDatasetRows(version.table_id, args.userId, rows);",
      "if (insErr) throw",
    ]);
  });

  it("the columnar copy reads up to its own ceiling, not a prefix of the table", () => {
    const src = read("src/utils/data/parquet.server.ts");
    expect(src).toContain("await scanDatasetRows(args.tableId, maxRowsToMirror());");
  });
});

describe("the one way in", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  const server = [...walk("src/utils"), ...walk("src/routes/api")];
  const code = (f: string) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
  const HOME = path.normalize("src/utils/data/datasetRows.server.ts");

  it("finds server files to check, so an empty sweep cannot pass", () => {
    expect(server.length).toBeGreaterThan(100);
    expect(server).toContain(HOME);
  });

  it("no server file reads or writes the rows except through this module", () => {
    const around = server.filter(
      (f) =>
        path.normalize(f) !== HOME &&
        /\.from\(\s*"user_data_rows"|rpc\(\s*"merge_dataset_rows"/.test(code(f)),
    );
    expect(around).toEqual([]);
  });

  it("the browser's one remaining path is the one the next round moves", () => {
    const browser = walk("src/lib").filter((f) => /\.from\(\s*"user_data_rows"/.test(code(f)));
    expect(browser.map((f) => path.basename(f)).sort()).toEqual(["sqlEngine.ts"]);
  });
});
