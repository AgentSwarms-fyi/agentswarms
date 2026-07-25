// AI planners for document generation. Each turns a prompt + gathered context
// (data tables + KB excerpts) into a strict, typed plan via the existing
// JSON-mode LLM path (/api/bi through llmJson). The per-format builders in
// build.ts then produce the real file.
import { llmJson } from "@/lib/biAgent";
import type { DocContext } from "@/utils/docGen.functions";

import type { DocFormat, DocxPlan, PptxPlan, XlsxPlan } from "./types";

function contextBlock(ctx: DocContext): string {
  const parts: string[] = [];
  if (ctx.tables.length) {
    parts.push("DATA TABLES (name — columns; then sample rows as JSON):");
    for (const t of ctx.tables) {
      parts.push(`- ${t.name} — [${t.columns.join(", ")}]`);
      if (t.sample.length) parts.push(`  sample: ${JSON.stringify(t.sample.slice(0, 8))}`);
    }
  }
  if (ctx.kb.length) {
    parts.push("", "KNOWLEDGE BASE EXCERPTS:");
    for (const k of ctx.kb) parts.push(`- (${k.name}) ${k.snippet}`);
  }
  if (!parts.length) parts.push("(No connected data — rely on the prompt and general knowledge.)");
  return parts.join("\n").slice(0, 12000);
}

const COMMON =
  "You are a document-authoring assistant. Ground the content in the provided CONTEXT (data tables + knowledge-base excerpts) — prefer real values from the sample rows, and never invent numbers that contradict them. Output ONLY valid JSON matching the requested schema exactly: no prose, no markdown code fences.";

function userPrompt(prompt: string, ctx: DocContext): string {
  return `TASK: ${prompt}\n\nCONTEXT:\n${contextBlock(ctx)}`;
}

export async function planPptx(args: {
  prompt: string;
  context: DocContext;
  model?: string;
}): Promise<PptxPlan> {
  return llmJson<PptxPlan>({
    systemPrompt:
      `${COMMON}\n` +
      `SCHEMA: { "title": string, "subtitle"?: string, "slides": [{ "title": string, ` +
      `"bullets"?: string[], "paragraph"?: string, ` +
      `"table"?: { "columns": string[], "rows": (string|number|null)[][] }, ` +
      `"chart"?: { "type": "bar"|"line"|"pie", "categories": string[], "series": [{ "name": string, "values": number[] }] }, ` +
      `"notes"?: string }] }\n` +
      `Produce 6–12 well-structured slides. Add a chart when the data supports a trend/comparison/breakdown. Use a table for detailed figures. Keep bullets concise.`,
    userPrompt: userPrompt(args.prompt, args.context),
    model: args.model,
    temperature: 0.4,
  });
}

export async function planDocx(args: {
  prompt: string;
  context: DocContext;
  model?: string;
}): Promise<DocxPlan> {
  return llmJson<DocxPlan>({
    systemPrompt:
      `${COMMON}\n` +
      `SCHEMA: { "title": string, "blocks": Array<` +
      `{ "type": "heading", "level": 1|2|3, "text": string } | ` +
      `{ "type": "paragraph", "text": string } | ` +
      `{ "type": "bullets", "items": string[] } | ` +
      `{ "type": "table", "table": { "columns": string[], "rows": (string|number|null)[][] } }> }\n` +
      `Write a complete, well-organized document with headings, prose paragraphs, bullet lists and tables where useful.`,
    userPrompt: userPrompt(args.prompt, args.context),
    model: args.model,
    temperature: 0.4,
  });
}

export async function planXlsx(args: {
  prompt: string;
  context: DocContext;
  model?: string;
}): Promise<XlsxPlan> {
  return llmJson<XlsxPlan>({
    systemPrompt:
      `${COMMON}\n` +
      `SCHEMA: { "sheets": [{ "name": string, "headers": string[], ` +
      `"rows": Array<Array<string | number | boolean | null | { "formula": string }>> }] }\n` +
      `Build a real spreadsheet: a header row plus data rows. For COMPUTED cells emit a live formula as ` +
      `{ "formula": "SUM(B2:B10)" } using Excel A1 syntax WITHOUT a leading "=". Reference actual cells ` +
      `(row 1 is the header, so data starts at row 2). Add a totals/summary row with SUM/AVERAGE formulas ` +
      `when it makes sense. Keep each row's length equal to headers.length.`,
    userPrompt: userPrompt(args.prompt, args.context),
    model: args.model,
    temperature: 0.3,
  });
}

export async function planDocument(
  format: DocFormat,
  args: { prompt: string; context: DocContext; model?: string },
): Promise<PptxPlan | DocxPlan | XlsxPlan> {
  if (format === "pptx") return planPptx(args);
  if (format === "docx") return planDocx(args);
  return planXlsx(args);
}
