// Upload format detection, schema inference and coercion.
//
// This module is shared by the browser CSV path and the streaming server
// ingest, so a change here silently changes what every uploaded dataset looks
// like. Ported from the verification script that proved it on release.
import { describe, expect, it } from "vitest";

import {
  coerceRow,
  detectFormat,
  inferColumns,
  inferType,
  isMeaningfulRow,
  normaliseHeaders,
  objectFromJson,
  safeTableName,
} from "@/lib/datasetParse";

describe("format detection", () => {
  it.each([
    ["a.csv", "csv"],
    ["A.CSV", "csv"],
    ["a.tsv", "tsv"],
    ["a.tab", "tsv"],
    ["a.ndjson", "ndjson"],
    ["a.jsonl", "ndjson"],
    ["a.json", "json"],
    ["a.xlsx", "xlsx"],
  ])("%s → %s", (name, expected) => {
    expect(detectFormat(name)).toBe(expected);
  });

  it("refuses legacy .xls rather than failing later with a parse error", () => {
    expect(detectFormat("book.xls")).toBeNull();
  });

  it("refuses unknown extensions", () => {
    expect(detectFormat("data.parquet")).toBeNull();
    expect(detectFormat("noextension")).toBeNull();
  });

  it("falls back to content type when the extension is unhelpful", () => {
    expect(detectFormat("download", "text/csv")).toBe("csv");
    expect(detectFormat("download", "application/json")).toBe("json");
  });
});

describe("header normalisation", () => {
  it("names blanks and de-duplicates collisions", () => {
    expect(normaliseHeaders(["id", "", "id", null, "id"])).toEqual([
      "id",
      "column_2",
      "id_2",
      "column_4",
      "id_3",
    ]);
  });

  it("trims whitespace", () => {
    expect(normaliseHeaders(["  name  "])).toEqual(["name"]);
  });
});

describe("schema inference", () => {
  it("unions keys across sample rows", () => {
    // JSON and NDJSON records routinely omit null fields; reading only the
    // first row would silently drop every column absent there.
    expect(inferColumns([{ a: 1 }, { b: "x" }, { c: "2026-01-01" }]).map((c) => c.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("types each column independently", () => {
    const cols = inferColumns([{ a: 1 }, { b: "x" }, { c: "2026-01-01" }]);
    expect(cols.find((c) => c.name === "a")?.type).toBe("number");
    expect(cols.find((c) => c.name === "b")?.type).toBe("string");
    expect(cols.find((c) => c.name === "c")?.type).toBe("date");
  });

  it("returns nothing for no rows", () => {
    expect(inferColumns([])).toEqual([]);
  });

  it.each([
    [1, "number"],
    ["2026-01-01", "date"],
    ["2026-01-01T10:00:00Z", "date"],
    ["1/2/2026", "date"],
    ["1,234", "number"],
    ["hello", "string"],
    ["", "string"],
  ])("infers %s as %s", (value, expected) => {
    expect(inferType(value)).toBe(expected);
  });
});

describe("coercion", () => {
  it("turns numeric strings into numbers so SUM works", () => {
    const cols = [{ name: "n", type: "number" as const }];
    expect(coerceRow({ n: "1,234" }, cols).n).toBe(1234);
  });

  it("maps empty values to null rather than empty string", () => {
    const cols = [{ name: "n", type: "string" as const }];
    expect(coerceRow({ n: "" }, cols).n).toBeNull();
    expect(coerceRow({ n: undefined }, cols).n).toBeNull();
  });

  it("keeps an unconvertible value instead of writing NaN", () => {
    const cols = [{ name: "n", type: "number" as const }];
    expect(coerceRow({ n: "abc" }, cols).n).toBe("abc");
  });

  it("renders a date-only Date as an ISO day", () => {
    const cols = [{ name: "d", type: "date" as const }];
    expect(coerceRow({ d: new Date("2026-03-04T00:00:00.000Z") }, cols).d).toBe("2026-03-04");
  });

  it("serialises nested structures instead of rendering [object Object]", () => {
    const cols = [{ name: "j", type: "string" as const }];
    expect(coerceRow({ j: { a: 1 } }, cols).j).toBe('{"a":1}');
  });

  it("drops columns that are not in the schema", () => {
    expect(Object.keys(coerceRow({ a: 1, b: 2 }, [{ name: "a", type: "number" }]))).toEqual(["a"]);
  });
});

describe("row and record guards", () => {
  it("an all-empty row is not meaningful", () => {
    expect(isMeaningfulRow({ a: null, b: "", c: undefined })).toBe(false);
    expect(isMeaningfulRow({ a: null, b: 0 })).toBe(true);
  });

  it("only JSON objects have columns", () => {
    expect(objectFromJson({ a: 1 })).toEqual({ a: 1 });
    expect(objectFromJson([1, 2])).toBeNull();
    expect(objectFromJson("x")).toBeNull();
    expect(objectFromJson(null)).toBeNull();
  });
});

describe("table names are safe SQL identifiers", () => {
  it.each([
    ["My Table", "my_table"],
    ["2026 sales", "t_2026_sales"],
    ["weird!!name", "weird_name"],
    ["", "t_table"],
    ["___", "t_table"],
  ])("%s → %s", (input, expected) => {
    expect(safeTableName(input)).toBe(expected);
  });

  it("truncates very long names", () => {
    expect(safeTableName("a".repeat(200)).length).toBeLessThanOrEqual(48);
  });
});
