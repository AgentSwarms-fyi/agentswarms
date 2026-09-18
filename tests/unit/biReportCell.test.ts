// The preview showed a number the PDF never prints.
//
// Found on an AI-generated paginated report over `saas_sales`: the "Top
// Products by Revenue" table read `410379.26499999943` — raw IEEE-754 noise —
// in the on-screen preview, while the exported PDF rendered the same cell as
// `410,379.26`. The PDF had a `cell()` formatter; the preview called
// `String(v)`.
//
// That is a contradiction of the preview's own stated purpose, which its file
// header spells out: it paginates with the same function the PDF uses,
// because "a preview that flowed differently would be a picture of a document
// nobody receives". Cell text is part of what a reader receives.
//
// One formatter now, used by both. Full digits with separators rather than
// the charts' compact "410.4k": a number in a table is there to be read
// exactly, which is the entire reason the table is paginated.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { reportCellText, reportColumnKinds } from "@/lib/biReports";

// Separators are the VIEWER's, deliberately — the same choice fmtBiValue
// makes, and the PDF is rendered in the same browser, so the two agree. These
// assertions therefore state the contract (rounded to 2 decimals, grouped by
// the viewer's locale) rather than one locale's punctuation; the CI runner
// here resolves to en-IN, which groups 1234567 as "12,34,567".
const asLocale = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(undefined, opts);

describe("a table cell in a report", () => {
  it("prints a float at two decimals, not its binary expansion", () => {
    // The exact values read off the broken preview.
    const out = reportCellText(410379.26499999943);
    expect(out).not.toContain("26499999943");
    expect(out).toBe(asLocale(410379.26, { maximumFractionDigits: 2 }));
    expect(reportCellText(114879.99629999997)).toBe(asLocale(114880, { maximumFractionDigits: 2 }));
    expect(reportCellText(3024.2799999999997)).toBe(
      asLocale(3024.28, { maximumFractionDigits: 2 }),
    );
  });

  it("keeps whole numbers whole, and grouped", () => {
    expect(reportCellText(1234567)).toBe(asLocale(1234567));
    // Grouped, whatever the locale's grouping happens to be.
    expect(reportCellText(1234567)).not.toBe("1234567");
    expect(reportCellText(0)).toBe("0");
    expect(reportCellText(-4200)).toBe(asLocale(-4200));
  });

  it("does not abbreviate — a checked row needs the digits", () => {
    // fmtBiNumber, which the charts use, would render this "410.4k".
    expect(reportCellText(410379.26)).not.toMatch(/k|M|B/);
  });

  it("says nothing rather than 'null' for an empty cell", () => {
    expect(reportCellText(null)).toBe("—");
    expect(reportCellText(undefined)).toBe("—");
    // An empty string is a value the query returned; it is not a missing one.
    expect(reportCellText("")).toBe("");
  });

  it("leaves text alone", () => {
    expect(reportCellText("ContactMatcher")).toBe("ContactMatcher");
    expect(reportCellText(true)).toBe("true");
  });
});

describe("a date column in a report table", () => {
  // The AI's "Monthly Revenue Summary" section had an `Order Date` column
  // whose every row read `1640995200000`. Formatting it as a NUMBER would
  // only have made it `1,640,995,200,000`; a date column has to print dates.
  const rows = [
    { order_date: 1640995200000, total: 13946.229 },
    { order_date: 1643673600000, total: 4810.558 },
    { order_date: 1646092800000, total: 55691.009 },
  ];
  const cols = ["order_date", "total"];

  it("recognises the date column and leaves the money column alone", () => {
    const kinds = reportColumnKinds(rows, cols);
    expect(kinds.order_date).toBe("date");
    expect(kinds.total).toBe("other");
  });

  it("prints each row's own date, not one bucket label for all of them", () => {
    // This is where a table parts company with a chart axis: an axis may
    // relabel a whole column to one grain, a table may not.
    const kinds = reportColumnKinds(rows, cols);
    expect(rows.map((r) => reportCellText(r.order_date, kinds.order_date))).toEqual([
      "2022-01-01",
      "2022-02-01",
      "2022-03-01",
    ]);
  });

  it("keeps the clock only when there is one to keep", () => {
    const midnight = [{ t: Date.UTC(2024, 2, 5) }];
    const stamped = [{ t: Date.UTC(2024, 2, 5, 14, 30) }];
    expect(reportColumnKinds(midnight, ["t"]).t).toBe("date");
    expect(reportColumnKinds(stamped, ["t"]).t).toBe("datetime");
    expect(reportCellText(stamped[0].t, "datetime")).toBe("2024-03-05 14:30");
  });

  it("does not group a year into a quantity", () => {
    // parseDateValue already reads 2026 as a year; a year is not 2,026.
    const years = [{ y: 2022 }, { y: 2023 }, { y: 2024 }];
    expect(reportColumnKinds(years, ["y"]).y).toBe("year");
    expect(reportCellText(2022, "year")).toBe("2022");
    // …while a four-digit COUNT is still a count.
    const counts = [{ n: 1500 }, { n: 42 }];
    expect(reportColumnKinds(counts, ["n"]).n).toBe("other");
  });

  it("falls back rather than blanking a cell it cannot parse", () => {
    expect(reportCellText("n/a", "date")).toBe("n/a");
    expect(reportCellText(null, "date")).toBe("—");
  });
});

describe("who formats the cells", () => {
  const preview = readFileSync("src/components/bi/ReportPagePreview.tsx", "utf8");
  const pdf = readFileSync("src/lib/biReportPdf.ts", "utf8");

  it("is the one shared function, on both surfaces", () => {
    // The defect was two implementations, not a wrong one. If either surface
    // grows its own again, the preview stops predicting the document.
    expect(preview).toContain("reportCellText");
    expect(pdf).toContain("reportCellText");
    // And no surface stringifies a cell behind its back.
    expect(preview).not.toMatch(/String\(r\[c\]\)/);
    expect(pdf).not.toMatch(/toLocaleString/);
  });
});
