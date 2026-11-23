// A result grid row is one line (R529). Found in the SQL workbench on a synced
// GitHub dataset: "10 rows" over an empty-looking table, because two long
// values made every row about 2,600 px tall.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CELL_FULL_CHARS,
  CELL_PREVIEW_CHARS,
  cellFull,
  cellPreview,
  valueText,
} from "@/lib/cellPreview";

const assets = JSON.stringify(
  Array.from({ length: 30 }, (_, i) => ({
    url: `https://api.github.com/repos/cli/cli/releases/assets/${i}`,
    name: `gh_2.105.0_linux_${i}.tar.gz`,
    uploader: { login: "github-actions[bot]", id: 41898282 },
    content_type: "application/gzip",
    download_count: 1000 + i,
  })),
);
const notes = Array.from({ length: 58 }, (_, i) => `* Change ${i} by @someone in #${i}`).join("\n");

describe("cellPreview", () => {
  it("leaves a short value as it is", () => {
    expect(cellPreview("v2.105.0")).toEqual({ text: "v2.105.0", clipped: false, length: 8 });
    expect(cellPreview(449359903)).toEqual({ text: "449359903", clipped: false, length: 9 });
  });

  it("shows a long value as one shortened line, and says so", () => {
    const p = cellPreview(assets);
    expect(p.clipped).toBe(true);
    expect(p.length).toBe(assets.length);
    expect(p.text.length).toBeLessThanOrEqual(CELL_PREVIEW_CHARS + 1);
    expect(p.text.endsWith("…")).toBe(true);
  });

  it("puts a value with line breaks on one line, and counts it as shortened", () => {
    const p = cellPreview(notes);
    expect(p.text).not.toMatch(/\n/);
    expect(p.clipped).toBe(true);
    expect(cellPreview("a\nb")).toEqual({ text: "a b", clipped: true, length: 3 });
    // A trailing newline alone hides nothing.
    expect(cellPreview("done\n").clipped).toBe(false);
  });

  it("never shows [object Object]", () => {
    expect(valueText({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
    expect(valueText({ n: 9007199254740993n })).toBe('{"n":"9007199254740993"}');
    expect(valueText(new Date("2026-11-23T16:14:12.000Z"))).toBe("2026-11-23T16:14:12.000Z");
    expect(cellPreview([1, 2]).text).toBe("[1,2]");
  });
});

describe("cellFull", () => {
  it("indents JSON, whether it came as an object or as text", () => {
    expect(cellFull('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(cellFull({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(cellFull("[not json")).toBe("[not json");
    expect(cellFull(notes)).toBe(notes);
  });

  it("caps what it shows", () => {
    const huge = "x".repeat(CELL_FULL_CHARS + 10);
    expect(cellFull(huge).length).toBe(CELL_FULL_CHARS + 1);
  });
});

describe("result grids", () => {
  const GRIDS = [
    "src/routes/_authenticated/data-sql.tsx",
    "src/routes/_authenticated/etl.tsx",
    "src/components/bi/BiBuildPreview.tsx",
    "src/components/bi/BiMetricSource.tsx",
    "src/components/bi/DataPrepTab.tsx",
    "src/components/data-sql/BiChatMessage.tsx",
  ];

  it.each(GRIDS)("%s shows each value through ResultValue", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("<ResultValue");
    expect(src).not.toMatch(/String\((row|r)\[(c|c\.name)\]\)\s*\)?\s*\}/);
  });
});
