// Asking a model to plan a PAGINATED report.
//
// The dashboard planner already knows how to look at a table and propose
// visuals; this reuses it wholesale — the same `describeSchema` text, the same
// JSON transport, the same per-widget build afterwards. What it adds is the
// shape a report has and a dashboard does not: an ordered narrative of
// SECTIONS, each with a heading and a body that is either a chart or a table
// that flows across pages.
//
// The distinction the prompt cares about most is chart versus table. A
// dashboard reaches for a chart almost always, because a chart is what a
// screen is good at. A printed report is read differently: the summary is a
// chart and the evidence behind it is a long table somebody will check a row
// of, which is precisely the content a scrolling dashboard cannot print.

import {
  describeSchema,
  ensureGovernedCatalog,
  llmJson,
  type LlmJsonFn,
  type SavedMetric,
  type SemanticEntry,
} from "@/lib/biAgent";
import type { DatasetMeta } from "@/lib/sqlEngine";

/** One section of the planned report. */
export type ReportSection = {
  heading: string;
  /** The analyst question whose answer this section shows. */
  question: string;
  /** How to present the answer: a visual, or rows somebody will read. */
  present: "chart" | "table";
  /** Proposed chart type when `present` is "chart". */
  chartType?: string;
  /** One line on why this section earns its page space. */
  rationale?: string;
  /** Start this section on a fresh page. */
  pageBreakBefore?: boolean;
};

export type ReportOutline = {
  title: string;
  /** Executive summary, rendered as the report's opening text block. */
  summary: string;
  sections: ReportSection[];
};

export const MAX_SECTIONS = 10;

/** Chart types a report page renders well. Deliberately narrower than a dashboard's. */
export const REPORT_CHART_TYPES = [
  "kpi",
  "bar",
  "hbar",
  "line",
  "area",
  "pie",
  "combo",
  "scatter",
  "waterfall",
  "treemap",
  "table",
] as const;

const SYSTEM = `You plan PAGINATED REPORTS: fixed-page documents that people print and read, not dashboards they scroll.

Return ONE JSON object:
{
  "title": "short report title",
  "summary": "2-4 sentence executive summary in markdown",
  "sections": [
    { "heading": "Section heading",
      "question": "the analyst question this section answers",
      "present": "chart" | "table",
      "chartType": "${REPORT_CHART_TYPES.join('" | "')}",
      "rationale": "one line: why this earns its page space",
      "pageBreakBefore": false }
  ]
}

Rules:
- 4 to ${MAX_SECTIONS} sections, ordered the way a reader meets them: headline numbers first, then the breakdown, then the detail.
- Use "present": "table" for the sections a reader will CHECK rather than glance at — line-level detail, exceptions, a ranked list. A printed report earns its format on those, and a table here flows across pages with its header repeated. At least one section should be a table when the data has row-level detail worth printing.
- Use "present": "chart" for shape and comparison. "chartType" is required then, and must be one of the listed types.
- Set "pageBreakBefore": true where a reader would expect a fresh page — typically before the first detail table.
- Every question must be answerable from the described columns alone. Never invent a column.
- Headings are title case, under 60 characters, and say what the section shows rather than restating the report title.`;

/**
 * Plan a report over one table.
 *
 * `llm` is injectable for the same reason the governed dashboard planner
 * takes one: a caller without a browser session has to supply its own
 * transport, and the reasoning should not care which it got.
 */
export async function suggestReportOutline(args: {
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  /** What the report is for, in the author's words. */
  goal?: string;
  model?: string;
  llm?: LlmJsonFn;
}): Promise<ReportOutline> {
  await ensureGovernedCatalog();
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const ask = args.llm ?? llmJson;
  const raw = await ask<{
    title?: string;
    summary?: string;
    sections?: Array<Record<string, unknown>>;
  }>({
    systemPrompt: SYSTEM,
    userPrompt:
      `${schema}\n\n` +
      (args.goal?.trim()
        ? `The report is for: ${args.goal.trim()}\n\n`
        : "No stated purpose — plan the report an analyst would hand to a manager who has not seen this data.\n\n") +
      "Plan the report.",
    model: args.model,
    temperature: 0.3,
    maxTokens: 2500,
    stage: "report",
  });
  return normalizeOutline(raw);
}

/**
 * Take whatever the model returned and keep only what can be built.
 *
 * Hand-rolled rather than schema-validated, to match the dashboard planner
 * beside it: a section with a bad chart type is repaired to a sensible one
 * rather than thrown away, because the question it asked is usually fine and
 * losing it costs the reader a section.
 */
export function normalizeOutline(raw: {
  title?: string;
  summary?: string;
  sections?: Array<Record<string, unknown>>;
}): ReportOutline {
  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.trim().slice(0, max) : "";
  const sections: ReportSection[] = [];
  for (const s of Array.isArray(raw.sections) ? raw.sections : []) {
    const question = str(s.question, 400);
    const heading = str(s.heading, 80) || str(s.question, 60);
    // A section with no question has nothing to run and nothing to show.
    if (!question || !heading) continue;
    const present = s.present === "table" ? "table" : "chart";
    let chartType = str(s.chartType, 40).toLowerCase();
    if (present === "chart" && !REPORT_CHART_TYPES.includes(chartType as never)) {
      // A type this renderer cannot draw becomes a bar chart rather than a
      // dropped section: the question is the expensive part.
      chartType = "bar";
    }
    sections.push({
      heading,
      question,
      present,
      chartType: present === "chart" ? chartType : undefined,
      rationale: str(s.rationale, 160) || undefined,
      pageBreakBefore: s.pageBreakBefore === true,
    });
    if (sections.length >= MAX_SECTIONS) break;
  }
  return {
    title: str(raw.title, 120) || "Report",
    summary: str(raw.summary, 2000),
    sections,
  };
}
