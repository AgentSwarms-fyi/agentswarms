// The Sheets assistant's protocol: what the model may ask the workbook, and
// what it may propose. The model never writes a cell itself. It asks for
// reads (a range as shown, a formula computed by the workbook, a sheet's
// columns, where a text appears), which the browser answers from the
// workbook as it is on screen, unsaved edits included; and it ends with an
// answer and proposed actions the person applies with one click, each
// undoable.

import { z } from "zod";

export const MAX_TOOL_ROUNDS = 6;
export const MAX_READ_CELLS = 2000;
export const MAX_TOOL_CALLS = 4;

const cellValue = z.union([z.string().max(8192), z.number(), z.boolean(), z.null()]);
const a1 = z.string().max(40);
const sheet = z.string().max(100).optional();

export const assistToolSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("read_range"), sheet, range: a1 }),
  z.object({ tool: z.literal("evaluate"), sheet, formula: z.string().min(1).max(4000) }),
  z.object({ tool: z.literal("describe_sheet"), sheet: z.string().max(100) }),
  z.object({ tool: z.literal("find"), text: z.string().min(1).max(200), sheet }),
]);
export type AssistTool = z.infer<typeof assistToolSchema>;

export const CHART_KINDS = [
  "column",
  "bar",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "combo",
  "radar",
] as const;

export const assistActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_formula"),
    sheet,
    cell: a1,
    formula: z.string().min(1).max(8000),
    /** Fill the formula down to this row (1-based), as the fill handle would. */
    fill_to_row: z.number().int().min(1).max(1_048_576).optional(),
  }),
  z.object({
    kind: z.literal("set_values"),
    sheet,
    range: a1,
    values: z.array(z.array(cellValue).max(200)).max(2000),
  }),
  z.object({
    kind: z.literal("add_chart"),
    sheet,
    range: a1,
    chart: z.enum(CHART_KINDS),
    title: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal("highlight"),
    sheet,
    range: a1,
    /** An Excel formula for the range's first cell, e.g. =$C2<0.1 */
    formula: z.string().min(1).max(4000),
    color: z.enum(["red", "yellow", "green"]).optional(),
  }),
  z.object({
    kind: z.literal("new_sheet"),
    name: z.string().min(1).max(100),
    values: z.array(z.array(cellValue).max(200)).max(2000),
  }),
  z.object({
    kind: z.literal("format"),
    sheet,
    range: a1,
    number_format: z.string().min(1).max(255),
  }),
]);
export type AssistAction = z.infer<typeof assistActionSchema>;

export const assistReplySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tools"),
    thought: z.string().max(500).optional(),
    calls: z.array(assistToolSchema).min(1).max(MAX_TOOL_CALLS),
  }),
  z.object({
    type: z.literal("answer"),
    text: z.string().max(4000),
    actions: z.array(assistActionSchema).max(10).optional(),
  }),
]);
export type AssistReply = z.infer<typeof assistReplySchema>;

/** One turn of the conversation as the server sees it. */
export const assistMessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(60_000),
});
export type AssistMessage = z.infer<typeof assistMessageSchema>;

/**
 * The model's reply as a protocol object: the JSON it was asked for, found
 * even inside a code fence or prose; plain text becomes an answer.
 */
export function parseAssistReply(text: string): AssistReply {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.push(fence[1]);
  candidates.push(trimmed);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = assistReplySchema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch {
      /* not JSON; try the next reading */
    }
  }
  return { type: "answer", text: trimmed.slice(0, 4000) || "The assistant gave no answer." };
}

/** An action in plain words, for its card. */
export function describeAction(a: AssistAction): string {
  const on = (s?: string) => (s ? `${s}!` : "");
  switch (a.kind) {
    case "set_formula":
      return `Put ${a.formula} in ${on(a.sheet)}${a.cell}${a.fill_to_row ? ` and fill it down to row ${a.fill_to_row}` : ""}`;
    case "set_values":
      return `Write ${a.values.length} row${a.values.length === 1 ? "" : "s"} into ${on(a.sheet)}${a.range}`;
    case "add_chart":
      return `Add a ${a.chart} chart of ${on(a.sheet)}${a.range}${a.title ? ` titled "${a.title}"` : ""}`;
    case "highlight":
      return `Highlight ${on(a.sheet)}${a.range} ${a.color ?? "red"} where ${a.formula}`;
    case "new_sheet":
      return `Add a sheet "${a.name}" with ${a.values.length} row${a.values.length === 1 ? "" : "s"}`;
    case "format":
      return `Format ${on(a.sheet)}${a.range} as ${a.number_format}`;
  }
}

/** The question behind "Explain this formula": what it does, and what could break it. */
export const EXPLAIN_HINT =
  "Explain the formula in the active cell step by step in plain words (what each part looks up or adds), then say what could make it fail (a missing lookup value, a blank, a range that will not grow with the data). Propose an action only if there is a clear fix, and never the formula the cell already holds.";

/** The question behind "Fix this error": find the cause, propose the corrected formula. */
export const FIX_HINT =
  "The active cell shows an error. Find why (read the cells its formula refers to), then propose a corrected formula as a set_formula action and say in one sentence what was wrong.";

/**
 * Fill with AI's answers in input order, and how many it gave. A missing or
 * malformed answer is blank rather than shifting the rest into the wrong rows.
 * FOUND IN R135: the model answered `{"i": 0, "o": "negative"}, {"i": 1, …}`
 * without the brackets around it, and every row came back blank; the answers
 * are read wherever they stand.
 */
export function parseFillAnswer(text: string, n: number): { outputs: string[]; read: number } {
  const outputs = Array.from({ length: n }, () => "");
  let read = 0;
  const body = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const put = (item: unknown, k: number | null) => {
    if (item && typeof item === "object" && "i" in item && "o" in item) {
      const i = Number((item as { i: unknown }).i);
      if (Number.isInteger(i) && i >= 0 && i < n) {
        outputs[i] = String((item as { o: unknown }).o ?? "");
        read++;
      }
    } else if (k !== null && k < n && (typeof item === "string" || typeof item === "number")) {
      outputs[k] = String(item);
      read++;
    }
  };
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  let list: unknown = null;
  if (start >= 0 && end > start) {
    try {
      list = JSON.parse(body.slice(start, end + 1));
    } catch {
      list = null;
    }
  }
  if (Array.isArray(list)) list.forEach((item, k) => put(item, k));
  else {
    // The answers without the list around them: each {"i": …, "o": …} on its own.
    for (const m of body.matchAll(/\{[^{}]*\}/g)) {
      try {
        put(JSON.parse(m[0]), null);
      } catch {
        /* not an answer */
      }
    }
  }
  return { outputs, read };
}

/**
 * The column Fill with AI writes into unless told otherwise: the first one
 * right of the selection that is not already full. FOUND IN R137: it took the
 * first EMPTY column, so a column where the person had typed a header and a
 * first answer or two, as Flash Fill has them do, was skipped, and those
 * answers were never used as examples.
 */
export function fillTargetColumn(
  range: { r0: number; r1: number; c1: number },
  read: (row: number, col: number) => string,
): number {
  for (let c = range.c1 + 1; c < range.c1 + 50; c++) {
    for (let r = range.r0; r <= range.r1; r++) if (read(r, c) === "") return c;
  }
  return range.c1 + 1;
}

/**
 * What Fill with AI still has to ask after its trial. FOUND IN R138: the
 * trial showed "neutral" for a row as it "would be written", and the fill
 * asked the model again and wrote "positive". The trial's answers are the
 * ones written; only the rows it did not cover are asked.
 */
export function afterTrial<T extends { row: number }>(
  plan: T[],
  trial: { row: number; output: string }[] | null,
): { answers: { row: number; value: string }[]; rest: T[] } {
  const answers = (trial ?? []).map((t) => ({ row: t.row, value: t.output }));
  const tried = new Set(answers.map((a) => a.row));
  return { answers, rest: plan.filter((x) => !tried.has(x.row)) };
}
