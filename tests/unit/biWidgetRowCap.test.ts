// The BI snapshot cap was a hardcoded 500 in TWO files — src/lib/biDashboards
// (the browser, which creates a widget's snapshot) and src/utils/bi/refresh
// (the server, which refills it on every scheduled refresh). Two constants
// that must agree and nothing making them: the same arrangement that let the
// warehouse read-only guard lose its mutation denylist, and the PII heuristic
// keep a stale mirror.
//
// It is now one configurable resolver. These tests pin the contract, and that
// the duplicate cannot come back.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WIDGET_ROW_CAP_DEFAULT,
  WIDGET_ROW_CAP_MAX,
  snapshotRows,
  widgetRowCap,
} from "@/lib/biDashboards";

const REFRESH = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
const CHAT_BI = readFileSync("src/lib/chatBi.ts", "utf8");

describe("the snapshot cap resolves", () => {
  // Stubbed rather than read from the ambient environment: a test that only
  // ever sees the default cannot tell a working knob from a dead one.
  afterEach(() => vi.unstubAllEnvs());

  it("falls back to the documented default when unset", () => {
    vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", "");
    expect(widgetRowCap()).toBe(WIDGET_ROW_CAP_DEFAULT);
    expect(WIDGET_ROW_CAP_DEFAULT).toBe(500);
  });

  it("uses a configured value", () => {
    vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", "2500");
    expect(widgetRowCap()).toBe(2500);
  });

  it("clamps to the ceiling instead of trusting the number", () => {
    expect(WIDGET_ROW_CAP_MAX).toBe(100_000);
    vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", "5000000");
    expect(widgetRowCap()).toBe(WIDGET_ROW_CAP_MAX);
  });

  it("ignores values that are not a usable count", () => {
    for (const bad of ["nonsense", "0", "-10", " "]) {
      vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", bad);
      expect(widgetRowCap(), `"${bad}" should fall back`).toBe(WIDGET_ROW_CAP_DEFAULT);
    }
    // A fractional value truncates rather than producing a fractional slice.
    vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", "1200.7");
    expect(widgetRowCap()).toBe(1200);
  });

  it("actually bounds a snapshot, at whatever the cap resolves to", () => {
    vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", "");
    const rows = Array.from({ length: WIDGET_ROW_CAP_DEFAULT + 250 }, (_, i) => ({ i }));
    expect(snapshotRows(rows).length).toBe(WIDGET_ROW_CAP_DEFAULT);

    // The knob is what decides — raise it and more rows survive.
    vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", "600");
    expect(snapshotRows(rows).length).toBe(600);

    // An explicit cap still wins — the refresh path passes one.
    expect(snapshotRows(rows, 10).length).toBe(10);
  });
});

describe("one definition, not two", () => {
  it("the server refresh reads the shared resolver instead of its own constant", () => {
    expect(REFRESH).toContain("widgetRowCap");
    expect(REFRESH, "a second hardcoded cap reappeared").not.toMatch(
      /const WIDGET_ROW_CAP\s*=\s*\d+/,
    );
  });

  it("the chat BI path resolves per call, not at module load", () => {
    // A `const X = widgetRowCap()` at module scope would freeze the value for
    // the process; the sample scope must ask each time.
    expect(CHAT_BI).toContain("widgetRowCap()");
    expect(CHAT_BI).not.toMatch(/SCOPE_ROW_CAP\s*:\s*Record/);
  });

  it("no source file hardcodes 500 as a widget cap any more", () => {
    for (const [file, text] of [
      ["refresh.server.ts", REFRESH],
      ["chatBi.ts", CHAT_BI],
    ] as const) {
      expect(text, `${file} still hardcodes the cap`).not.toMatch(/ROW_CAP\s*=\s*500/);
    }
  });
});
