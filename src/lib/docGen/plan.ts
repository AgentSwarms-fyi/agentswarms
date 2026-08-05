// AI planners for document generation. Each turns a prompt + gathered context
// (data tables + KB excerpts) into a strict, typed plan via the existing
// JSON-mode LLM path (/api/bi through llmJson). The per-format builders in
// build.ts then produce the real file.
import { llmJson } from "@/lib/biAgent";
import type { DocContext } from "@/utils/docGen.functions";

import type { DocFormat, DocGenMode, DocScope, DocxPlan, PptxPlan, XlsxPlan } from "./types";

/** A trimmed slice of the chat so the document reflects the conversation. */
export type PlanConversationTurn = { role: "user" | "assistant"; content: string };

/** Exported for tests — the planner prompt's CONTEXT section, verbatim. */
export function contextBlock(ctx: DocContext): string {
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
  if (ctx.web?.length) {
    parts.push(
      "",
      "WEB RESEARCH (fetched live for this request — use these facts and figures, cite sources by name/URL where sensible):",
    );
    for (const w of ctx.web) {
      parts.push(`- ${w.title ?? w.url ?? "result"}${w.url ? ` <${w.url}>` : ""}`);
      // 3500, matching the scrape budget. At 2000 this re-truncated the excerpt
      // the fetcher had already chosen for containing the figures, from the
      // front — so a page fetched precisely because it held a rate table
      // arrived here without it.
      if (w.content) parts.push(`  ${w.content.slice(0, 3500)}`);
    }
    // Retrieval is not verification. Oracle's price list renders its rate cells
    // client-side, so the scrape carries the table with every price blank — and
    // the first workbook built from a SUCCESSFUL search still quoted $0.025 per
    // OCPU-hour "per current OCI Price List Compute table", a page it really
    // did read and which really does not contain that number.
    parts.push(
      "",
      "USING THE WEB RESEARCH — a figure is SOURCED only if it appears in the " +
        "text above. Quote it and name the result you took it from. If a number " +
        "you need is NOT in that text, you may still use a reasonable value, but " +
        "you MUST label it unverified/illustrative and MUST NOT attribute it to " +
        "any of these pages. Never cite a source for a figure it does not state. " +
        "Some pages render their prices in the browser and arrive here with the " +
        "table present and the cells empty — that is a missing figure, not a " +
        "reason to supply one from memory.",
    );
  }
  // Research was asked for and produced nothing. Say so, loudly. Staying quiet
  // here is what turned a request for live OCI pricing into a workbook of
  // invented unit prices with a "Sources (cite when presenting)" sheet full of
  // oracle.com links — the document read as researched, and nothing in it or
  // around it admitted otherwise.
  if (ctx.webAttempted && !ctx.web?.length) {
    parts.push(
      "",
      "WEB RESEARCH: ATTEMPTED AND RETURNED NOTHING." +
        (ctx.webNote ? ` Reason: ${ctx.webNote}` : "") +
        " You therefore have NO " +
        "live figures for this request. Do NOT present remembered or estimated " +
        "numbers as sourced, and do NOT cite URLs you did not receive above. " +
        "Use clearly-labelled placeholders or illustrative values, state in the " +
        "document that the figures are unverified and must be confirmed against " +
        "the vendor's current published pricing, and keep any formulas intact so " +
        "the reader can drop in real numbers.",
    );
  }
  if (!parts.length) parts.push("(No connected data — rely on the prompt and general knowledge.)");
  return parts.join("\n").slice(0, 18000);
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
  /**
   * Planning was mode-blind, so "Deep" only changed HOW the same deck was
   * rendered — same slide count, same diagram mix — which is most of why it
   * read as "Deep did nothing". Deep now commissions a substantially larger and
   * more varied deck; the slower renderer is the second half of the promise,
   * not all of it.
   */
  mode?: DocGenMode;
};

/** Deck size + variety brief — the bulk of what "Deep" actually buys. */
function deckBrief(mode: DocGenMode | undefined) {
  const deep = mode === "deep";
  return {
    slides: deep
      ? "24–30 slides — a comprehensive, board-grade deck"
      : "16–22 slides — a substantial, thorough deck (NOT a short one)",
    mix: deep
      ? '2 "kpi" slides (an opener and a mid-deck scorecard), 8–10 "chart"/"twoColumn" data slides, 10–14 "diagram" slides that between them use EVERY ONE of the 14 diagram kinds above at least once (and no kind more than twice), 4–5 "section" dividers, 1–2 "table" slides where exact figures matter, and a closing "bullets"'
      : '1 "kpi" opener, 6–7 "chart"/"twoColumn" (data), 6–8 "diagram" slides using AT LEAST 8 DIFFERENT diagram kinds from the list above (do not repeat the same kind more than twice), 3 "section" dividers, and a closing "bullets"',
    depth: deep
      ? '- GO DEEPER, not merely longer. Every data slide\'s "takeaway" must be a NON-OBVIOUS reading of the numbers — what changed, why it matters, what to do — never a restatement of the chart. Across the deck, cover the second-order angles a thorough analyst would raise: risks, sensitivities, assumptions, alternatives considered, what would falsify the conclusion, and what happens next. Give each diagram a DIFFERENT subject so no two make the same point.\n'
      : "",
    // ~30 slides of diagram JSON does not fit in 12k; truncation yields invalid
    // JSON and the whole plan is lost.
    maxTokens: deep ? 20000 : 12000,
  };
}

function userPrompt(args: PlanArgs): string {
  return `TASK: ${args.prompt}${conversationBlock(args.conversation)}\n\nCONTEXT:\n${contextBlock(
    args.context,
  )}`;
}

export async function planPptx(args: PlanArgs): Promise<PptxPlan> {
  const brief = deckBrief(args.mode);
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
      `DIAGRAM SLIDES — use these instead of plain bullet slides to make the deck look designed (each renders as a polished graphic with rounded cards, connectors, gradients, colours). Set "layout":"diagram" and provide "diagram" with one of these 12 kinds:\n` +
      `- process: { "kind":"process", "steps":[{ "title", "detail"? }] } — a linear workflow / how-it-works (3–5).\n` +
      `- timeline: { "kind":"timeline", "steps":[{ "title", "detail"?, "date"? }] } — dated milestones (3–6).\n` +
      `- roadmap: { "kind":"roadmap", "phases":[{ "title", "date"?, "items": string[] }] } — phased plan, each phase a column of items (2–5 phases).\n` +
      `- comparison: { "kind":"comparison", "columns":[{ "heading", "points": string[] }] } — options / vs / pros-cons (2–3 columns).\n` +
      `- matrix: { "kind":"matrix", "quadrants":[{ "title", "items"?: string[] }], "axisX"?:[string,string], "axisY"?:[string,string] } — a 2×2 (SWOT, priority, risk-vs-value); give EXACTLY 4 quadrants.\n` +
      `- cards: { "kind":"cards", "cards":[{ "title", "detail"? }] } — features / pillars / benefits (2–4).\n` +
      `- funnel: { "kind":"funnel", "stages":[{ "title", "value"? }] } — pipeline / conversion (3–6).\n` +
      `- pyramid: { "kind":"pyramid", "tiers":[{ "title", "detail"? }] } — hierarchy / maturity (3–5, base first).\n` +
      `- cycle: { "kind":"cycle", "steps":[{ "title", "detail"? }] } — a recurring/looping process (3–6).\n` +
      `- hierarchy: { "kind":"hierarchy", "root": string, "children":[{ "title", "detail"? }] } — org/tree, one root + 2–5 children.\n` +
      `- venn: { "kind":"venn", "sets":[{ "label" }], "overlap"?: string } — 2–3 overlapping concepts.\n` +
      `- kanban: { "kind":"kanban", "columns":[{ "title", "cards": string[] }] } — board columns (e.g. Now/Next/Later) of cards (2–4 columns).\n` +
      `- graph: { "kind":"graph", "nodes":[{ "id", "label", "group"? }], "edges":[{ "from", "to", "label"? }] } — an ARCHITECTURE / flowchart / block diagram; the renderer auto-lays out nodes into left→right layers and draws arrows. Use for "how it works / how components connect" (4–12 nodes; edge from/to reference node ids).\n` +
      `- sketch: { "kind":"sketch", "shapes":[ { "type":"box"|"ellipse", "x","y","w"?,"h"?, "label"?, "color"? } | { "type":"arrow", "x","y","x2","y2", "label"? } | { "type":"text", "x","y","label" } ] } — a FREEFORM illustration you compose yourself (excalidraw-style) when no structured type fits. Coordinates are 0–100 (percent of the canvas, x→right, y→down); "color" is a palette index 0–5. Place boxes and connect them with arrows to explain a concept, mechanism or relationship.\n` +
      `Whenever content is a sequence, comparison, matrix, roadmap, set of features, funnel, hierarchy, cycle, board, an architecture/flow, or a concept best drawn freely, use the matching diagram INSTEAD of a bullets slide. It's good to include ONE "graph" (architecture/flow) and, where a concept needs a custom picture, one "sketch".\n` +
      `LAYOUT RULES:\n` +
      `- ${brief.slides}. The cover is generated from title/subtitle automatically — do NOT add a cover slide. "accent" is a 6-hex-digit colour without '#', MEDIUM-to-DARK and saturated (e.g. "4F46E5", "0F766E", "B45309") — never a pale/near-white colour.\n` +
      `- MIX the layouts richly. Target roughly: ${brief.mix}.\n` +
      brief.depth +
      `- Charts varied by type — trend → line/area, comparison → column/bar, composition → pie/doughnut, ranking → bar.\n` +
      `- Use a "table" only when exact figures matter; prefer charts + KPIs + diagrams over plain text.\n` +
      `- Add a one-line "takeaway" insight to every data slide, and speaker "notes" to every slide.\n` +
      `- End with a "bullets" slide of key takeaways / recommended next steps. Keep bullets to short phrases (≤ ~12 words).`,
    userPrompt: userPrompt(args),
    model: args.model,
    temperature: 0.4,
    maxTokens: brief.maxTokens,
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
      `Write a THOROUGH, MULTI-PAGE report — not a short summary. Requirements:\n` +
      `- Start with an "Executive Summary" (level-1 heading + 2–3 paragraphs).\n` +
      `- Then 6–10 major sections, each a level-1 "heading" (these each start a new page) with 2–4 substantial prose paragraphs (3–6 sentences each), level-2 sub-headings where useful, and bullet lists. End with a "Conclusion / Recommendations" section.\n` +
      `- Include AT LEAST 3 tables where data helps (comparisons, breakdowns, metrics). Every table needs a clear header row ("columns") and MULTIPLE data rows (≥4 where possible); keep to 3–6 columns with concise cell values. Ground table numbers in the CONTEXT sample rows — never leave a table with one row or empty cells.\n` +
      `- Aim for enough content to fill several pages. Use real names/figures from CONTEXT and the CONVERSATION; write in a professional, analytical tone.`,
    userPrompt: userPrompt(args),
    model: args.model,
    temperature: 0.4,
    maxTokens: 12000,
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
      `• LITERAL (when NO listed table applies — e.g. figures from WEB RESEARCH, the conversation, or a KB summary): ` +
      `{ "name": string, "headers": string[], "rows": Array<Array<string|number|boolean|null|{ "formula": string }>> } ` +
      `where formulas use plain A1 refs (row 1 is the header, data starts at row 2). Literal sheets may still use ` +
      `formulas for line totals and roll-ups — prefer a formula over a hand-computed number.\n` +
      `HARD RULE: "sourceSql" may ONLY reference tables listed under DATA TABLES in CONTEXT, by their exact name. ` +
      `NEVER invent a table name. If the subject (e.g. an external vendor's pricing) is not covered by any listed ` +
      `table, build LITERAL sheets from WEB RESEARCH / the conversation instead — a working literal workbook beats ` +
      `a broken query.\n` +
      `LAYOUT RULES FOR LITERAL SHEETS — these decide whether the workbook still ` +
      `works after somebody edits it:\n` +
      `- A totals row must put each total in the SAME COLUMN as the values it sums. ` +
      `Pad the row with nulls to get there: a row labelled "Total" whose line-total ` +
      `column is G looks like ["Total", null, null, null, null, null, {"formula":"SUM(G2:G8)"}]. ` +
      `Writing that formula in column B instead puts the number under an unrelated ` +
      `heading and leaves G empty for anything that references it.\n` +
      `- A summary or roll-up sheet must REFERENCE the detail sheet, never restate ` +
      `its numbers: {"formula":"'Bill of Quantities'!K2"} or ` +
      `{"formula":"SUM('Bill of Quantities'!K2:K8)"}, not the literal 537.28. ` +
      `Copied numbers stop agreeing with the line items the moment a quantity changes, ` +
      `and a roll-up that silently disagrees with its own detail sheet is worse than ` +
      `no roll-up. Quote the sheet name exactly as you named it.\n` +
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
