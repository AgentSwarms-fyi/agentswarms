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

/**
 * How the file gets built. "fast" renders in the browser (instant, works on
 * every deploy). "deep" sends the filled plan to the optional server doc-gen
 * service — native Office toolchains + the AI render-verify loop — and falls
 * back to the browser build when the service isn't configured.
 */
export type DocGenMode = "fast" | "deep";

/** A simple tabular block reused across formats. */
export type DocTable = { columns: string[]; rows: (string | number | null)[][] };

/** A native (editable) chart embedded in a slide. */
export type DocChart = {
  type: "bar" | "column" | "line" | "area" | "pie" | "doughnut";
  /**
   * A natural-language analytical question — e.g. "monthly revenue for the last
   * 12 months" or "top 8 products by units sold". When present the builder runs
   * it through the BI analyst (the proven plan → SQL → execute pipeline) over
   * the user's REAL data and fills categories/series from the actual result.
   * This is the reliable path: the model describes what to chart, and the
   * numbers are computed here — never hand-written.
   */
  query?: string;
  /**
   * Fallback only (used when `query` is absent): raw read-only aggregation SQL
   * over the connected tables — first column = categories, remaining numeric
   * columns = series. Run verbatim over the hydrated data.
   */
  dataSql?: string;
  categories?: string[];
  series?: { name: string; values: number[] }[];
};

/**
 * A "SmartArt-style" diagram — a structured layout the builder renders as a
 * polished SVG (rounded cards, connectors, a multi-colour palette), so a slide
 * can be a process flow / timeline / comparison / card grid / funnel / pyramid
 * instead of a wall of bullets. The model supplies the structure; the renderer
 * (diagramSvg.ts) lays it out.
 */
export type DocDiagram =
  | { kind: "process"; steps: { title: string; detail?: string }[] }
  | { kind: "timeline"; steps: { title: string; detail?: string; date?: string }[] }
  | { kind: "comparison"; columns: { heading: string; points: string[] }[] }
  | { kind: "cards"; cards: { title: string; detail?: string }[] }
  | { kind: "funnel"; stages: { title: string; value?: string }[] }
  | { kind: "pyramid"; tiers: { title: string; detail?: string }[] }
  // 2×2 matrix / quadrant (SWOT, priority, BCG). Optional axis end-labels.
  | {
      kind: "matrix";
      quadrants: { title: string; items?: string[] }[];
      axisX?: [string, string];
      axisY?: [string, string];
    }
  // Phased roadmap — columns of phases, each with milestone items.
  | { kind: "roadmap"; phases: { title: string; date?: string; items: string[] }[] }
  // Circular / recurring process.
  | { kind: "cycle"; steps: { title: string; detail?: string }[] }
  // Simple hierarchy: one root with a row of children.
  | { kind: "hierarchy"; root: string; children: { title: string; detail?: string }[] }
  // 2–3 overlapping circles.
  | { kind: "venn"; sets: { label: string }[]; overlap?: string }
  // Kanban-style columns of cards.
  | { kind: "kanban"; columns: { title: string; cards: string[] }[] }
  // Node-and-edge graph (architecture / flowchart / block diagram) — the model
  // supplies nodes + edges and the renderer auto-lays them out in layers.
  | {
      kind: "graph";
      nodes: { id: string; label: string; group?: string }[];
      edges: { from: string; to: string; label?: string }[];
    }
  // Freeform "excalidraw-style" canvas: the model places primitive shapes on a
  // 0–100 × 0–100 grid to draw its own explanatory illustration.
  | { kind: "sketch"; shapes: SketchShape[] };

/** A primitive on a freeform sketch canvas. Coords are 0–100 (percent of the
 * drawing area); `color` is an optional palette index. */
export type SketchShape =
  | { type: "box"; x: number; y: number; w?: number; h?: number; label?: string; color?: number }
  | {
      type: "ellipse";
      x: number;
      y: number;
      w?: number;
      h?: number;
      label?: string;
      color?: number;
    }
  | { type: "text"; x: number; y: number; label: string }
  | { type: "arrow"; x: number; y: number; x2: number; y2: number; label?: string };

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
  layout?: "cover" | "section" | "kpi" | "chart" | "table" | "bullets" | "twoColumn" | "diagram";
  subtitle?: string;
  bullets?: string[];
  paragraph?: string;
  table?: DocTable;
  chart?: DocChart;
  kpis?: PptxKpi[];
  /** A SmartArt-style diagram (process / timeline / comparison / cards / funnel
   * / pyramid) rendered as a designed SVG instead of bullets. */
  diagram?: DocDiagram;
  /** Internal: the diagram pre-rendered to an SVG string, so the server-side
   * python-pptx renderer can rasterise it. Set by attachDiagramSvgs() at build
   * time; not authored by the model. */
  diagramSvg?: string;
  /**
   * For a KPI slide: a single analytical question that returns ONE row of
   * headline metrics (e.g. "total revenue, number of orders and average order
   * value"). The builder runs it through the BI analyst and turns each returned
   * column into a metric card — so every figure is real, not guessed. Any
   * `delta`/`positive` the model set on `kpis[i]` is carried over by position.
   */
  kpiQuery?: string;
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
export type MaterializedXlsxPlan = {
  sheets: XlsxLiteralSheet[];
  /**
   * Layout problems corrected during materialization, e.g. a column's total
   * written under a different column. Reported so a repair is visible rather
   * than silent — see alignColumnAggregates.
   */
  repairs?: string[];
};

export function isXlsxDataSheet(s: XlsxSheet): s is XlsxDataSheet {
  return typeof (s as XlsxDataSheet).sourceSql === "string";
}

export type DocPlan = PptxPlan | DocxPlan | XlsxPlan;
