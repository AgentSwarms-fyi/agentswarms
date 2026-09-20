// Reading a whole table through an API that answers with a page.
//
// Module 28 of the adversarial pass, partiality sweep. PostgREST caps every
// response at `db-max-rows` — 1,000 on a default Supabase project — and
// supabase-js returns the short page with no error and no flag. The knowledge
// base used such a read to answer a MEMBERSHIP question twice over, which is
// the worst use of a prefix: absence from it is indistinguishable from absence
// from the table.
//
//   kbEmbed.functions.ts — "which of these documents already have chunks", used
//   to decide who is embedded again. Past 1,000 chunk rows in a batch, indexed
//   documents read as pending: paid embedding calls and duplicate chunks that
//   then over-weight those passages in retrieval.
//
//   knowledge.tsx — the same read builds per-document chunk counts, so those
//   documents showed "Pending embedding" while indexed, and "Indexed N/M"
//   counted them as missing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { scanKeysPresent, scanRows } from "@/lib/cursorScan";

/** A table that answers with at most `cap` rows, like PostgREST does. */
function pagedTable(rows: { id: string; key: string }[], cap: number) {
  let calls = 0;
  const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    get calls() {
      return calls;
    },
    byKey: async (after: string | null, pageSize: number) => {
      calls++;
      const from = after === null ? sorted : sorted.filter((r) => r.key > after);
      return from.slice(0, Math.min(pageSize, cap)).map((r) => r.key);
    },
  };
}

describe("scanKeysPresent", () => {
  const KEYS = ["doc-a", "doc-b", "doc-c", "doc-d"];

  it("finds a key whose rows all fall past the server's cap", () => {
    // THE finding. doc-a has 1,200 chunks, so a single capped read returns
    // nothing but doc-a and the other three are read as unindexed.
    const rows = [
      ...Array.from({ length: 1200 }, (_, i) => ({ id: `a${i}`, key: "doc-a" })),
      { id: "b1", key: "doc-b" },
      { id: "d1", key: "doc-d" },
    ];
    const t = pagedTable(rows, 1000);
    return scanKeysPresent(KEYS, t.byKey).then((found) => {
      expect([...found].sort()).toEqual(["doc-a", "doc-b", "doc-d"]);
      expect(found.has("doc-c")).toBe(false);
    });
  });

  it("costs one page per key at worst, not one per row", async () => {
    // Membership needs one row per key, so the scan jumps past the rest of a
    // key as soon as it has seen it: 40,000 chunks is one page, not forty.
    const rows = Array.from({ length: 40_000 }, (_, i) => ({ id: `a${i}`, key: "doc-a" }));
    const t = pagedTable(rows, 1000);
    const found = await scanKeysPresent(["doc-a"], t.byKey);
    expect(found.has("doc-a")).toBe(true);
    expect(t.calls).toBeLessThanOrEqual(2);
  });

  it("is correct at any cap, including one below the page size asked for", async () => {
    // The old paging idiom stopped at the first short page, which is wrong the
    // moment the server's cap is smaller than the page requested. A cursor
    // loop never uses a short page as proof of anything.
    const rows = KEYS.map((k, i) => ({ id: `r${i}`, key: k }));
    for (const cap of [1, 2, 3, 1000]) {
      const t = pagedTable(rows, cap);
      const found = await scanKeysPresent(KEYS, t.byKey, { pageSize: 1000 });
      expect([...found].sort()).toEqual([...KEYS].sort());
    }
  });

  it("asks nothing at all for an empty key list", async () => {
    const t = pagedTable([], 1000);
    expect((await scanKeysPresent([], t.byKey)).size).toBe(0);
    expect(t.calls).toBe(0);
  });

  it("terminates against a page source that ignores the cursor", async () => {
    // Defensive: a fetchPage that forgets `after` would otherwise loop forever.
    let calls = 0;
    const stuck = async () => {
      calls++;
      return ["doc-a"];
    };
    const found = await scanKeysPresent(KEYS, stuck);
    expect(found.has("doc-a")).toBe(true);
    expect(calls).toBeLessThanOrEqual(KEYS.length + 1);
  });
});

describe("scanRows", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(6, "0")}` }));

  function source(all: { id: string }[], cap: number) {
    return async (after: string | null, pageSize: number) => {
      const from = after === null ? all : all.filter((r) => r.id > after);
      return from.slice(0, Math.min(pageSize, cap));
    };
  }

  it("returns every row when the ceiling does not bite", async () => {
    const all = rows(2500);
    const scan = await scanRows(source(all, 1000), (r) => r.id, { maxRows: 50_000 });
    expect(scan.rows.length).toBe(2500);
    expect(scan.complete).toBe(true);
  });

  it("says so when the ceiling stopped it", async () => {
    const all = rows(2500);
    const scan = await scanRows(source(all, 1000), (r) => r.id, { maxRows: 2000 });
    expect(scan.rows.length).toBe(2000);
    expect(scan.complete).toBe(false);
  });

  it("does not call a table of exactly maxRows rows a prefix of itself", async () => {
    // Otherwise a caveat lands on a complete answer, which teaches readers to
    // ignore the caveat.
    const all = rows(2000);
    const scan = await scanRows(source(all, 1000), (r) => r.id, { maxRows: 2000 });
    expect(scan.rows.length).toBe(2000);
    expect(scan.complete).toBe(true);
  });

  it("keeps every row of a tie, because it pages by a unique cursor", async () => {
    const all = rows(1500);
    const scan = await scanRows(source(all, 500), (r) => r.id, { maxRows: 50_000 });
    expect(new Set(scan.rows.map((r) => r.id)).size).toBe(1500);
  });
});

describe("what the knowledge base actually does with these", () => {
  const fn = readFileSync("src/utils/tools/kbEmbed.functions.ts", "utf8");
  const page = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");

  it("checks existing chunks with the scan, not one unbounded select", () => {
    expect(fn).toContain("await scanKeysPresent(ids, async (after, pageSize) => {");
    expect(fn).toContain('.order("document_id", { ascending: true })');
    expect(fn).toContain('q = q.gt("document_id", after)');
  });

  it("fails the backfill when the probe errors instead of re-embedding everything", () => {
    // The old read dropped its error, and an empty `have` means "nothing is
    // indexed" — the most expensive possible reading of a failure.
    // The BRANCH, not the message: `if (false) throw` leaves the string in
    // the file and changes everything.
    expect(fn).toMatch(/if \(pageErr\) throw new Error\(/);
    expect(fn).toContain("could not check existing chunks:");
  });

  it("scans chunk counts by cursor and records whether it saw them all", () => {
    expect(page).toContain("const scan = await scanRows<{ id: string; document_id: string }>(");
    expect(page).toContain("setChunkCountsWhole(scan.complete);");
    expect(page).toContain("const CHUNK_SCAN_MAX = 50_000;");
    // And that the ceiling reaches the scan. Declaring the constant and
    // then passing MAX_SAFE_INTEGER survived the first mutation run: the
    // fifth time this session an anchor was happy with a token that no
    // longer did anything.
    expect(page).toContain("{ maxRows: CHUNK_SCAN_MAX }");
    // A scan that threw knows nothing. Claiming it saw everything would put
    // the amber "nothing is indexed" panel over a read that failed.
    expect(page).toMatch(/catch \{[\s\S]*?setChunkCountsWhole\(false\);/);
  });

  it("refuses to turn a partial scan into a verdict", () => {
    // Each of these was a sentence asserted from the counts. Presence is not
    // use: the flag has to reach every one of them.
    expect(page).toContain("if (!chunkCountsWhole) {");
    expect(page).toContain("Index status unknown");
    expect(page).toContain("Index coverage could not be read in full for this collection.");
    // Matched as patterns, not as lines: prettier decides where a JSX guard
    // wraps, and an anchor that pins its own indentation breaks the next time
    // an unrelated edit makes the expression a character longer.
    expect(page).toMatch(
      /\{chunkCountsWhole &&\s+indexCoverage\.total > 0 &&\s+indexCoverage\.indexed === 0 &&/,
    );
    expect(page).toMatch(
      /runIndex\(\s*chunkCountsWhole && indexCoverage\.indexed >= indexCoverage\.total\s*\)/,
    );
  });
});
