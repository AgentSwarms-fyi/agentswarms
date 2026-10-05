// An upload with a NUL character in one cell was not imported at all.
//
// FOUND IN R300. Rows and column definitions are stored as jsonb, Postgres
// cannot store U+0000 in jsonb, and it refuses the whole write over one.
// Driven: a three-row CSV with "pad\0ded" in one cell - the padding legacy
// exports are full of - came back "unsupported Unicode escape sequence", and
// no dataset was created. The character is removed at the row sink's door,
// before type inference and the distinct values a text column keeps, and the
// upload says in how many cells.
//
// The drive caught the first version: it cleaned in coerceRow, after the
// distinct values had been taken from the raw rows, and the upload still
// failed - on the column definition, not the rows.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cleanRow, inferColumns, withoutNul } from "@/lib/datasetParse";

describe("cleanRow", () => {
  it("removes NUL characters from text values, and counts the cells", () => {
    const cleaned = { nulCells: 0 };
    expect(cleanRow({ id: "2", label: "pad\u0000ded" }, cleaned)).toEqual({
      id: "2",
      label: "padded",
    });
    expect(cleanRow({ id: "3", label: "\u0000\u0000x\u0000" }, cleaned)).toEqual({
      id: "3",
      label: "x",
    });
    expect(cleaned.nulCells).toBe(2);
  });

  it("removes them from column names too", () => {
    const cleaned = { nulCells: 0 };
    expect(cleanRow({ "la\u0000bel": "ok" }, cleaned)).toEqual({ label: "ok" });
  });

  it("hands back a clean row untouched and uncounted", () => {
    const cleaned = { nulCells: 0 };
    const row = { id: 1, label: "clean", when: null };
    expect(cleanRow(row, cleaned)).toBe(row);
    expect(cleaned.nulCells).toBe(0);
  });

  it("leaves nothing for the column definitions to carry", () => {
    // A text column with few distinct values keeps them in its definition,
    // which is stored as jsonb as well.
    const cleaned = { nulCells: 0 };
    const raw = [
      { id: "1", label: "clean" },
      { id: "2", label: "pad\u0000ded" },
      { id: "3", label: "end" },
    ];
    // Uncleaned, the definition carries the NUL: this is the write that still
    // failed after the first version.
    expect(JSON.stringify(inferColumns(raw))).toContain("\\u0000");
    const rows = raw.map((r) => cleanRow(r, cleaned));
    expect(JSON.stringify(inferColumns(rows))).not.toContain("\\u0000");
    expect(cleaned.nulCells).toBe(1);
  });

  it("withoutNul removes every NUL and nothing else", () => {
    expect(withoutNul("a\u0000b\u0000")).toBe("ab");
    expect(withoutNul("plain")).toBe("plain");
  });
});

describe("the upload cleans at the door and says what it cleaned", () => {
  const ingest = readFileSync("src/utils/data/ingest.server.ts", "utf8");
  const route = readFileSync("src/routes/api/data.upload.ts", "utf8");
  const dialog = readFileSync("src/components/data-sql/CsvUploadDialog.tsx", "utf8");

  it("the row sink cleans every row before anything reads it", () => {
    const push = ingest.slice(ingest.indexOf("async push(input: Record<string, unknown>)"));
    expect(push.indexOf("const raw = cleanRow(input, this.cleaned);")).toBeGreaterThan(0);
    expect(push.indexOf("const raw = cleanRow(input, this.cleaned);")).toBeLessThan(
      push.indexOf("isMeaningfulRow(raw)"),
    );
    expect((ingest.match(/nulCellsCleaned: sink\.cleaned\.nulCells,/g) ?? []).length).toBe(2);
  });

  it("the route returns the count and the dialog shows it", () => {
    expect(route).toContain("nulCellsCleaned: result.nulCellsCleaned,");
    expect(dialog).toContain("nulCellsCleaned: body.nulCellsCleaned ?? 0,");
    expect(dialog).toContain("NUL characters removed from");
  });
});
