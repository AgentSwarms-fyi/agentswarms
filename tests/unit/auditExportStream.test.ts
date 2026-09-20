// The audit export, and the one path that ended it without saying so.
//
// /api/audit/export streams the compliance trail as NDJSON so an enterprise can
// ship it to its own SIEM. It is careful nearly everywhere: superadmin only,
// invalid dates rejected rather than silently widening the range, one page per
// `pull` so backpressure is honest, and — the part that matters here — a
// mid-stream failure emits a final `{"_export_error": …}` line, with a comment
// saying exactly why: "so the consumer can tell a truncated export from a
// complete one".
//
// Then it closed on a short page:
//
//   if (data.length < PAGE) controller.close();
//
// That is the ONE exit that ends the stream without emitting the error line,
// and it fires whenever the server hands back fewer rows than asked for —
// `db-max-rows`, which belongs to whoever runs the database, not to this code.
// On a project tuned below PAGE the export closes after a single page and
// writes a file that is byte-for-byte a valid, complete-looking export of a
// fraction of the trail. For evidence, that is the worst available property:
// not missing, not erroring, just quietly less.
//
// Measured on this deployment: audit_events holds 2,010 rows, so a full export
// is three pages, and the failure needs only a cap below 1,000 to bite.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/routes/api/audit.export.ts", "utf8");

/**
 * The streaming loop, as the route runs it, against a table that clamps every
 * response like PostgREST does. Kept behavioural rather than source-anchored
 * because the fix is a DELETION, and "the line is gone" is the weakest possible
 * assertion about a deletion.
 */
async function drain(opts: {
  total: number;
  cap: number;
  page: number;
  /** The defect: end the stream when a page comes back short. */
  closeOnShortPage: boolean;
}) {
  const rows = Array.from({ length: opts.total }, (_, i) => ({ id: i }));
  const out: { id: number }[] = [];
  let from = 0;
  let closed = false;
  let requests = 0;
  while (!closed) {
    requests++;
    const data = rows.slice(from, from + Math.min(opts.page, opts.cap));
    if (data.length === 0) {
      closed = true;
      break;
    }
    out.push(...data);
    from += data.length;
    if (opts.closeOnShortPage && data.length < opts.page) closed = true;
  }
  return { out, requests };
}

describe("an export that stops early must say it stopped early", () => {
  it("writes a complete-looking file holding a third of the trail", async () => {
    // 2,010 audit events — the real count here — behind a server capped at 500.
    const { out } = await drain({ total: 2010, cap: 500, page: 1000, closeOnShortPage: true });

    expect(out).toHaveLength(500);
    // And nothing about it is distinguishable from a whole export: the lines
    // are well-formed, in order, and there is no error line, because the close
    // that fired is the one that does not emit one.
    expect(out.map((r) => r.id)).toEqual(Array.from({ length: 500 }, (_, i) => i));
  });

  it("reads the whole trail at any server cap once the short-page close is gone", async () => {
    for (const cap of [1, 7, 500, 999, 1000, 4096]) {
      const { out } = await drain({ total: 2010, cap, page: 1000, closeOnShortPage: false });
      expect(out, `cap ${cap}`).toHaveLength(2010);
      expect(new Set(out.map((r) => r.id)).size, `cap ${cap}`).toBe(2010);
    }
  });

  it("costs one extra request, and only where a page was actually short", async () => {
    // The whole price of the fix: an empty page to prove the end. An export
    // that already makes one request per page can afford one more.
    //
    // 1,500 rows is a full page and then a half one, so the old code stopped on
    // the short page and the new code asks once more.
    const short = await drain({ total: 1500, cap: 1000, page: 1000, closeOnShortPage: true });
    const honest = await drain({ total: 1500, cap: 1000, page: 1000, closeOnShortPage: false });
    expect(honest.requests).toBe(short.requests + 1);
    expect(honest.out).toHaveLength(1500);
    expect(short.out).toHaveLength(1500);

    // 2,000 rows is two full pages, so BOTH need the empty third to know they
    // are finished: the short-page close was never the thing ending that read,
    // which is why removing it is free in the common case.
    const evenShort = await drain({ total: 2000, cap: 1000, page: 1000, closeOnShortPage: true });
    const evenHonest = await drain({ total: 2000, cap: 1000, page: 1000, closeOnShortPage: false });
    expect(evenHonest.requests).toBe(evenShort.requests);
  });
});

describe("what the route actually does", () => {
  it("no longer closes the stream on a short page", () => {
    expect(SRC).not.toMatch(/if \(data\.length < PAGE\) controller\.close\(\)/);
  });

  it("still closes on an empty page, which is the only honest proof of the end", () => {
    expect(SRC).toMatch(/if \(!data \|\| data\.length === 0\) \{[\s\S]{0,80}controller\.close\(\)/);
  });

  it("still emits an error line when a page fails mid-stream", () => {
    // The property the short-page close was quietly bypassing.
    //
    // Pinned as the ENCODE EXPRESSION, not the key. `toContain("_export_error")`
    // was satisfied by the comment above the branch that explains the feature,
    // and a mutant that emitted a bare newline instead of the error object
    // survived it.
    expect(SRC).toMatch(/JSON\.stringify\(\{ _export_error: error\.message \}\)/);
    expect(SRC).toMatch(/if \(error\) \{/);
  });

  it("advances by the rows it received", () => {
    expect(SRC).toContain("from += data.length;");
    expect(SRC).not.toMatch(/from \+= PAGE/);
  });

  it("orders by a unique column as well as by time", () => {
    // Two events can share a timestamp, and offset paging over a non-unique
    // order can hand back one row twice and another never — in the file
    // someone opens precisely because they need to know which happened.
    expect(SRC).toContain(".order(spec.ts, { ascending: true })");
    expect(SRC).toContain('.order("id", { ascending: true })');
  });

  it("is still superadmin-only", () => {
    // Unrelated to the paging, and the reason this file is allowed to read
    // every user's activity at all.
    expect(SRC).toContain("requireSuperadmin");
    expect(SRC).toMatch(/if \(!guard\.ok\) return err\(guard\.error, 403\)/);
  });
});
