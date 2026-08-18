// The audit log's merged window: complete down to a uniform boundary, or not
// shown at all.
//
// Module 24 of the adversarial pass. Three capped sources merged newest-first
// gave 400 rows to a window holding 1,922, and the caps were non-uniform in
// time — model.call reached back ~3 days while audit_events reached ~13. An
// auditor reading "no model calls on the 10th" off that table was reading the
// cap, not the record.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditWindowHeadline, trimToUniformWindow, uniformBoundary } from "@/lib/auditWindow";

const T = (d: number, h = 0) =>
  new Date(Date.UTC(2026, 7, d, h)).toISOString().replace(".000Z", "+00:00");

describe("uniformBoundary", () => {
  it("is the newest oldest-fetched among capped sources", () => {
    // traces capped with oldest at the 15th; events capped with oldest at the
    // 5th. The merged feed is only gap-free back to the 15th.
    expect(
      uniformBoundary([
        { oldest: T(5), capped: true },
        { oldest: T(15), capped: true },
        { oldest: T(2), capped: false },
      ]),
    ).toBe(T(15));
  });

  it("is null when no source hit its cap", () => {
    expect(
      uniformBoundary([
        { oldest: T(5), capped: false },
        { oldest: T(15), capped: false },
      ]),
    ).toBeNull();
  });

  it("ignores an uncapped source even when it is the newest", () => {
    // swarm_runs returned 24 rows, nowhere near its cap — its oldest row says
    // nothing about missing data and must not shrink the window.
    expect(
      uniformBoundary([
        { oldest: T(16), capped: false },
        { oldest: T(10), capped: true },
      ]),
    ).toBe(T(10));
  });

  it("handles empty sources", () => {
    expect(uniformBoundary([{ oldest: null, capped: false }])).toBeNull();
    // A capped source with no oldest cannot happen (cap implies rows), but if
    // it did, it must not produce a boundary of nothing.
    expect(uniformBoundary([{ oldest: null, capped: true }])).toBeNull();
  });
});

describe("trimToUniformWindow", () => {
  const rows = [T(20), T(15), T(10), T(5)].map((created_at) => ({ created_at }));

  it("drops rows older than the boundary", () => {
    expect(trimToUniformWindow(rows, T(10)).map((r) => r.created_at)).toEqual([
      T(20),
      T(15),
      T(10),
    ]);
  });

  it("keeps everything when the window is complete", () => {
    expect(trimToUniformWindow(rows, null)).toHaveLength(4);
  });
});

describe("auditWindowHeadline", () => {
  it("states the population for a complete window", () => {
    expect(auditWindowHeadline({ shown: 838, total: 838, boundary: null, windowDays: 7 })).toBe(
      "838 events over the last 7 days",
    );
  });

  it("singularises a one-day window", () => {
    expect(auditWindowHeadline({ shown: 80, total: 80, boundary: null, windowDays: 1 })).toBe(
      "80 events over the last 1 day",
    );
  });

  it("a trimmed window claims only what it shows, and says more exists", () => {
    const s = auditWindowHeadline({ shown: 492, total: 838, boundary: T(14), windowDays: 7 });
    expect(s).toMatch(/showing all 492 events since /);
    expect(s).toMatch(/holds 838/);
    expect(s).toMatch(/beyond the per-source fetch cap/);
    // Never "the most recent N" — a merged-then-sliced feed cannot honestly
    // claim recency ordering across capped sources.
    expect(s).not.toMatch(/most recent/);
  });
});

describe("wiring tripwires (limits stated)", () => {
  // Source tripwires, not behavioral proofs — the fn runs under createServerFn
  // and the component under a session, so executing either here would test
  // mocks. Both exist because a mutation run showed the exact defect each
  // pins surviving every behavioral test. They can be dodged by a determined
  // refactor; their job is to make the dodge visible in review.
  const read = (f: string) => readFileSync(resolve(f), "utf8");

  it("the server fn trims its merge to the uniform boundary", () => {
    const src = read("src/utils/audit.functions.ts");
    expect(src).toMatch(/uniformBoundary\(\[/);
    expect(src).toMatch(/trimToUniformWindow\(rows,\s*boundary\)/);
  });

  it("the UI's error branch outranks its empty state", () => {
    const src = read("src/components/observability/AuditLog.tsx");
    const errorBranch = src.indexOf("loadError !== null ? (");
    const emptyBranch = src.indexOf("filtered.length === 0 ? (");
    expect(errorBranch, "the error branch is gone").toBeGreaterThan(-1);
    expect(emptyBranch, "the empty state is gone").toBeGreaterThan(-1);
    // Order matters: JSX ternary chains evaluate top-down, so the empty
    // claim is only reachable when no error is held.
    expect(errorBranch).toBeLessThan(emptyBranch);
  });
});
