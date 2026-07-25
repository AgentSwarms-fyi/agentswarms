// Shared plan schemas for AI-generated documents. An LLM plans one of these
// (grounded in the user's prompt + connected KB/table context); the per-format
// builders turn a plan into a real, fully-editable file.

export type DocFormat = "pptx" | "docx" | "xlsx";

export const DOC_FORMAT_LABEL: Record<DocFormat, string> = {
  pptx: "PowerPoint",
  docx: "Word",
  xlsx: "Excel",
};

/**
 * How much of the underlying data to pull into a generated artifact.
 * - `sample`: a capped preview (fast; a few dozen rows) — good for a quick draft.
 * - `full`: every row from the query, so the workbook is complete/authoritative.
 * Applies to Excel materialization and the chat BI widget's row snapshot.
 */
export type DocScope = "sample" | "full";

/** A simple tabular block reused across formats. */
export type DocTable = { columns: string[]; rows: (string | number | null)[][] };

/** A native (editable) chart embedded in a slide. */
export type DocChart = {
  type: "bar" | "column" | "line" | "area" | "pie" | "doughnut";
  /**
   * Read-only aggregation SQL over the connected tables (a GROUP BY returning a
   * small result, ≤~12 rows): the FIRST column becomes the categories and each
   * remaining numeric column becomes a series. When present the builder RUNS it
   * over the user's full hydrated data, so the chart is filled with real numbers
   * — strongly preferred over hand-written categories/series (which the model
   * can't derive reliably from a small sample).
   */
  dataSql?: string;
  categories?: string[];
  series?: { name: string; values: number[] }[];
};

// ── PowerPoint ────────────────────────────────────────────────────────────────
/** A big-number metric callout rendered as a card on a KPI slide. */
export type PptxKpi = {
  label: string;
  value: string;
  /**
   * Scalar-aggregate SQL returning ONE number over the connected tables
   * (e.g. `SELECT SUM(amount) FROM sales`). When present the builder runs it
   * over full data and formats the result into `value` — so the metric is real,
   * not a guess from the sample.
   */
  sql?: string;
  /** e.g. "+12%" or "-3.4pts". */
  delta?: string;
  /** Colours the delta green when true / omitted-with-a-"+", red otherwise. */
  positive?: boolean;
};

export type PptxSlide = {
  title: string;
  /**
   * Layout hint. The builder also infers from whichever fields are present, so
   * this is optional — but it drives the visual treatment (cover, section
   * divider, KPI cards, chart, table, two-column).
   */
  layout?: "cover" | "section" | "kpi" | "chart" | "table" | "bullets" | "twoColumn";
  subtitle?: string;
  bullets?: string[];
  paragraph?: string;
  table?: DocTable;
  chart?: DocChart;
  kpis?: PptxKpi[];
  /** One-line highlighted insight shown in an accent bar on data slides. */
  takeaway?: string;
  notes?: string;
};

export type PptxPlan = {
  title: string;
  subtitle?: string;
  /** Deck accent colour as a hex string, no leading "#" (e.g. "4F46E5"). */
  accent?: string;
  slides: PptxSlide[];
};

// ── Word ──────────────────────────────────────────────────────────────────────
export type DocxBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "table"; table: DocTable };
export type DocxPlan = { title: string; blocks: DocxBlock[] };

// ── Excel ─────────────────────────────────────────────────────────────────────
// A cell is a literal value or an editable formula (Excel A1 syntax, no leading
// "="), so a totals row like { formula: "SUM(B2:B10)" } stays live in the sheet.
// A formula cell may carry an optional Excel number-format string (e.g. currency).
export type XlsxCell = string | number | boolean | null | { formula: string; format?: string };

/**
 * A sheet the LLM authored with literal values (used when there's no table to
 * query, or for the sampled quick-draft path).
 */
export type XlsxLiteralSheet = { name: string; headers: string[]; rows: XlsxCell[][] };

/**
 * A per-row calculated column appended to a data sheet. `formula` is an Excel
 * A1-syntax template (no leading "="); the materializer resolves these tokens
 * against the real, generated row range:
 *   {col:Header} → that column's letter · {row} → the current data row number.
 * e.g. "{col:Quantity}{row}*{col:UnitPrice}{row}".
 */
export type XlsxComputedColumn = {
  header: string;
  formula: string;
  format?: "number" | "currency" | "percent";
};

/** A single summary/totals row appended below the data, with live formulas. */
export type XlsxTotalsRow = {
  /** Optional label placed in the first column (e.g. "Total"). */
  label?: string;
  /**
   * Per-column aggregate formulas. `column` is a header (data or computed);
   * `formula` is a template using {col:Header}/{first}/{last}, e.g.
   * "SUM({col:Revenue}{first}:{col:Revenue}{last})".
   */
  cells?: { column: string; formula: string }[];
};

/**
 * A data-bound sheet: the materializer runs `sourceSql` over the user's
 * hydrated tables (ALL rows in `full` scope, capped in `sample`), then appends
 * any computed columns + a totals row as live formulas over the real ranges.
 */
export type XlsxDataSheet = {
  name: string;
  sourceSql: string;
  computedColumns?: XlsxComputedColumn[];
  totals?: XlsxTotalsRow;
};

/** A plan sheet is either LLM-literal or data-bound (resolved at build time). */
export type XlsxSheet = XlsxLiteralSheet | XlsxDataSheet;
export type XlsxPlan = { sheets: XlsxSheet[] };

/** After materialization every sheet is literal (formula cells preserved). */
export type MaterializedXlsxPlan = { sheets: XlsxLiteralSheet[] };

export function isXlsxDataSheet(s: XlsxSheet): s is XlsxDataSheet {
  return typeof (s as XlsxDataSheet).sourceSql === "string";
}

export type DocPlan = PptxPlan | DocxPlan | XlsxPlan;
