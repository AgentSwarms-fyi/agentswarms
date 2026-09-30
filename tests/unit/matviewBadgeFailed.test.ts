// A materialized view's failed rebuild, said where people look (R185).
//
// FOUND IN R185 (left open by R101 at S3). Driven: analytics.r185_mv over
// analytics.r185_base; the base renamed; Rebuild → a toast, gone in seconds,
// and a badge that went on reading "materialized", the failure only in its
// hover title. After a reload the tab held no word of it, over rows from a
// rebuild whose source no longer existed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { matviewBadge } from "@/lib/matviewBadge";

const WHEN = (iso: string) => `at ${iso}`;
const ERROR =
  'Catalog Error: Table with name r185_base does not exist!\nDid you mean "r185_base_moved"?\n\nLINE 1: ...';
const view = (over: Partial<Parameters<typeof matviewBadge>[0]>) => ({
  schedule: "manual",
  last_status: "ok",
  last_error: null,
  last_refreshed_at: "2026-09-30T15:52:16Z",
  ...over,
});

describe("a rebuild that worked", () => {
  it("reads as the cadence, with no note", () => {
    expect(matviewBadge(view({}), WHEN)).toEqual({
      label: "materialized",
      failed: false,
      title: "Rebuilt manual",
      note: null,
    });
    expect(matviewBadge(view({ schedule: "hourly" }), WHEN).label).toBe("rebuilt hourly");
    expect(matviewBadge(view({ last_status: null }), WHEN).failed).toBe(false);
  });
});

describe("a rebuild that failed", () => {
  it("says so in the badge itself, whatever the schedule", () => {
    for (const schedule of ["manual", "daily"]) {
      const b = matviewBadge(view({ schedule, last_status: "error", last_error: ERROR }), WHEN);
      expect(b.failed).toBe(true);
      expect(b.label).toBe("last rebuild failed");
    }
  });

  it("gives the reason's first line and how old the rows are, and the whole error on hover", () => {
    const b = matviewBadge(view({ last_status: "error", last_error: ERROR }), WHEN);
    expect(b.note).toBe(
      "Catalog Error: Table with name r185_base does not exist! These rows are from the rebuild of at 2026-09-30T15:52:16Z.",
    );
    expect(b.title).toBe(`Last rebuild failed: ${ERROR}`);
  });

  it("ends the reason as a sentence, and says when there is none", () => {
    const timeout = matviewBadge(
      view({ last_status: "error", last_error: "HTTP 504 from the catalog" }),
      WHEN,
    );
    expect(timeout.note).toMatch(/^HTTP 504 from the catalog\. These rows/);
    const silent = matviewBadge(view({ last_status: "error", last_error: null }), WHEN);
    expect(silent.note).toMatch(/^No reason was recorded\. These rows/);
  });

  it("says when there are no older rows to fall back on", () => {
    const b = matviewBadge(
      view({ last_status: "error", last_error: ERROR, last_refreshed_at: null }),
      WHEN,
    );
    expect(b.note).toMatch(/The view has never been built\.$/);
  });
});

describe("the table's tab", () => {
  const page = readFileSync("src/routes/_authenticated/lakehouse.tsx", "utf8");
  it("takes its badge and note from matviewBadge", () => {
    expect(page).toMatch(/const matviewState = matview \? matviewBadge\(matview\) : null;/);
    expect(page).toMatch(/title=\{matviewState\.title\}/);
    expect(page).toMatch(/\{matviewState\.label\}/);
    expect(page).toMatch(
      /\{matviewState\?\.note && \(\s*<span className="text-\[11px\] text-destructive">\{matviewState\.note\}<\/span>/,
    );
    expect(page).toMatch(/matviewState\.failed\s*\?\s*"gap-1 border-destructive\/50/);
  });
});
