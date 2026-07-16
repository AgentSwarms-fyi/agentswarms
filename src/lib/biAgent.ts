// BI Agent orchestrator — "Wren-style" GenBI pipeline.
//
// Runs entirely in the browser, calling our existing /api/chat endpoint with
// structured JSON-mode prompts. Pipeline:
//
//   1. PLAN — LLM reads the question + semantic layer → structured intent
//   2. SQL  — LLM writes a single SELECT constrained to known columns
//   3. EXEC — runs SQL through the existing browser AlaSQL engine (runQuery)
//   4. CHART — LLM picks chart type + axis fields
//   5. NARRATIVE — LLM writes a 2–3 sentence answer
//
// We keep the LLM calls small and JSON-only so they're fast and cheap.

import { supabase } from "@/integrations/supabase/client";
import { runQuery, type ColumnDef, type DatasetMeta, type QueryResult } from "@/lib/sqlEngine";

export type ColumnMeta = {
  description?: string;
  alias?: string;
  unit?: string;
};

export type SemanticEntry = {
  id: string;
  table_id: string;
  table_description: string | null;
  business_name: string | null;
  column_meta: Record<string, ColumnMeta>;
  primary_key: string | null;
  join_hints: { from: string; to: string; on: string }[];
  is_sample: boolean;
};

export type SavedMetric = {
  id: string;
  table_id: string | null;
  name: string;
  description: string | null;
  sql_expression: string;
  example_question: string | null;
};

export type ChartSpec =
  | { type: "table" }
  | { type: "kpi"; valueField: string; label?: string }
  | { type: "bar"; xField: string; yField: string; seriesField?: string }
  | { type: "line"; xField: string; yField: string; seriesField?: string }
  | { type: "pie"; nameField: string; valueField: string }
  | { type: "area"; xField: string; yField: string; seriesField?: string };

export type BiPlan = {
  intent: string;
  tables: string[];
  metrics: string[];
  breakdowns: string[];
  time_grain?: "day" | "week" | "month" | "quarter" | "year" | null;
  filters?: string[];
};

export type BiTurn = {
  question: string;
  plan?: BiPlan;
  sql?: string;
  result?: QueryResult;
  chart?: ChartSpec;
  narrative?: string;
  error?: string;
  status: "planning" | "writing_sql" | "executing" | "charting" | "summarizing" | "done" | "error";
};

// ── Lovable AI gateway via /api/bi (JSON-mode) ──────────────────────────────

async function llmJson<T>(opts: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
}): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const resp = await fetch("/api/bi", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      model: opts.model,
      temperature: opts.temperature,
    }),
  });

  const data = (await resp.json().catch(() => ({}))) as {
    result?: T;
    error?: string;
    raw?: string;
  };
  if (!resp.ok || !data.result) {
    throw new Error(data.error || `BI call failed (${resp.status})`);
  }
  return data.result;
}

// ── Schema description for the LLM ────────────────────────────────────────

function describeSchema(
  datasets: DatasetMeta[],
  semantics: Map<string, SemanticEntry>,
  metrics: SavedMetric[],
): string {
  const tableLines = datasets.map((d) => {
    const sem = semantics.get(d.id);
    const cols = d.columns
      .map((c) => describeColumn(c, sem?.column_meta?.[c.name]))
      .join(", ");
    const desc = sem?.table_description
      ? ` -- ${sem.table_description}`
      : d.is_sample
        ? " -- sample dataset"
        : "";
    return `TABLE ${d.name} (${cols})${desc}`;
  });

  const metricLines = metrics
    .filter((m) => m.sql_expression)
    .map(
      (m) =>
        `- ${m.name}: ${m.sql_expression}${m.description ? `  // ${m.description}` : ""}`,
    );

  const joinLines: string[] = [];
  semantics.forEach((s) => {
    for (const h of s.join_hints || []) {
      joinLines.push(`- ${h.from} JOIN ${h.to} ON ${h.on}`);
    }
  });

  return [
    "AVAILABLE TABLES:",
    ...tableLines,
    metricLines.length ? "\nSAVED METRICS (use these formulas verbatim):" : "",
    ...metricLines,
    joinLines.length ? "\nJOIN HINTS:" : "",
    ...joinLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function describeColumn(c: ColumnDef, meta?: ColumnMeta): string {
  const parts = [c.name, c.type];
  if (meta?.alias) parts.push(`alias="${meta.alias}"`);
  if (meta?.unit) parts.push(`unit=${meta.unit}`);
  if (meta?.description) parts.push(`-- ${meta.description}`);
  return parts.join(" ");
}

// ── Pipeline steps ───────────────────────────────────────────────────────

export async function planQuestion(args: {
  question: string;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
}): Promise<BiPlan> {
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const plan = await llmJson<BiPlan>({
    systemPrompt:
      "You are a BI planning agent. Read the user's question and the schema, then output a structured plan as JSON. " +
      "Only use tables and columns that exist in the schema. Be precise.",
    userPrompt: `${schema}\n\nQUESTION: ${args.question}\n\nReturn JSON with this exact shape:\n{\n  "intent": "short description of what the user wants",\n  "tables": ["table_name"],\n  "metrics": ["metric or aggregation"],\n  "breakdowns": ["column to group by"],\n  "time_grain": "day|week|month|quarter|year|null",\n  "filters": ["plain-English filters"]\n}`,
  });
  return plan;
}

export async function generateSql(args: {
  question: string;
  plan: BiPlan;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
}): Promise<string> {
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const out = await llmJson<{ sql: string }>({
    systemPrompt:
      "You are a SQL generation agent for an in-browser AlaSQL engine. " +
      "Output a SINGLE SELECT statement only — no INSERT/UPDATE/DELETE/DDL. " +
      "Use only tables and columns from the provided schema. " +
      "Wrap identifiers with spaces or special chars in backticks. " +
      "Prefer aggregates (SUM/AVG/COUNT) for analytical questions. " +
      "Always add ORDER BY for rankings, and LIMIT 50 if the result might be large.",
    userPrompt: `${schema}\n\nPLAN: ${JSON.stringify(args.plan)}\nQUESTION: ${args.question}\n\nReturn JSON: { "sql": "SELECT ..." }`,
  });
  return out.sql;
}

export async function suggestChart(args: {
  question: string;
  result: QueryResult;
  plan: BiPlan;
}): Promise<ChartSpec> {
  if (args.result.row_count === 0) return { type: "table" };
  if (args.result.row_count === 1 && args.result.columns.length === 1) {
    return {
      type: "kpi",
      valueField: args.result.columns[0],
      label: args.plan.intent,
    };
  }
  const sample = args.result.rows.slice(0, 5);
  const out = await llmJson<ChartSpec>({
    systemPrompt:
      "You pick the best chart for a SQL result. Output JSON only. " +
      "Allowed types: 'bar','line','pie','area','kpi','table'. " +
      "For time-series use 'line' or 'area'. For categorical comparisons use 'bar'. " +
      "For part-of-whole with ≤8 rows use 'pie'. Use 'kpi' only for single-value results. " +
      "Otherwise default to 'table'. xField/yField/nameField/valueField MUST be exact column names from the data.",
    userPrompt: `QUESTION: ${args.question}\nINTENT: ${args.plan.intent}\nCOLUMNS: ${args.result.columns.join(", ")}\nSAMPLE ROWS: ${JSON.stringify(sample)}\nROW COUNT: ${args.result.row_count}\n\nReturn JSON like { "type": "bar", "xField": "...", "yField": "..." }`,
  });
  return out;
}

export async function summarizeResult(args: {
  question: string;
  result: QueryResult;
  plan: BiPlan;
}): Promise<string> {
  if (args.result.row_count === 0) return "The query returned no rows.";
  const sample = args.result.rows.slice(0, 10);
  const out = await llmJson<{ summary: string }>({
    systemPrompt:
      "You summarize SQL query results in 2–3 short sentences for a business user. " +
      "Lead with the headline number. Round large numbers (e.g. $1.2M, 3.4k). " +
      "Do NOT show SQL or column names verbatim — speak naturally.",
    userPrompt: `QUESTION: ${args.question}\nROWS (sample): ${JSON.stringify(sample)}\nTOTAL ROWS: ${args.result.row_count}${args.result.capped ? " (truncated)" : ""}\n\nReturn JSON: { "summary": "..." }`,
  });
  return out.summary;
}

// ── Suggested questions for a dataset ──────────────────────────────────

export async function generateSuggestedQuestions(args: {
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
}): Promise<string[]> {
  if (args.datasets.length === 0) return [];
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const out = await llmJson<{ questions: string[] }>({
    systemPrompt:
      "Suggest 4 specific, business-relevant questions a user could ask about this data. " +
      "Each question must be answerable with a single SQL query against the schema. " +
      "Mix question types: ranking, totals, time-comparison, breakdowns. Keep each ≤ 12 words.",
    userPrompt: `${schema}\n\nReturn JSON: { "questions": ["...", "...", "...", "..."] }`,
  });
  return (out.questions || []).slice(0, 4);
}

// ── Orchestrator ───────────────────────────────────────────────────────

export async function runBiTurn(args: {
  question: string;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  onUpdate: (turn: BiTurn) => void;
}): Promise<BiTurn> {
  let turn: BiTurn = { question: args.question, status: "planning" };
  args.onUpdate({ ...turn });
  try {
    turn.plan = await planQuestion({
      question: args.question,
      datasets: args.datasets,
      semantics: args.semantics,
      metrics: args.metrics,
    });
    turn.status = "writing_sql";
    args.onUpdate({ ...turn });

    turn.sql = await generateSql({
      question: args.question,
      plan: turn.plan,
      datasets: args.datasets,
      semantics: args.semantics,
      metrics: args.metrics,
    });
    turn.status = "executing";
    args.onUpdate({ ...turn });

    turn.result = runQuery(turn.sql);
    turn.status = "charting";
    args.onUpdate({ ...turn });

    const [chart, narrative] = await Promise.all([
      suggestChart({ question: args.question, result: turn.result, plan: turn.plan }),
      summarizeResult({ question: args.question, result: turn.result, plan: turn.plan }),
    ]);
    turn.chart = chart;
    turn.narrative = narrative;
    turn.status = "done";
    args.onUpdate({ ...turn });
    return turn;
  } catch (e) {
    turn.error = (e as Error).message;
    turn.status = "error";
    args.onUpdate({ ...turn });
    return turn;
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────

export async function loadSemantics(tableIds: string[]): Promise<Map<string, SemanticEntry>> {
  const map = new Map<string, SemanticEntry>();
  if (tableIds.length === 0) return map;
  const { data } = await supabase
    .from("user_data_semantics")
    .select("id, table_id, table_description, business_name, column_meta, primary_key, join_hints, is_sample")
    .in("table_id", tableIds);
  for (const row of data ?? []) {
    map.set(row.table_id, {
      id: row.id,
      table_id: row.table_id,
      table_description: row.table_description,
      business_name: row.business_name,
      column_meta: (row.column_meta as Record<string, ColumnMeta>) ?? {},
      primary_key: row.primary_key,
      join_hints: (row.join_hints as { from: string; to: string; on: string }[]) ?? [],
      is_sample: row.is_sample,
    });
  }
  return map;
}

export async function saveSemantics(args: {
  userId: string;
  tableId: string;
  table_description: string | null;
  business_name: string | null;
  column_meta: Record<string, ColumnMeta>;
  primary_key: string | null;
}): Promise<void> {
  const { data: existing } = await supabase
    .from("user_data_semantics")
    .select("id")
    .eq("user_id", args.userId)
    .eq("table_id", args.tableId)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from("user_data_semantics")
      .update({
        table_description: args.table_description,
        business_name: args.business_name,
        column_meta: args.column_meta,
        primary_key: args.primary_key,
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("user_data_semantics").insert({
      user_id: args.userId,
      table_id: args.tableId,
      table_description: args.table_description,
      business_name: args.business_name,
      column_meta: args.column_meta,
      primary_key: args.primary_key,
      is_sample: false,
    });
    if (error) throw new Error(error.message);
  }
}

export async function loadSavedMetrics(): Promise<SavedMetric[]> {
  const { data } = await supabase
    .from("user_saved_metrics")
    .select("id, table_id, name, description, sql_expression, example_question")
    .order("created_at", { ascending: false });
  return (data ?? []) as SavedMetric[];
}

export async function saveMetric(args: {
  userId: string;
  tableId: string | null;
  name: string;
  description: string | null;
  sql_expression: string;
  example_question: string | null;
}): Promise<void> {
  const { error } = await supabase.from("user_saved_metrics").insert({
    user_id: args.userId,
    table_id: args.tableId,
    name: args.name,
    description: args.description,
    sql_expression: args.sql_expression,
    example_question: args.example_question,
  });
  if (error) throw new Error(error.message);
}

export async function deleteMetric(metricId: string): Promise<void> {
  const { error } = await supabase.from("user_saved_metrics").delete().eq("id", metricId);
  if (error) throw new Error(error.message);
}
