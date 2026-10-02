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

describe("the server's ceiling is the operator's setting, not ours", () => {
  // `fakeTable` has always taken a `cap`, and nothing ever passed one below
  // PAGE. That is the whole finding: the loop's exhaustion test was
  // `page.length < what we asked for`, which reads EVERY page as the last one
  // as soon as the server hands back less than it was asked for. db-max-rows
  // belongs to whoever runs the database — a project tuned to 500, or a
  // self-hosted Supabase with a different postgrest.conf — and this module's
  // `truncated` flag is what the dashboard's spend panel renders as "partial".
  // So the failure mode was this module's own reassurance printed over the
  // undercount it exists to prevent.

  it("reads past a ceiling smaller than the page it asks for", async () => {
    const t = fakeTable(2500, 400);
    const { rows, truncated } = await selectAllPages(t.build);
    // The old loop: one request, 400 rows, truncated false, and a total 84% low.
    expect(rows).toHaveLength(2500);
    expect(truncated).toBe(false);
  });

  it("does not mistake a clamped first page for the whole table", async () => {
    const t = fakeTable(900, 300);
    const { rows, truncated } = await selectAllPages(t.build);
    expect(rows).toHaveLength(900);
    expect(truncated).toBe(false);
  });

  it("sums to the real total under a small ceiling", async () => {
    const t = fakeTable(2500, 400);
    const { rows } = await selectAllPages<{ cost: number }>(t.build);
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBe(2500);
  });

  it("costs the ordinary case nothing", async () => {
    // The rule is "shorter than a page the server has already produced", not
    // "shorter than requested", so the common path is unchanged: a full page
    // then a short one still ends the read in two requests.
    const t = fakeTable(1500);
    await selectAllPages(t.build);
    expect(t.requests()).toBe(2);
  });

  it("pays one extra request only when the very first page comes back short", async () => {
    // A first short page is genuinely ambiguous — the whole table, or the
    // server's cap exactly? One more request answers it, and that is the only
    // case where correctness costs a round trip.
    const t = fakeTable(300);
    const { rows, truncated } = await selectAllPages(t.build);
    expect(rows).toHaveLength(300);
    expect(truncated).toBe(false);
    expect(t.requests()).toBe(2);
  });

  it("does not call a filter of exactly maxRows a truncated read", async () => {
    // A caveat on a complete answer teaches readers to ignore caveats. The old
    // loop ran out of iterations and reported truncated: true on a whole read.
    const t = fakeTable(3000);
    const { rows, truncated } = await selectAllPages(t.build, 3000);
    expect(rows).toHaveLength(3000);
    expect(truncated).toBe(false);
  });

  it("reports truncation when the ceiling is not a whole number of pages", async () => {
    // A mutation survived without this. When maxRows is not a multiple of PAGE
    // the final window is NARROW by design, and a page that fills it is not
    // evidence of an end — it is the ceiling arriving. Reading it as exhaustion
    // returns truncated: false on a read that stopped short, which is the
    // original silent undercount at the boundary instead of at the cap.
    const t = fakeTable(10_000);
    const { rows, truncated } = await selectAllPages(t.build, 2500);
    expect(rows).toHaveLength(2500);
    expect(truncated).toBe(true);
  });

  it("propagates an error from the probe rather than guessing", async () => {
    // The probe decides `truncated`. Swallowing its failure would mean
    // guessing at the one flag this module exists to set.
    let calls = 0;
    const build = () => ({
      range: async (from: number, to: number) => {
        calls++;
        if (from >= 2000) return { data: null, error: { message: "statement timeout" } };
        return {
          data: Array.from({ length: Math.min(to - from + 1, 1000) }, (_, i) => ({ id: from + i })),
          error: null,
        };
      },
    });
    await expect(selectAllPages(build, 2000)).rejects.toThrow("statement timeout");
    expect(calls).toBeGreaterThan(1);
  });
});
