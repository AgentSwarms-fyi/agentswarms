// AI planners for document generation. Each turns a prompt + gathered context
// (data tables + KB excerpts) into a strict, typed plan via the existing
// JSON-mode LLM path (/api/bi through llmJson). The per-format builders in
// build.ts then produce the real file.
import { llmJson } from "@/lib/biAgent";
import type { DocContext } from "@/utils/docGen.functions";

import type { DocFormat, DocScope, DocxPlan, PptxPlan, XlsxPlan } from "./types";

/** A trimmed slice of the chat so the document reflects the conversation. */
export type PlanConversationTurn = { role: "user" | "assistant"; content: string };

function contextBlock(ctx: DocContext): string {
  const parts: string[] = [];
  if (ctx.tables.length) {
    parts.push("DATA TABLES (SQL name — columns; then sample rows as JSON):");
    for (const t of ctx.tables) {
      parts.push(`- ${t.name} — [${t.columns.join(", ")}]`);
      // t.sample is already a JSON string of up to 8 rows (serialized server-side).
      if (t.sample && t.sample !== "[]") parts.push(`  sample: ${t.sample}`);
    }
  }
  if (ctx.kb.length) {
    parts.push("", "KNOWLEDGE BASE EXCERPTS:");
    for (const k of ctx.kb) parts.push(`- (${k.name}) ${k.snippet}`);
  }
  if (!parts.length) parts.push("(No connected data — rely on the prompt and general knowledge.)");
  return parts.join("\n").slice(0, 12000);
}

/** Format the recent chat turns so the LLM can carry them into the document. */
function conversationBlock(turns?: PlanConversationTurn[]): string {
  if (!turns || turns.length === 0) return "";
  const recent = turns.slice(-8).map((t) => {
    const who = t.role === "user" ? "User" : "Assistant";
    return `${who}: ${t.content.trim().slice(0, 800)}`;
  });
  return `\n\nCONVERSATION SO FAR (build on this — it's what the user was just discussing):\n${recent.join("\n")}`.slice(
    0,
    6000,
  );
}

const COMMON =
  "You are a document-authoring assistant. Ground the content in the provided CONTEXT (data tables + knowledge-base excerpts) and the CONVERSATION — prefer real values from the sample rows, and never invent numbers that contradict them. Output ONLY valid JSON matching the requested schema exactly: no prose, no markdown code fences.";

type PlanArgs = {
  prompt: string;
  context: DocContext;
  model?: string;
  scope?: DocScope;
  conversation?: PlanConversationTurn[];
};

function userPrompt(args: PlanArgs): string {
  return `TASK: ${args.prompt}${conversationBlock(args.conversation)}\n\nCONTEXT:\n${contextBlock(
    args.context,
  )}`;
}

export async function planPptx(args: PlanArgs): Promise<PptxPlan> {
  return llmJson<PptxPlan>({
    systemPrompt:
      `${COMMON}\n` +
      `You are designing a polished, executive-ready slide deck — rich with data-filled visuals, NOT walls of text.\n` +
      `SCHEMA: { "title": string, "subtitle"?: string, "accent"?: string, "slides": [{ ` +
      `"title": string, ` +
      `"layout"?: "section"|"kpi"|"chart"|"table"|"twoColumn"|"bullets"|"diagram", ` +
      `"subtitle"?: string, "bullets"?: string[], "paragraph"?: string, ` +
      `"kpiQuery"?: string, "kpis"?: [{ "label": string, "value": string, "delta"?: string, "positive"?: boolean }], ` +
      `"chart"?: { "type": "column"|"bar"|"line"|"area"|"pie"|"doughnut", "query"?: string }, ` +
      `"table"?: { "columns": string[], "rows": (string|number|null)[][] }, ` +
      `"diagram"?: <one diagram spec, see DIAGRAM SLIDES>, ` +
      `"takeaway"?: string, "notes"?: string }] }\n` +
      `HOW DATA WORKS — READ CAREFULLY. You do NOT write SQL and you do NOT invent numbers. Instead you write a plain-English analytical QUESTION for each visual, and a built-in BI analyst runs it against the user's REAL data (plan → SQL → execute) and fills the chart/metric with the actual result. This is the ONLY reliable way to get correct figures.\n` +
      `- For EVERY chart you MUST set "query": a precise question that yields a small grouped result — a category/time dimension plus one or more numeric measures. Examples: "monthly total revenue over the last 12 months", "top 8 products by units sold", "revenue share by region", "average order value by customer segment". Pick "type" to match: trend over time → line/area; comparison/ranking across categories → column/bar; part-of-whole (≤8 slices) → pie/doughnut. NEVER output "categories", "series" or "dataSql" — a chart with those but no "query" will come out EMPTY. Only "query" fills a chart.\n` +
      `- For a "kpi" slide, set "kpiQuery": ONE question returning a single row of 3–5 headline metrics, e.g. "total revenue, number of orders, average order value and gross margin". Each returned column becomes a metric card automatically. You may still list "kpis" with a "delta"/"positive" (e.g. "+12%") — those annotations are kept, but the numeric "value" is overwritten with the real figure.\n` +
      `- Reference the real subject matter from CONTEXT (table + column names) inside your questions so the analyst targets the right data. If there are NO data tables, omit query/kpiQuery and write the deck from the prompt + knowledge base.\n` +
      `- Keep each chart question to a SINGLE dimension + measure(s) so it charts cleanly (≤ ~12 categories).\n` +
      `NEVER LEAVE A SLIDE THIN — every "chart" and "twoColumn" slide MUST also include 2–4 short "bullets" (the analysis/context) AND a "takeaway". That way the slide is substantive even before the chart renders. Do not create a slide whose only content is a chart.\n` +
      `DIAGRAM SLIDES — use these instead of plain bullet slides to make the deck look designed (each renders as a polished graphic with rounded cards, connectors, colours). Set "layout":"diagram" and provide "diagram":\n` +
      `- process: { "kind":"process", "steps":[{ "title": string, "detail"?: string }] } — a workflow / how-it-works (3–5 steps).\n` +
      `- timeline: { "kind":"timeline", "steps":[{ "title": string, "detail"?: string, "date"?: string }] } — roadmap / milestones (3–6).\n` +
      `- comparison: { "kind":"comparison", "columns":[{ "heading": string, "points": string[] }] } — options / vs / pros-cons (2–3 columns, ≤6 points each).\n` +
      `- cards: { "kind":"cards", "cards":[{ "title": string, "detail"?: string }] } — features / pillars / benefits (2–4 cards).\n` +
      `- funnel: { "kind":"funnel", "stages":[{ "title": string, "value"?: string }] } — pipeline / conversion (3–6 stages).\n` +
      `- pyramid: { "kind":"pyramid", "tiers":[{ "title": string, "detail"?: string }] } — hierarchy / maturity levels (3–5).\n` +
      `Whenever content is a sequence of steps, a comparison, a set of features, a roadmap, a funnel or a hierarchy, use the matching diagram INSTEAD of a bullets slide.\n` +
      `LAYOUT RULES:\n` +
      `- 12–18 slides. The cover is generated from title/subtitle automatically — do NOT add a cover slide. "accent" is a 6-hex-digit colour without '#', MEDIUM-to-DARK and saturated (e.g. "4F46E5", "0F766E", "B45309") — never a pale/near-white colour.\n` +
      `- MIX the layouts for a professional feel — do NOT make every slide the same. Target roughly: 1 "kpi" opener, 5–6 "chart"/"twoColumn" (data), 3–4 "diagram" (process/comparison/cards/timeline/funnel/pyramid), 2–3 "section" dividers, and a closing "bullets".\n` +
      `- Charts varied by type — trend → line/area, comparison → column/bar, composition → pie/doughnut, ranking → bar.\n` +
      `- Use a "table" only when exact figures matter; prefer charts + KPIs + diagrams over plain text.\n` +
      `- Add a one-line "takeaway" insight to every data slide, and speaker "notes" to every slide.\n` +
      `- End with a "bullets" slide of key takeaways / recommended next steps. Keep bullets to short phrases (≤ ~12 words).`,
    userPrompt: userPrompt(args),
    model: args.model,
    temperature: 0.4,
  });
}

export async function planDocx(args: PlanArgs): Promise<DocxPlan> {
  return llmJson<DocxPlan>({
    systemPrompt:
      `${COMMON}\n` +
      `SCHEMA: { "title": string, "blocks": Array<` +
      `{ "type": "heading", "level": 1|2|3, "text": string } | ` +
      `{ "type": "paragraph", "text": string } | ` +
      `{ "type": "bullets", "items": string[] } | ` +
      `{ "type": "table", "table": { "columns": string[], "rows": (string|number|null)[][] } }> }\n` +
      `Write a complete, well-organized document with headings, prose paragraphs, bullet lists and tables where useful.`,
    userPrompt: userPrompt(args),
    model: args.model,
    temperature: 0.4,
  });
}

export async function planXlsx(args: PlanArgs): Promise<XlsxPlan> {
  const full = args.scope === "full";
  return llmJson<XlsxPlan>({
    systemPrompt:
      `${COMMON}\n` +
      `A sheet is EITHER data-bound OR literal:\n` +
      `• DATA-BOUND (STRONGLY PREFERRED whenever a relevant DATA TABLE exists): ` +
      `{ "name": string, "sourceSql": string, ` +
      `"computedColumns"?: [{ "header": string, "formula": string, "format"?: "number"|"currency"|"percent" }], ` +
      `"totals"?: { "label"?: string, "cells"?: [{ "column": string, "formula": string }] } }. ` +
      `"sourceSql" is a read-only SELECT over the DATA TABLES by their exact SQL name — it is executed for real and its ` +
      `${full ? "FULL result (every row)" : "sampled result"} fills the sheet, so DO NOT list data rows yourself. ` +
      `Select and alias the columns you want as headers. In "computedColumns" and "totals", formulas are Excel A1 ` +
      `templates WITHOUT a leading "=", using these tokens which the builder resolves against the real rows: ` +
      `{col:Header} = that column's letter, {row} = current data row number, {first}/{last} = first/last data row. ` +
      `Example computedColumn formula "{col:Quantity}{row}*{col:UnitPrice}{row}"; example totals cell ` +
      `"SUM({col:LineTotal}{first}:{col:LineTotal}{last})".\n` +
      `• LITERAL (only when NO table applies, e.g. a KB-derived summary): ` +
      `{ "name": string, "headers": string[], "rows": Array<Array<string|number|boolean|null|{ "formula": string }>> } ` +
      `where formulas use plain A1 refs (row 1 is the header, data starts at row 2).\n` +
      `SCHEMA: { "sheets": [ <data-bound or literal sheet> ] }\n` +
      `Design a genuinely useful workbook: e.g. a bill of materials = a line-items sheet (sourceSql over the pricing ` +
      `table, computed line totals) plus a summary sheet with monthly/annual roll-ups. Use multiple sheets when it helps.`,
    userPrompt: userPrompt(args),
    model: args.model,
    temperature: 0.3,
  });
}

export async function planDocument(
  format: DocFormat,
  args: PlanArgs,
): Promise<PptxPlan | DocxPlan | XlsxPlan> {
  if (format === "pptx") return planPptx(args);
  if (format === "docx") return planDocx(args);
  return planXlsx(args);
}
