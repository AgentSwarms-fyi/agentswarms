// A BI report that could not be loaded said "Report not found", or nothing.
//
// FOUND IN R284, FIXED IN R296. Two shapes of one statement:
//
//   biReportGet   dropped its read's error, so a read that failed answered
//                 "Report not found" for a report that is there.
//   the page      never caught a call that failed outright. Driven with the
//                 report's request failing in the browser: the page stayed a
//                 skeleton for good, "Uncaught (in promise) TypeError: Failed
//                 to fetch" in the console, no message and no way to retry.
//
// The server function runs for real here, with the framework's builder and
// the admin client faked; the page is pinned.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  reply: { data: null as unknown, error: null as { message: string } | null },
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      inputValidator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => db.reply;
      return q;
    },
  },
}));

const { biReportGet } = await import("@/utils/biReports.functions");
const call = () =>
  (biReportGet as unknown as (o: { data: unknown }) => Promise<Record<string, unknown>>)({
    data: { accessToken: "t", id: "83538a80-b309-44aa-a56d-78cb087a6f50" },
  });

describe("biReportGet", () => {
  it("says a read that failed could not be read, not that the report is missing", async () => {
    db.reply = { data: null, error: { message: "canceling statement due to statement timeout" } };
    const res = await call();
    expect(res).toEqual({
      ok: false,
      error: "This report could not be read: canceling statement due to statement timeout",
    });
  });

  it("says a report is missing only when the read answered with no row", async () => {
    db.reply = { data: null, error: null };
    expect(await call()).toEqual({ ok: false, missing: true, error: "Report not found" });
  });

  it("returns a report that is there", async () => {
    db.reply = {
      data: { id: "r1", name: "Q3 pack", blocks: [], page: {}, updated_at: "2026-10-05" },
      error: null,
    };
    expect(await call()).toMatchObject({ ok: true, report: { id: "r1", name: "Q3 pack" } });
  });
});

describe("the BI report page", () => {
  const page = readFileSync("src/routes/_authenticated/bi_.report.$reportId.tsx", "utf8");

  it("catches a call that failed outright, and stops loading", () => {
    expect(page).toMatch(
      /try \{\s*res = await getFn\(\{ data: \{ accessToken: token, id: reportId \} \}\);\s*\} catch \(e\) \{\s*setLoadError\(`This report could not be loaded: \$\{\(e as Error\)\.message\}`\);\s*setLoading\(false\);\s*return;\s*\}/,
    );
  });

  it("tells a report it could not load from one that is missing", () => {
    expect(page).toContain('if (!("missing" in res && res.missing)) setLoadError(res.error);');
    const alert = page.slice(page.indexOf("if (!report && loadError) {"));
    expect(alert.indexOf("if (!report && loadError) {")).toBe(0);
    expect(alert.indexOf("{loadError}")).toBeLessThan(alert.indexOf("Report not found."));
  });

  it("offers Try again, which loads the report again", () => {
    expect(page).toContain("}, [getFn, signedIn, reportId, loadNonce]);");
    expect(page).toMatch(/setLoading\(true\);\s*setLoadNonce\(\(n\) => n \+ 1\);/);
  });
});
