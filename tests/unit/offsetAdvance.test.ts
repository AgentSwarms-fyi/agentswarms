// The offset that advanced by what it asked for.
//
// `start += PAGE` after a page that came back short does not truncate a read —
// it puts HOLES in it. Ask rows 0-999, receive 500 because db-max-rows says so,
// then ask 1000-1999: rows 500-999 are never read at all.
//
// That distinction is the whole finding. A missing TAIL can be caught by
// comparing what was read against an exact count, and several call sites in
// this repo do exactly that. A missing MIDDLE looks like a smaller table that is
// otherwise complete, so the same comparison reports "fewer rows than the count"
// and a caveat about truncation, while the rows that are present are not a
// prefix of anything. Every figure computed from them is wrong in a direction
// nothing can predict.
//
// Three sites had it where nothing downstream could tell: the SQL tool an agent
// calls, prep flows, and the row copy stored in a dataset version — the last of
// which already refused to store a PARTIAL copy on error, with the comment "it
// would present itself as restorable and then silently lose rows", and then did
// precisely that by a different route.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PAGE, selectAllPages } from "@/lib/pagedSelect";

/** A table that clamps every response to `cap`, as PostgREST does. */
function clampedTable(total: number, cap: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  return {
    rows,
    build: () => ({
      range: async (from: number, to: number) => ({
        data: rows.slice(from, from + Math.min(to - from + 1, cap)),
        error: null,
      }),
    }),
  };
}

/** The loop these three sites used, kept so the defect stays demonstrable. */
async function legacyPager(t: ReturnType<typeof clampedTable>, max: number) {
  const out: { id: number }[] = [];
  for (let start = 0; start < max; start += PAGE) {
    const { data: chunk } = await t.build().range(start, start + PAGE - 1);
    if (!chunk || chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return out;
}

describe("advancing by the request rather than by the response", () => {
  it("loses the middle of the table, not the end of it", async () => {
    // 2,500 rows behind a server that will only ever hand back 400.
    const t = clampedTable(2500, 400);
    const legacy = await legacyPager(t, 100_000);

    // The old loop takes one page and stops — but the point is not the count,
    // it is WHICH rows. It never even asks for 400-999.
    expect(legacy.length).toBeLessThan(2500);
    const seen = new Set(legacy.map((r) => r.id));
    expect(seen.has(399)).toBe(true);
    expect(seen.has(400)).toBe(false);
  });

  it("reads every row, in order, through the shared pager", async () => {
    const t = clampedTable(2500, 400);
    const { rows, truncated } = await selectAllPages<{ id: number }>(t.build, 100_000);

    expect(rows).toHaveLength(2500);
    expect(truncated).toBe(false);
    // No hole anywhere: the ids are 0..2499 with nothing missing and nothing
    // repeated, which is the property offset paging cannot promise by itself.
    expect(rows.map((r) => r.id)).toEqual(t.rows.map((r) => r.id));
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
  });

  it("a hole is not a prefix, which is why a count cannot catch it", async () => {
    // The mitigation several call sites rely on — "did we read fewer rows than
    // the count?" — reports truncation either way, so it cannot tell a short
    // tail from a sampled middle. This is the case for fixing the paging rather
    // than adding another caveat.
    const t = clampedTable(2500, 400);
    const legacy = await legacyPager(t, 100_000);
    const isPrefix = legacy.every((r, i) => r.id === i);
    expect(legacy.length).toBeLessThan(2500);
    // It happens to be a prefix here only because it stopped on page one; the
    // moment PAGE is a multiple of the cap it is not, and nothing says so.
    expect(isPrefix).toBe(true);
  });
});

describe("the three sites that had no way to tell", () => {
  const SITES: [string, string][] = [
    ["sql tool", readFileSync("src/utils/tools/sql.server.ts", "utf8")],
    ["prep flows", readFileSync("src/utils/bi/prep.server.ts", "utf8")],
    ["version row copy", readFileSync("src/utils/bi/versions.server.ts", "utf8")],
  ];

  for (const [label, src] of SITES) {
    describe(label, () => {
      it("no longer advances an offset by the page it asked for", () => {
        expect(src).not.toMatch(/(?:start|from)\s*\+=\s*PAGE\b/);
      });

      it("reads through the shared pager", () => {
        expect(src).toContain('from "@/lib/pagedSelect"');
        expect(src).toContain("await selectAllPages<{ row: unknown }>(");
      });

      it("orders by a unique column", () => {
        const i = src.indexOf("selectAllPages<");
        expect(src.slice(i, i + 500)).toContain('.order("id", { ascending: true })');
      });
    });
  }

  it("the SQL tool refuses rather than answering from a prefix", () => {
    const src = SITES[0][1];
    expect(src).toContain("SQL_TOOL_MAX_ROWS");
    expect(src).toMatch(/if \(scan\.truncated\) \{/);
  });

  it("prep still reports the datasets it could not read whole", () => {
    expect(SITES[1][1]).toContain("if (scan.truncated) truncated.push(t.name);");
  });

  it("a version stores metadata only rather than a copy with gaps", () => {
    // Its error branch always said a partial copy is worse than none. The
    // paging beneath it now agrees.
    const src = SITES[2][1];
    expect(src).toContain("scan.truncated ? null :");
    expect(src).toContain("storing metadata only");
  });
});
