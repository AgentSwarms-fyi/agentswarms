// The 1000-row ceiling, and why totalling a single page is not a total.
//
// PostgREST caps a response at db-max-rows. Measured against the hosted project
// this repo points at, that ceiling is 1000 and it OVERRIDES the request:
// `.limit(5000)` and `.range(0, 2499)` each returned exactly 1000 rows. Nothing
// in the response says it was cut.
//
// dashboardOverview awaited such a query with no `.limit()` at all and summed
// what came back, so the dashboard reported $1.84 for a window whose real cost
// was $5.77. These tests drive the REAL selectAllPages against a fake that
// enforces the same ceiling, so the ceiling is what is being tested rather than
// a description of it.
import { describe, expect, it } from "vitest";

import { PAGE, selectAllPages } from "@/lib/pagedSelect";

/**
 * A PostgREST stand-in that enforces a hard server-side ceiling, exactly as the
 * real one does: it honours `from`, and silently clamps the page to `cap` rows
 * however many were asked for.
 */
function fakeTable(total: number, cap = PAGE) {
  let requests = 0;
  const rows = Array.from({ length: total }, (_, i) => ({ id: i, cost: 1 }));
  const build = () => ({
    range: async (from: number, to: number) => {
      requests++;
      const want = to - from + 1;
      return { data: rows.slice(from, from + Math.min(want, cap)), error: null };
    },
  });
  return { build, requests: () => requests };
}

describe("selectAllPages reads past the server's row ceiling", () => {
  it("returns every row when the table is larger than one page", async () => {
    const t = fakeTable(2169); // the real count measured on this instance
    const { rows, truncated } = await selectAllPages(t.build);

    expect(rows).toHaveLength(2169);
    expect(truncated).toBe(false);
    // The bug this replaces: one request, 1000 rows, a confident wrong total.
    expect(t.requests()).toBeGreaterThan(1);
  });

  it("sums to the real total, not to the first page", async () => {
    const t = fakeTable(2169);
    const { rows } = await selectAllPages<{ cost: number }>(t.build);
    const total = rows.reduce((s, r) => s + r.cost, 0);

    expect(total).toBe(2169);
    // The precise shape of the old failure: a plausible undercount.
    expect(total).not.toBe(PAGE);
  });

  it("stops on a short page instead of requesting forever", async () => {
    const t = fakeTable(1500);
    await selectAllPages(t.build);
    // 1000 + 500(short) — the short page ends it. A third request would mean
    // the exhaustion check is wrong.
    expect(t.requests()).toBe(2);
  });

  it("makes exactly one extra request when the total is a whole multiple", async () => {
    // The off-by-one case: 2000 rows is two FULL pages, so nothing signals the
    // end until an empty third page comes back.
    const t = fakeTable(2000);
    const { rows, truncated } = await selectAllPages(t.build);
    expect(rows).toHaveLength(2000);
    expect(truncated).toBe(false);
    expect(t.requests()).toBe(3);
  });

  it("reports truncation rather than silently returning a floor", async () => {
    const t = fakeTable(10_000);
    const { rows, truncated } = await selectAllPages(t.build, 3000);

    expect(rows).toHaveLength(3000);
    // The whole point: a capped read SAYS so. The old code could not, which is
    // why a 68% undercount rendered as an ordinary dollar figure.
    expect(truncated).toBe(true);
  });

  it("builds a fresh query per page", async () => {
    // Supabase query builders are single-use. Reusing one returns page 0 every
    // time, which looks identical to working and yields duplicate rows.
    const seen: number[] = [];
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
    const build = () => ({
      range: async (from: number, to: number) => {
        seen.push(from);
        return { data: rows.slice(from, to + 1), error: null };
      },
    });

    const out = await selectAllPages<{ id: number }>(build);
    expect(seen).toEqual([0, 1000, 2000]);
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(2500);
  });

  it("propagates an error instead of treating it as an empty page", async () => {
    // `data ?? []` on a failed query sums to zero, which is under every budget
    // cap — the failure mode 20260780000000 was written to kill.
    const build = () => ({
      range: async () => ({ data: null, error: { message: "statement timeout" } }),
    });
    await expect(selectAllPages(build)).rejects.toThrow("statement timeout");
  });
});
