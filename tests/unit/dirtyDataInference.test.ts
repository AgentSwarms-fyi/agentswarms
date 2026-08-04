// What the app's type inference does with data that is not clean.
//
// The NL-to-SQL eval runs against fourteen tidy CSVs, byte-identical every
// run. That is right for measuring prompt changes and it says nothing about
// real customer data, so this measures the other half: does inferColumns /
// coerceRow do something defensible with the mess that actually arrives.
//
// Found by doing it: a leading zero was destroyed. Number("00123") is 123, so
// SKUs, ZIP codes, account numbers and phone extensions became integers. The
// value then no longer joins against its source, and "01002" rendered as 1002
// is a different postcode. It is the Excel bug people complain about,
// reproduced faithfully.
import Papa from "papaparse";
import { describe, expect, it } from "vitest";

import { coerceRow, inferColumns, inferType } from "@/lib/datasetParse";

function parse(csv: string) {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  const raw = parsed.data.filter((r) => r && Object.keys(r).length > 0);
  const cols = inferColumns(raw);
  return { cols, rows: raw.map((r) => coerceRow(r, cols)) };
}

describe("an identifier with a leading zero stays an identifier", () => {
  it("does not type it as a number", () => {
    expect(inferType("00123")).toBe("string");
    expect(inferType("01002")).toBe("string");
    expect(inferType("0700")).toBe("string");
  });

  it("keeps the zeros through coercion", () => {
    const { cols, rows } = parse(["sku,zip", "00123,01002", "00456,90210"].join("\n"));
    expect(cols.find((c) => c.name === "sku")?.type).toBe("string");
    expect(rows[0].sku, "the leading zero was destroyed").toBe("00123");
    expect(rows[0].zip).toBe("01002");
  });

  it("still treats genuine numbers as numbers", () => {
    // The fix must be narrow. A bare zero and a decimal below one are
    // quantities, and typing them as text would break every SUM and AVG over
    // a column that happens to contain them.
    expect(inferType("0")).toBe("number");
    expect(inferType("0.5")).toBe("number");
    expect(inferType("0.99")).toBe("number");
    expect(inferType("10")).toBe("number");
    expect(inferType("-4")).toBe("number");
    expect(inferType("1,234.56")).toBe("number");
  });

  it("still sums a column of real numbers", () => {
    // Quoted, because an unquoted thousands separator IS a CSV delimiter —
    // an unquoted "1,234.56" parses as two fields and the sum came to 1.5.
    const { cols, rows } = parse(["amount", "0", "0.5", '"1,234.56"'].join("\n"));
    expect(cols[0].type).toBe("number");
    expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(1235.06, 6);
  });
});

describe("the rest of the mess, measured rather than assumed", () => {
  // These are NOT assertions that the behaviour is ideal — several are
  // documented compromises. They are here so a change to any of them is a
  // deliberate decision rather than a surprise.
  const { cols, rows } = parse(
    [
      "amount_usd,accounting,pct,flag,notes",
      '"1,234.56",(500),45%,Y,café',
      '"2,000.00",(1200),7%,N,日本語',
    ].join("\n"),
  );
  const typeOf = (n: string) => cols.find((c) => c.name === n)?.type;

  it("parses thousands separators", () => {
    expect(typeOf("amount_usd")).toBe("number");
    expect(rows[0].amount_usd).toBeCloseTo(1234.56, 6);
  });

  it("leaves accounting negatives as text — they are not parsed", () => {
    // "(500)" means -500 in finance exports. Number("(500)") is NaN, so the
    // column is text and SUM over it returns nothing useful. Worth knowing
    // before someone points a dashboard at a finance export.
    expect(typeOf("accounting")).toBe("string");
    expect(rows[0].accounting).toBe("(500)");
  });

  it("leaves percentages as text", () => {
    expect(typeOf("pct")).toBe("string");
    expect(rows[0].pct).toBe("45%");
  });

  it("preserves unicode intact", () => {
    expect(rows[0].notes).toBe("café");
    expect(rows[1].notes).toBe("日本語");
  });

  it("does not turn Y/N into booleans", () => {
    expect(typeOf("flag")).toBe("string");
  });
});

describe("a slash date is typed as a date but never normalised", () => {
  // KNOWN GAP, recorded deliberately. inferType calls "01/02/2024" a date, and
  // coerceRow only converts real Date objects (which arrive from Excel) — so
  // the column's TYPE says date while its VALUE stays a non-ISO string.
  //
  // Two consequences: the schema handed to the model claims a date, and any
  // comparison is lexical, so "12/01/2023" sorts after "01/02/2024". Fixing it
  // needs a decision this test cannot make — DD/MM or MM/DD — and guessing
  // wrong silently corrupts every date rather than obviously breaking.
  const { cols, rows } = parse(["order_date", "01/02/2024", "12/01/2023"].join("\n"));

  it("types it as a date", () => {
    expect(cols[0].type).toBe("date");
  });

  it("but leaves the value an unparsed string", () => {
    expect(typeof rows[0].order_date).toBe("string");
    expect(rows[0].order_date).toBe("01/02/2024");
  });

  it("so ordering is lexical, and wrong", () => {
    // December 2023 precedes February 2024 in reality; as text it does not.
    const sorted = [...rows].sort((a, b) =>
      String(a.order_date).localeCompare(String(b.order_date)),
    );
    expect(
      sorted[0].order_date,
      "if this now sorts chronologically, slash dates are being normalised — update this test",
    ).toBe("01/02/2024");
  });

  it("handles ISO dates correctly, which is the supported path", () => {
    const iso = parse(["d", "2024-02-01", "2023-12-01"].join("\n"));
    expect(iso.cols[0].type).toBe("date");
    const sorted = [...iso.rows].sort((a, b) => String(a.d).localeCompare(String(b.d)));
    expect(sorted[0].d).toBe("2023-12-01");
  });
});
