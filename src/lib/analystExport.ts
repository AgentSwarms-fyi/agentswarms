// Exporting an analysis as data rather than as a document.
//
// The PDF is for reading; this is for continuing the work in a spreadsheet.
// So the shape matters: an analysis is a question, several queries and their
// results, and flattening that into one sheet loses which rows answered which
// step — exactly the link that makes the numbers checkable.
//
// WHAT TRAVELS WITH THE ROWS. A spreadsheet leaves this app and gets mailed
// around, so everything that qualifies a number has to travel with it: which
// governed model compiled the step, what the self-check said, whether a human
// verified the analysis and whether that verdict still stands. Rows without
// those qualifiers are the same numbers stripped of every reason to doubt
// them.
//
// AND A SCENARIO IS NOT A RESULT. What-if rows are exported — omitting data
// the user asked to export is its own dishonesty — but on their own sheet,
// named as a scenario, with the assumption in the sheet's first column. A
// hypothetical that reaches a spreadsheet unlabelled becomes a measurement
// the moment someone copies it.
import { safeSheetName, type XlsxSheet } from "@/lib/exportData";
import { describeVerification, verificationStatus } from "@/lib/analystVerification";
import type { AnalystTurn } from "@/lib/aiAnalyst";

/**
 * Make every sheet name unique AFTER truncation.
 *
 * Excel rejects a workbook with duplicate sheet names, and two step goals
 * that differ only past character 31 truncate to the same thing — so
 * de-duplication has to happen against the truncated form, not the original.
 */
export function uniqueSheetNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const base = safeSheetName(raw);
    const key = base.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) return base;
    // Keep room for the suffix rather than letting the writer cut it off.
    const suffix = ` (${n + 1})`;
    return `${base.slice(0, 31 - suffix.length)}${suffix}`;
  });
}

/** The overview sheet: what was asked, what was concluded, and how far to trust it. */
export function summarySheet(args: {
  analystName: string;
  model: string;
  sourceText: string;
  turns: AnalystTurn[];
  /** Injectable so a test can pin it; defaults to now. */
  exportedAt?: Date;
}): XlsxSheet {
  const rows: Record<string, unknown>[] = [
    { Field: "Analyst", Value: args.analystName },
    { Field: "Model", Value: args.model },
    { Field: "Data", Value: args.sourceText },
    // A workbook outlives the query behind it. Without the date, rows that
    // were true in March get read as current in September.
    { Field: "Exported", Value: (args.exportedAt ?? new Date()).toLocaleString() },
  ];
  args.turns.forEach((t, i) => {
    const status = verificationStatus(t);
    rows.push({ Field: "", Value: "" });
    rows.push({ Field: `Q${i + 1}`, Value: t.question });
    if (t.approach) rows.push({ Field: "Approach", Value: t.approach });
    if (t.answer) rows.push({ Field: "Findings", Value: t.answer });
    if (t.answerStale) {
      rows.push({
        Field: "Caveat",
        Value: "The findings were written before a step was re-run.",
      });
    }
    const verdict = describeVerification(status);
    if (verdict) rows.push({ Field: "Verification", Value: verdict });
    t.steps.forEach((s, si) => {
      rows.push({
        Field: `Q${i + 1} step ${si + 1}`,
        Value:
          `${s.goal}` +
          (s.governed ? ` — compiled from governed model ${s.governed.model}` : "") +
          (s.check
            ? ` — check: ${s.check.verdict}${s.check.note ? ` (${s.check.note})` : ""}`
            : "") +
          (s.edited ? " — edited by hand" : ""),
      });
    });
  });
  return { name: "Analysis", columns: ["Field", "Value"], rows };
}

/**
 * One workbook: an overview, then a sheet per step result, then any scenarios.
 *
 * Steps with no rows are skipped rather than exported empty — an empty sheet
 * named after a step reads as "this query returned nothing", which is only
 * sometimes true and never distinguishable from "this step failed".
 */
export function analystWorkbook(args: {
  analystName: string;
  model: string;
  sourceText: string;
  turns: AnalystTurn[];
  exportedAt?: Date;
}): XlsxSheet[] {
  const sheets: XlsxSheet[] = [summarySheet(args)];
  const rawNames: string[] = ["Analysis"];

  args.turns.forEach((t, i) => {
    t.steps.forEach((s, si) => {
      if (s.rows?.length && s.columns?.length) {
        sheets.push({ name: "", columns: s.columns, rows: s.rows });
        rawNames.push(`Q${i + 1}S${si + 1} ${s.goal}`);
      }
      if (s.scenario?.rows?.length) {
        // The assumption rides in a column so it cannot be separated from the
        // numbers by sorting, filtering or a copy-paste.
        const label = s.scenario.label || "Scenario";
        sheets.push({
          name: "",
          columns: ["SCENARIO (not measured)", ...s.scenario.columns],
          rows: s.scenario.rows.map((r) => ({ "SCENARIO (not measured)": label, ...r })),
        });
        rawNames.push(`Q${i + 1}S${si + 1} scenario`);
      }
    });
  });

  const names = uniqueSheetNames(rawNames);
  return sheets.map((s, i) => ({ ...s, name: names[i] }));
}

/** A filename that says which analysis this was, safely. */
export function workbookFilename(title: string): string {
  const base = (title || "analysis")
    .replace(/[^\w\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${base.slice(0, 60) || "analysis"}`;
}
