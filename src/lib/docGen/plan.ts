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
      `"layout"?: "section"|"kpi"|"chart"|"table"|"twoColumn"|"bullets", ` +
      `"subtitle"?: string, "bullets"?: string[], "paragraph"?: string, ` +
      `"kpis"?: [{ "label": string, "value": string, "sql"?: string, "delta"?: string, "positive"?: boolean }], ` +
      `"chart"?: { "type": "column"|"bar"|"line"|"area"|"pie"|"doughnut", "dataSql"?: string, "categories"?: string[], "series"?: [{ "name": string, "values": number[] }] }, ` +
      `"table"?: { "columns": string[], "rows": (string|number|null)[][] }, ` +
      `"takeaway"?: string, "notes"?: string }] }\n` +
      `DATA IS COMPUTED FOR YOU — this is the most important rule:\n` +
      `- For EVERY chart, provide "dataSql": a read-only SELECT with GROUP BY over the DATA TABLES (use their exact SQL names + columns from CONTEXT), returning ≤ 12 rows where the FIRST column is the category label and the remaining numeric column(s) are the measure(s). The app runs it over the user's FULL data and fills the chart — so you do NOT need to hand-write categories/series (leave them out). Example: "SELECT region, SUM(revenue) AS revenue FROM sales GROUP BY region ORDER BY revenue DESC LIMIT 8".\n` +
      `- For EVERY KPI card, provide "sql": a scalar aggregate returning ONE number (e.g. "SELECT SUM(revenue) FROM sales", "SELECT COUNT(*) FROM sales", "SELECT ROUND(AVG(margin),1) FROM sales"). Put a reasonable placeholder in "value" too. SQL runs in an in-browser engine (SQLite/standard SQL — GROUP BY, SUM/AVG/COUNT/MIN/MAX, ORDER BY, LIMIT, CASE, date functions like strftime).\n` +
      `- Only reference tables/columns that appear in CONTEXT. If there are NO data tables, omit dataSql/sql and rely on the prompt.\n` +
      `LAYOUT RULES:\n` +
      `- 12–18 slides. The cover is generated from title/subtitle automatically — do NOT add a cover slide. "accent" is a hex colour without '#'.\n` +
      `- Open with a "kpi" slide (4–5 metric cards). Include AT LEAST 5 "chart" slides across the deck, varied by type — trend → line/area, comparison → column/bar, composition → pie/doughnut, ranking → bar. Prefer one clear chart per slide.\n` +
      `- Use 2–3 "section" divider slides to group the deck, and "twoColumn" slides (a chart with 2–4 explaining bullets) for analysis.\n` +
      `- Use a "table" only when exact figures matter; prefer charts + KPIs over tables and plain text.\n` +
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
