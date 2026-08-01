// The Google Sheets connector's parsing, and the sync runner's naming.
//
// Everything here is a case that real spreadsheets produce and a naive
// implementation gets wrong SILENTLY — a dropped column, two datasets
// overwriting each other — rather than by failing. None of it needs a network:
// the HTTP layer is thin, and these are the parts that decide whether the data
// is right.
import { describe, expect, it } from "vitest";

import { extractSpreadsheetId, normaliseHeader } from "@/utils/saas/googleSheets.server";
import { connectorFor, datasetNameFor } from "@/utils/saas/sync.server";
import { SAAS_LABELS, SAAS_PROVIDERS } from "@/utils/saas/types";

describe("extractSpreadsheetId", () => {
  it("takes the id out of the URL people actually copy", () => {
    expect(
      extractSpreadsheetId(
        "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBd/edit#gid=0",
      ),
    ).toBe("1BxiMVs0XRA5nFMdKvBd");
  });

  it("accepts a bare id", () => {
    expect(extractSpreadsheetId("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms")).toBe(
      "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    );
  });

  it("tolerates surrounding whitespace from a paste", () => {
    expect(extractSpreadsheetId("  1BxiMVs0XRA5nFMdKvBd  ")).toBe("1BxiMVs0XRA5nFMdKvBd");
  });

  it("rejects something that is neither, with a message that says what to paste", () => {
    // A 404 from Google would be the alternative, and it says nothing useful.
    expect(() => extractSpreadsheetId("my budget")).toThrow(/id or URL/i);
    expect(() => extractSpreadsheetId("")).toThrow();
  });
});

describe("normaliseHeader", () => {
  it("keeps ordinary headers as they are", () => {
    expect(normaliseHeader(["Region", "Revenue"])).toEqual(["Region", "Revenue"]);
  });

  it("names blank headers by position rather than colliding on empty string", () => {
    // Two blank headers both becoming "" would collapse into one column and
    // silently discard the first one's data.
    expect(normaliseHeader(["Region", "", "Revenue", ""])).toEqual([
      "Region",
      "column_2",
      "Revenue",
      "column_4",
    ]);
  });

  it("disambiguates duplicate headers instead of overwriting", () => {
    // A spreadsheet with two "Total" columns is normal. Building the row object
    // with both would keep only the last.
    expect(normaliseHeader(["Total", "Total", "Total"])).toEqual(["Total", "Total_2", "Total_3"]);
  });

  it("trims whitespace, which a header row is full of", () => {
    expect(normaliseHeader(["  Region  ", "Revenue "])).toEqual(["Region", "Revenue"]);
  });

  it("treats a whitespace-only header as blank", () => {
    expect(normaliseHeader(["   "])).toEqual(["column_1"]);
  });

  it("handles a null cell, which Sheets returns for an untouched header", () => {
    expect(normaliseHeader([null, undefined, "Revenue"])).toEqual([
      "column_1",
      "column_2",
      "Revenue",
    ]);
  });
});

describe("datasetNameFor", () => {
  it("prefixes with the connection so two sheets do not overwrite each other", () => {
    // The failure this prevents: both spreadsheets have a "Sheet1", a sync
    // REPLACES the dataset it names, so the second silently destroys the first.
    const a = datasetNameFor("Budget 2026", "Sheet1");
    const b = datasetNameFor("Headcount", "Sheet1");
    expect(a).not.toBe(b);
  });

  it("produces a valid SQL identifier", () => {
    const name = datasetNameFor("Q3 Budget (final)", "Rev / Cost");
    expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
  });

  it("does not start with a digit, which SQL would reject", () => {
    expect(datasetNameFor("2026 Plan", "Sheet1")).toMatch(/^[a-z_]/);
  });

  it("stays within a sane length", () => {
    expect(datasetNameFor("x".repeat(200), "y".repeat(200)).length).toBeLessThanOrEqual(62);
  });

  it("collapses runs of punctuation rather than emitting a row of underscores", () => {
    expect(datasetNameFor("A -- B", "C")).toBe("a_b_c");
  });
});

describe("the connector registry", () => {
  it("has a connector for every declared provider", () => {
    // A provider offered in the UI with no connector behind it fails at sync
    // time, after the user has already configured it.
    for (const p of SAAS_PROVIDERS) {
      expect(() => connectorFor(p), `${p} has no connector`).not.toThrow();
    }
  });

  it("labels every provider", () => {
    for (const p of SAAS_PROVIDERS) {
      expect(SAAS_LABELS[p]?.length, `${p} has no label`).toBeGreaterThan(0);
    }
  });

  it("refuses an unknown provider rather than returning undefined", () => {
    expect(() => connectorFor("dropbox" as never)).toThrow(/No connector/);
  });
});
