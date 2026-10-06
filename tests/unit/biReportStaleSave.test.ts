// Two tabs on one BI report (R284, sweep 9). Save wrote the whole report over
// whatever was stored, so the later tab's Save silently undid blocks the
// earlier tab had saved. The save now lands only on the `updated_at` the page
// read or last saved; refused, the page says so and offers Reload or
// Overwrite with mine. Pinned by reading the server function and the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const server = read("src/utils/biReports.functions.ts");
const page = read("src/routes/_authenticated/bi_.report.$reportId.tsx");

describe("biReportSave", () => {
  it("updates only on the version the page read, when it sends one", () => {
    expect(server).toContain("expectedUpdatedAt: z.string().min(1).optional(),");
    expect(server).toMatch(
      /\.update\(patch\)\.eq\("id", data\.id\)\.eq\("user_id", userId\);\s*if \(data\.expectedUpdatedAt\) q = q\.eq\("updated_at", data\.expectedUpdatedAt\);/,
    );
    expect(server).toContain('await q.select("id, updated_at").maybeSingle();');
    expect(server).toContain(
      "return { ok: true, id: String(row.id), updatedAt: String(row.updated_at) };",
    );
  });

  it("tells a report that moved on from one that is gone", () => {
    expect(server).toMatch(
      /if \(data\.id && data\.expectedUpdatedAt\) \{[^]*?if \(stillError\) return \{ ok: false, error: stillError\.message \};\s*if \(still\) \{\s*return \{\s*ok: false,\s*stale: true,\s*error: "This report was changed in another tab or session after this page read it",/,
    );
    expect(server).toMatch(
      /\}\s*return \{ ok: false, error: "Report not found" \};\s*\}\s*return \{ ok: true/,
    );
  });
});

describe("the BI report page", () => {
  it("keeps the version it read and the one each save returns", () => {
    expect(page).toContain("versionRef.current = res.report.updated_at || null;");
    expect(page).toMatch(
      /\} else \{\s*versionRef\.current = res\.updatedAt;\s*setStale\(false\);\s*setSavedAs\(sent\);/,
    );
  });

  it("sends the version, except when asked to overwrite", () => {
    expect(page).toMatch(
      /\.\.\.\(overwrite\s*\? \{ overwrite: true as const \}\s*: \{ expectedUpdatedAt: versionRef\.current \?\? undefined \}\),/,
    );
    expect(page).toMatch(
      /if \(!res\.ok\) \{\s*if \(res\.stale\) setStale\(true\);\s*toast\.error\(res\.error\);/,
    );
  });

  it("says so, with Reload and Overwrite with mine", () => {
    expect(page).toMatch(/\{stale && \(\s*<div[^>]*data-testid="report-stale"/);
    expect(page).toMatch(/reloadingRef\.current = true;\s*window\.location\.reload\(\);/);
    expect(page).toMatch(/onClick=\{\(\) => void save\(true\)\}>\s*Overwrite with mine/);
    expect(page).toContain("enableBeforeUnload: () => unsaved && !reloadingRef.current,");
  });
});
