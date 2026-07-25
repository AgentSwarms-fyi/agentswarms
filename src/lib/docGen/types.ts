// Shared plan schemas for AI-generated documents. An LLM plans one of these
// (grounded in the user's prompt + connected KB/table context); the per-format
// builders turn a plan into a real, fully-editable file.

export type DocFormat = "pptx" | "docx" | "xlsx";

export const DOC_FORMAT_LABEL: Record<DocFormat, string> = {
  pptx: "PowerPoint",
  docx: "Word",
  xlsx: "Excel",
};

/** A simple tabular block reused across formats. */
export type DocTable = { columns: string[]; rows: (string | number | null)[][] };

/** A native (editable) chart embedded in a slide. */
export type DocChart = {
  type: "bar" | "line" | "pie";
  categories: string[];
  series: { name: string; values: number[] }[];
};

// ── PowerPoint ────────────────────────────────────────────────────────────────
export type PptxSlide = {
  title: string;
  bullets?: string[];
  paragraph?: string;
  table?: DocTable;
  chart?: DocChart;
  notes?: string;
};
export type PptxPlan = { title: string; subtitle?: string; slides: PptxSlide[] };

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
export type XlsxCell = string | number | boolean | null | { formula: string };
export type XlsxSheet = { name: string; headers: string[]; rows: XlsxCell[][] };
export type XlsxPlan = { sheets: XlsxSheet[] };

export type DocPlan = PptxPlan | DocxPlan | XlsxPlan;
