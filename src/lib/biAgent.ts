// BI Agent orchestrator — "Wren-style" GenBI pipeline.
//
// Runs entirely in the browser, calling our existing /api/chat endpoint with
// structured JSON-mode prompts. Pipeline:
//
//   1. PLAN — LLM reads the question + semantic layer → structured intent
//   2. SQL  — LLM writes a single SELECT constrained to known columns
//   3. EXEC — runs SQL through the in-browser DuckDB-Wasm engine (runQuery),
//      or an injected `execute` for warehouses and server-side callers
//   4. CHART — LLM picks chart type + axis fields
//   5. NARRATIVE — LLM writes a 2–3 sentence answer
//
// We keep the LLM calls small and JSON-only so they're fast and cheap.

import { supabase } from "@/integrations/supabase/client";
// TYPE-ONLY, deliberately. sqlEngine pulls in lib/browserDuckdb, which imports
// `duckdb-mvp.wasm?url` — a Vite-only specifier. A value import here made this
// module unloadable outside a Vite build, and biAgent is mostly PROMPT
// CONSTRUCTION, which has no business needing a SQL engine to load.
//
// It broke the NL-to-SQL eval: it imports buildSqlPrompt from here, and Node
// resolved the .wasm as a package and died on its internal `env` import before
// a single question ran. The engine itself is reached dynamically below.
import type { ColumnDef, DatasetMeta, QueryResult } from "@/lib/sqlEngine";
import type { OntologySpec } from "@/lib/biOntology";
import { metricExpression, type SemanticDimension, type SemanticMetric } from "@/lib/semanticLayer";
import { parseModelChoice } from "@/utils/providers/modelChoice";

export type ColumnMeta = {
  description?: string;
  alias?: string;
  unit?: string;
  /** Semantic tag from the data-prep builder: location, category, currency… */
  semantic_type?: string;
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

/** Value formatting applied to a chart's numeric output. */
export type BiNumberFormat = "currency" | "percent";

/** One conditional-formatting rule (first match wins). */
export type BiCondRule = {
  op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "between";
  value: number;
  /** Upper bound for "between" (inclusive). */
  value2?: number;
  /** Colour key from COND_COLORS (biChartMath). */
  color: string;
};

/** Conditional cell colouring for the pivot (matrix) widget. */
export type BiCondFormat =
  | { mode: "scale"; color?: string }
  | { mode: "rules"; rules: BiCondRule[] };

/** Horizontal reference line on cartesian charts. */
export type BiRefLine = { mode: "avg" | "value"; value?: number; label?: string };

/** Analytics options shared by all chart specs (each renderer applies what it supports). */
export type BiChartAnalytics = {
  /** Category drill hierarchy (bar/hbar/pie); level 0 = the configured field. */
  drillFields?: string[];
  /** Default date bucketing for time series (line/area); viewers can toggle. */
  dateGrain?: "auto" | "day" | "week" | "month" | "quarter" | "year";
  /** Overlay of the previous bucket / same bucket last year (line/area, single series). */
  compare?: "prior_period" | "prior_year";
  /** Cumulative running total (line/area, single series). */
  running?: boolean;
  /** Linear trend line (line, single series). */
  trend?: boolean;
  /** Forecast this many buckets ahead with a ±1.96σ corridor (line, single series). */
  forecast?: number;
  refLine?: BiRefLine;
};

/** Per-column display format for table widgets. */
export type BiColumnFormat = {
  format?: BiNumberFormat | "number";
  currency?: string;
  decimals?: number;
};

export type ChartSpec = {
  format?: BiNumberFormat;
  /** ISO 4217 code used when format is "currency" (default USD). */
  currency?: string;
  /** Fixed fraction digits (0-4); undefined = auto/compact. */
  decimals?: number;
  /** Table widgets only: per-column formats keyed by column name. */
  columnFormats?: Record<string, BiColumnFormat>;
} & BiChartAnalytics &
  (
    | { type: "table" }
    | { type: "kpi"; valueField: string; label?: string; targetField?: string }
    | { type: "bar"; xField: string; yField: string; seriesField?: string; stacked?: boolean }
    | { type: "hbar"; xField: string; yField: string }
    | { type: "line"; xField: string; yField: string; seriesField?: string }
    | { type: "area"; xField: string; yField: string; seriesField?: string }
    // Stacked column (vertical) — xField category, yField measure, split by seriesField.
    | { type: "scolumn"; xField: string; yField: string; seriesField: string }
    // Stacked horizontal bar — xField category, yField measure, split by seriesField.
    | { type: "shbar"; xField: string; yField: string; seriesField: string }
    // Animated bar-chart race — xField category (racing bars), yField measure, timeField frames.
    | { type: "barrace"; xField: string; yField: string; timeField: string }
    // Sankey flow — xField=source node, yField=target node, valueField=flow magnitude.
    | { type: "sankey"; xField: string; yField: string; valueField: string }
    // Nightingale / polar-area rose — one wedge per nameField, radius ∝ valueField.
    | { type: "nightingale"; nameField: string; valueField: string }
    // Radar / spider — one spoke per xField category, radius=yField, optional multi-series.
    | { type: "radar"; xField: string; yField: string; seriesField?: string }
    | { type: "pie"; nameField: string; valueField: string }
    | { type: "combo"; xField: string; barField: string; lineField: string }
    | { type: "scatter"; xField: string; yField: string; sizeField?: string }
    | { type: "funnel"; nameField: string; valueField: string }
    | { type: "waterfall"; xField: string; yField: string }
    | { type: "gauge"; valueField: string; label?: string; targetField?: string; max?: number }
    | { type: "treemap"; nameField: string; valueField: string }
    | { type: "heatmap"; xField: string; yField: string; valueField: string }
    // Word cloud — words sized by frequency of textField (optionally weighted by valueField).
    | { type: "wordcloud"; textField: string; valueField?: string }
    | { type: "boxplot"; xField: string; yField: string }
    | {
        type: "matrix";
        rowField: string;
        colField: string;
        valueField: string;
        /** Optional second row level — rows become expandable groups with subtotals. */
        rowSubField?: string;
        condFormat?: BiCondFormat;
      }
    | { type: "map"; locationField: string; valueField: string }
    | { type: "bubblemap"; locationField: string; valueField: string }
    | { type: "ontology"; spec: OntologySpec }
  );

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
  /** Names of the knowledge documents the analyst was given for this turn. */
  docNames?: string[];
  error?: string;
  status: "planning" | "writing_sql" | "executing" | "charting" | "summarizing" | "done" | "error";
};

// ── LLM via /api/bi (JSON-mode) ──────────────────────────────────────────

export async function llmJson<T>(opts: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  /** Completion-token cap; raise it for large structured outputs (deck plans). */
  maxTokens?: number;
}): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not signed in");

  // opts.model may be an encoded "provider::model" choice (see modelChoice).
  const choice = parseModelChoice(opts.model);
  // Hard deadline: without it a stalled provider leaves every AI spinner
  // (analyst, insights, ontology, generate) hanging forever.
  //
  // Must outlast the server's own deadline, which scales with maxTokens — at a
  // flat 120s the client gave up first on any large plan, so the server's much
  // more specific timeout message never reached the user.
  const ctrl = new AbortController();
  const clientTimeoutMs = Math.min(270_000, 90_000 + Math.min(opts.maxTokens ?? 0, 16000) * 8);
  const timer = setTimeout(() => ctrl.abort(), clientTimeoutMs);
  let resp: Response;
  try {
    resp = await fetch("/api/bi", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        provider: choice?.provider,
        model: choice?.model,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(
        `The AI call timed out after ${Math.round(clientTimeoutMs / 1000)}s — the selected model/provider isn't responding. Check the model picker and your Integrations.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

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

// ── Governed semantic models in the analyst's prompts ─────────────────────
//
// The semantic layer is only worth its name if EVERY AI surface computes
// "revenue" the same way. metric_query enforces that for agent chat; the BI
// analyst writes raw SQL, so it gets the governed definitions injected into
// its schema context with an instruction to use them verbatim. Loaded once
// per minute under RLS (own + IAM-shared models) and filtered to models over
// the tables actually in context.

type GovernedModelRow = {
  name: string;
  label: string | null;
  source_kind: string;
  source_table: string;
  dimensions: SemanticDimension[];
  metrics: SemanticMetric[];
};

let governedCache: { at: number; rows: GovernedModelRow[] } | null = null;
const GOVERNED_TTL_MS = 60_000;

/** Refresh the governed-model cache; callers await this before prompting. */
export async function ensureGovernedCatalog(): Promise<void> {
  if (governedCache && Date.now() - governedCache.at < GOVERNED_TTL_MS) return;
  try {
    const { data } = await supabase
      .from("semantic_models")
      .select("name, label, source_kind, source_table, dimensions, metrics");
    governedCache = {
      at: Date.now(),
      rows: (data ?? []).map((r) => ({
        name: r.name,
        label: r.label,
        source_kind: r.source_kind,
        source_table: r.source_table,
        dimensions: Array.isArray(r.dimensions) ? (r.dimensions as SemanticDimension[]) : [],
        metrics: Array.isArray(r.metrics) ? (r.metrics as SemanticMetric[]) : [],
      })),
    };
  } catch {
    // Prompts must never fail because the catalog didn't load.
    governedCache = { at: Date.now(), rows: [] };
  }
}

function governedLines(datasets: DatasetMeta[]): string[] {
  const tables = new Set(datasets.map((d) => d.name.toLowerCase()));
  const rows = (governedCache?.rows ?? []).filter(
    (m) => m.source_kind === "data_table" && tables.has(m.source_table.toLowerCase()),
  );
  const lines: string[] = [];
  for (const m of rows.slice(0, 8)) {
    lines.push(`MODEL ${m.name}${m.label ? ` (${m.label})` : ""} over TABLE ${m.source_table}:`);
    for (const met of m.metrics.slice(0, 16)) {
      try {
        lines.push(
          `  ${met.name} = ${metricExpression(met, m.metrics)}${met.format ? `  [${met.format}]` : ""}`,
        );
      } catch {
        /* skip malformed metric rather than break the prompt */
      }
    }
    for (const d of m.dimensions.slice(0, 16)) {
      lines.push(`  dim ${d.name} = ${d.sql}${d.type ? ` (${d.type})` : ""}`);
    }
  }
  return lines;
}

// ── Schema description for the LLM ────────────────────────────────────────

function describeSchema(
  datasets: DatasetMeta[],
  semantics: Map<string, SemanticEntry>,
  metrics: SavedMetric[],
): string {
  const tableLines = datasets.map((d) => {
    const sem = semantics.get(d.id);
    const cols = d.columns.map((c) => describeColumn(c, sem?.column_meta?.[c.name])).join(", ");
    const desc = sem?.table_description
      ? ` -- ${sem.table_description}`
      : d.is_sample
        ? " -- sample dataset"
        : "";
    return `TABLE ${d.name} (${cols})${desc}`;
  });

  const metricLines = metrics
    .filter((m) => m.sql_expression)
    .map((m) => `- ${m.name}: ${m.sql_expression}${m.description ? `  // ${m.description}` : ""}`);

  const joinLines: string[] = [];
  semantics.forEach((s) => {
    for (const h of s.join_hints || []) {
      joinLines.push(`- ${h.from} JOIN ${h.to} ON ${h.on}`);
    }
  });

  const govLines = governedLines(datasets);

  return [
    "AVAILABLE TABLES:",
    ...tableLines,
    metricLines.length ? "\nSAVED METRICS (use these formulas verbatim):" : "",
    ...metricLines,
    govLines.length
      ? "\nGOVERNED SEMANTIC MODELS (authoritative business definitions — when the question " +
        "uses one of these metric or dimension names, compute it with EXACTLY this expression " +
        "over the model's table; never improvise a different formula):"
      : "",
    ...govLines,
    joinLines.length ? "\nJOIN HINTS:" : "",
    ...joinLines,
  ]
    .filter(Boolean)
    .join("\n");
}

export function describeColumn(c: ColumnDef, meta?: ColumnMeta): string {
  // THE TYPE IS PARENTHESISED SO IT CANNOT BE READ AS PART OF THE NAME.
  //
  // This used to be `${name} ${type}`, which renders a column named `season`
  // of type `number` as `season number` — indistinguishable from a column
  // genuinely called "season number". The model duly wrote "season number",
  // and the engine's own error ("a name containing a space must be quoted")
  // reinforced the misreading rather than correcting it.
  //
  // It accounted for FIVE of sixteen failures in the first DuckDB eval run,
  // across four different tables — every one of them a question about a
  // `season` column. Not an edge case: any single-word column name that reads
  // as a noun modifier collides with its own type.
  const parts = [`${c.name} (${c.type})`];
  // The values a low-cardinality string column actually holds. Without these
  // the model has to guess a literal — `= 'Yes'` against data holding `Y` —
  // and the query silently returns nothing. "Match literals exactly as they
  // appear in the schema" is only actionable once they appear in the schema.
  if (c.values?.length) parts.push(`values=[${c.values.join("|")}]`);
  // Blanks are invisible otherwise. `Region (string) values=[AMER|APAC|EMEA]`
  // reads as "every row has one of three regions" whether or not three rows
  // are empty — so asked for "each region that has one recorded", the model
  // had nothing to filter on and reported the blank group as a fourth region.
  if (c.hasBlanks) parts.push("has_blanks");
  if (meta?.semantic_type) parts.push(`semantic=${meta.semantic_type}`);
  if (meta?.alias) parts.push(`alias="${meta.alias}"`);
  if (meta?.unit) parts.push(`unit=${meta.unit}`);
  if (meta?.description) parts.push(`-- ${meta.description}`);
  return parts.join(" ");
}

// ── Unstructured context: knowledge-base documents ───────────────────────
//
// Selected documents are chunked and lexically scored against the question;
// the top chunks (or the opening, when nothing matches) go into the plan and
// narrative prompts so the analyst can cross-reference structured results
// with unstructured content — and honestly say when they don't relate.

export type BiDoc = { id: string; name: string; kbName: string; content: string };

export type BiDocExcerpt = {
  name: string;
  kbName: string;
  excerpts: string[];
  /** False when no chunk overlapped the question — the opening is shown instead. */
  matched: boolean;
};

const DOC_STOP = new Set(
  "the a an and or but of to in on for with is are was were be this that it as at by from what how why when which show me per top total average count sum".split(
    " ",
  ),
);
const DOC_CONTENT_CAP = 120_000; // chars scanned per document
const CHUNK_TARGET = 700; // chars per excerpt chunk
const MAX_CHUNKS_PER_DOC = 3;
const TOTAL_EXCERPT_BUDGET = 9_000; // chars across all documents

function chunkDocContent(content: string): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const p of content.slice(0, DOC_CONTENT_CAP).split(/\n{2,}/)) {
    const para = p.trim();
    if (!para) continue;
    if (buf && buf.length + para.length + 1 > CHUNK_TARGET) {
      chunks.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n${para}` : para;
    while (buf.length > CHUNK_TARGET * 2) {
      chunks.push(buf.slice(0, CHUNK_TARGET * 2));
      buf = buf.slice(CHUNK_TARGET * 2);
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function extractDocExcerpts(question: string, docs: BiDoc[]): BiDocExcerpt[] {
  const terms = Array.from(
    new Set(
      question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !DOC_STOP.has(t)),
    ),
  );
  const perDocBudget = Math.max(1200, Math.floor(TOTAL_EXCERPT_BUDGET / Math.max(docs.length, 1)));
  return docs.map((doc) => {
    const scored = chunkDocContent(doc.content).map((chunk, idx) => {
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let from = 0;
        let count = 0;
        while (count < 4) {
          const at = lower.indexOf(term, from);
          if (at === -1) break;
          count += 1;
          from = at + term.length;
        }
        if (count > 0) score += 1 + (count - 1) * 0.25;
      }
      return { chunk, idx, score };
    });
    const hits = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CHUNKS_PER_DOC);
    const matched = hits.length > 0;
    // No overlap → hand the model the opening so it can judge (and honestly
    // report) whether the document relates to the data at all.
    const picked = matched ? hits.sort((a, b) => a.idx - b.idx) : scored.slice(0, 1);
    const excerpts: string[] = [];
    let used = 0;
    for (const p of picked) {
      const room = perDocBudget - used;
      if (room <= 0) break;
      const text = p.chunk.length > room ? `${p.chunk.slice(0, room)}…` : p.chunk;
      excerpts.push(text);
      used += text.length;
    }
    return { name: doc.name, kbName: doc.kbName, excerpts, matched };
  });
}

function describeDocs(docs: BiDocExcerpt[]): string {
  const blocks = docs.map((d) => {
    const note = d.matched ? "" : " [no keyword overlap with the question — opening shown]";
    const body = d.excerpts.map((e) => `> ${e.replace(/\n/g, "\n> ")}`).join("\n> […]\n");
    return `DOCUMENT "${d.name}" (knowledge base "${d.kbName}")${note}:\n${body}`;
  });
  return `SELECTED KNOWLEDGE DOCUMENTS (unstructured context):\n${blocks.join("\n\n")}`;
}

// ── Pipeline steps ───────────────────────────────────────────────────────

export async function planQuestion(args: {
  question: string;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  docs?: BiDocExcerpt[];
  model?: string;
}): Promise<BiPlan> {
  await ensureGovernedCatalog();
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const docBlock = args.docs?.length
    ? `\n\n${describeDocs(args.docs)}\nThe documents are unstructured context only — SQL can ONLY query the tables above. ` +
      "If a document suggests a breakdown or filter that exists in the schema, prefer it."
    : "";
  const plan = await llmJson<BiPlan>({
    model: args.model,
    systemPrompt:
      "You are a BI planning agent. Read the user's question and the schema, then output a structured plan as JSON. " +
      "Only use tables and columns that exist in the schema. Be precise.",
    userPrompt: `${schema}${docBlock}\n\nQUESTION: ${args.question}\n\nReturn JSON with this exact shape:\n{\n  "intent": "short description of what the user wants",\n  "tables": ["table_name"],\n  "metrics": ["metric or aggregation"],\n  "breakdowns": ["column to group by"],\n  "time_grain": "day|week|month|quarter|year|null",\n  "filters": ["plain-English filters"]\n}`,
  });
  return plan;
}

export async function generateSql(args: {
  question: string;
  plan: BiPlan;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  /** e.g. "Snowflake" — switches the prompt from the local engine to warehouse SQL. */
  dialect?: string;
  /** Which local engine will run this, when no warehouse `dialect` is set. */
  localEngine?: "alasql" | "duckdb";
  model?: string;
  /**
   * A previous attempt and the engine error it produced. Given these, the model
   * fixes that statement rather than generating from scratch — the second try
   * is otherwise likely to reproduce the same mistake.
   */
  repair?: { sql: string; error: string };
}): Promise<string> {
  await ensureGovernedCatalog();
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const { systemPrompt, userPrompt } = buildSqlPrompt({ ...args, schema });
  const out = await llmJson<{ sql: string }>({ model: args.model, systemPrompt, userPrompt });
  return out.sql;
}

/**
 * The SQL-generation prompt, as data.
 *
 * Split out so the NL-to-SQL evaluation harness scores the prompt this app
 * actually sends. An eval that re-creates the prompt measures a copy, and the
 * copy is exactly where a regression hides — the same reasoning that put the
 * real execution path behind the differential harness.
 */
export function buildSqlPrompt(args: {
  question: string;
  plan: BiPlan;
  /** Pre-rendered schema description — see describeSchema. */
  schema: string;
  dialect?: string;
  /**
   * Which LOCAL engine will execute this, when no warehouse `dialect` is set.
   *
   * IDENTIFIER QUOTING IS NOT PORTABLE between the two, and getting it wrong
   * fails every query that needs to quote anything: AlaSQL wants backticks,
   * DuckDB rejects them and wants double quotes. `saas_sales` alone has
   * `Order Date`, `Row ID` and `Customer ID`, so this is not an edge case.
   *
   * Defaults to `duckdb`, which is what actually runs BOTH local paths:
   * lib/sqlEngine has been DuckDB-Wasm in the browser since 92686b1, and
   * utils/data/localEngine.server is DuckDB by default too.
   *
   * It defaulted to `alasql` for three days after that commit, with a comment
   * asserting AlaSQL was what ran in production. The engine had been swapped
   * and this had not, so the prompt told the model to quote identifiers in
   * backticks and DuckDB rejected every query that quoted anything —
   * "Scalar Function with name `__postfix does not exist". Visual BI in chat
   * produced no chart at all for any question over a column with a space in
   * its name, and fell through to the plain agent, silently. The stale comment
   * is what made the wrong default look deliberate.
   *
   * AlaSQL remains selectable because localEngineName() can still return it
   * server-side, but nothing should assume it.
   */
  localEngine?: "alasql" | "duckdb";
  repair?: { sql: string; error: string };
}): { systemPrompt: string; userPrompt: string } {
  const engineLine = args.dialect
    ? `You are a SQL generation agent for ${args.dialect}. Use standard ANSI SQL for that warehouse; ` +
      "reference tables by their full schema-qualified names exactly as given, and quote unusual identifiers with double quotes. "
    : args.localEngine === "alasql"
      ? "You are a SQL generation agent for an in-browser AlaSQL engine. " +
        "Wrap identifiers with spaces or special chars in backticks. "
      : "You are a SQL generation agent for a DuckDB engine. " +
        'Quote identifiers with spaces or special chars in DOUBLE QUOTES ("Order Date"). ' +
        "Backticks are a syntax error in DuckDB — never use them. ";
  return {
    systemPrompt:
      engineLine +
      "Output a SINGLE SELECT statement only — no INSERT/UPDATE/DELETE/DDL. " +
      "Use only tables and columns from the provided schema. " +
      "Prefer aggregates (SUM/AVG/COUNT) for analytical questions. " +
      "Always add ORDER BY for rankings, and LIMIT 50 if the result might be large. " +
      // These three lines exist because the NL-to-SQL eval measured what was
      // actually going wrong: roughly half the failures were the right
      // analysis returned in the wrong SHAPE — extra columns nobody asked for,
      // or a superlative answered with a full ranking.
      "SELECT only the columns needed to answer the question — no extra context " +
      "columns, and no id columns unless the question asks for them. " +
      "If the question asks for a single best/worst/largest/top item, return exactly " +
      "one row with LIMIT 1. " +
      // Measured against a real Snowflake warehouse. "Which promotion has the
      // highest cost?" produced `ORDER BY p_cost DESC LIMIT 1`, which is
      // correct on DuckDB and returns an EMPTY ROW on Snowflake: 28 of 2,500
      // costs are null and Snowflake sorts nulls FIRST on DESC. Same question,
      // same prompt, same plausible SQL, different answer per warehouse — and
      // silent, because a row does come back.
      "When ORDER BY picks a top or bottom row, exclude nulls explicitly — warehouses " +
      "disagree on where nulls sort by default (Snowflake places them FIRST on DESC), so " +
      "ORDER BY x DESC LIMIT 1 can return an empty row. Write WHERE x IS NOT NULL, or " +
      "ORDER BY x DESC NULLS LAST. " +
      "Match string literals EXACTLY as they appear in the schema, including case. " +
      // Added for the same reason as the three lines above: the eval measured
      // it. Window scored 3/6, and all three failures were ONE mistake —
      // aggregating and windowing at the same SELECT level:
      //
      //   biggest-improvement  MAX(wins - LAG(wins) OVER (...))
      //                        -> "aggregate function calls cannot contain
      //                            window function calls"
      //   running-total        SUM(total_twh) OVER (ORDER BY year) alongside
      //                        a GROUP BY -> "column total_twh must appear in
      //                        the GROUP BY clause"
      //   top-product-per-region  no ranking at all, so two rows came back for
      //                        the same region
      //
      // A FIRST DRAFT OF THIS BANNED ALL THREE AT ONCE — "never combine an
      // aggregate and a window at the same SELECT level" — which is false, and
      // would have pushed the model AWAY from the expected answer for
      // top-product-per-region, whose reference SQL is exactly that:
      // ROW_NUMBER() OVER (ORDER BY SUM(Sales) DESC) alongside GROUP BY.
      // Windows evaluate AFTER grouping, so a window may reference an
      // aggregate. Caught by checking the rule against the reference queries
      // before spending a run on it.
      "Window functions run AFTER GROUP BY, so a window may reference an aggregate — " +
      "ROW_NUMBER() OVER (ORDER BY SUM(x) DESC) with GROUP BY is correct. But an " +
      "aggregate may never CONTAIN a window: MAX(x - LAG(x) OVER (...)) is invalid — " +
      "compute the windowed column in a WITH clause and aggregate it outside. And when " +
      "GROUP BY is present, a window's own argument must be aggregated too: write " +
      "SUM(SUM(x)) OVER (ORDER BY ...), or pre-aggregate in a WITH clause. " +
      "A window result cannot be used in WHERE, so for the best/top row PER GROUP, rank " +
      "with ROW_NUMBER() OVER (PARTITION BY <group> ORDER BY <measure> DESC) inside a " +
      "WITH clause and filter to rank 1 outside — several rows for one group is wrong. " +
      // Both measured on the dirty-data questions, which scored 3/5 while the
      // clean set scored 80%. The model could SEE the seven Status variants in
      // the schema and grouped on the raw column anyway, returning nine groups
      // for three real statuses. The blank-region case was the opposite — the
      // schema showed values=[AMER|APAC|EMEA] and said nothing about blanks,
      // so `has_blanks` was added to describeColumn to give this rule
      // something to act on.
      "If a column's listed values contain THE SAME WORD spelled two ways (Shipped, " +
      "shipped, SHIPPED), they are one category: group and filter on LOWER(column), or " +
      "the counts split across spellings and every one is wrong. Apply this ONLY to such " +
      "a column — never to one whose values are already distinct (AMER, APAC, EMEA), " +
      "because lowercasing those changes the labels in the answer. " +
      "A column marked has_blanks contains empty cells. When the question asks about rows " +
      "that HAVE a value recorded, exclude them with IS NOT NULL AND <> '' — a blank is not " +
      "a category and must not appear as its own group." +
      (args.repair
        ? " The previous statement FAILED. Return a corrected single statement that runs. " +
          "Check every table and column name against the schema — a name that is not listed " +
          "does not exist. Do not return more than one statement."
        : ""),
    userPrompt:
      `${args.schema}\n\nPLAN: ${JSON.stringify(args.plan)}\nQUESTION: ${args.question}\n` +
      (args.repair
        ? `\nFAILED SQL: ${args.repair.sql}\nENGINE ERROR: ${args.repair.error}\n`
        : "") +
      `\nReturn JSON: { "sql": "SELECT ..." }`,
  };
}

export async function suggestChart(args: {
  question: string;
  result: QueryResult;
  plan: BiPlan;
  model?: string;
  /** Chart type the planner asked for — honored when the result shape allows it. */
  preferChart?: string;
}): Promise<ChartSpec> {
  if (args.result.row_count === 0) return { type: "table" };
  if (
    args.result.row_count === 1 &&
    args.result.columns.length === 1 &&
    args.preferChart !== "gauge"
  ) {
    return {
      type: "kpi",
      valueField: args.result.columns[0],
      label: args.plan.intent,
    };
  }
  const sample = args.result.rows.slice(0, 5);
  const preferLine = args.preferChart
    ? `\n\nThe dashboard planner proposed a '${args.preferChart}' chart for this question — ` +
      "use it when the returned columns support it; otherwise pick the best fit."
    : "";
  const out = await llmJson<ChartSpec>({
    model: args.model,
    systemPrompt:
      "You pick the best chart for a SQL result. Output JSON only. " +
      "Allowed types and their required fields:\n" +
      "- 'bar','line','area': { xField, yField, seriesField? } — bar for categorical comparison, " +
      "line/area for time series; set seriesField to a second categorical column when the data " +
      "should be split into multiple series (e.g. revenue by month per region)\n" +
      "- 'pie': { nameField, valueField } — part-of-whole, ≤8 rows\n" +
      "- 'kpi': { valueField, label? } — single-value results only\n" +
      "- 'scatter': { xField, yField } — two numeric columns, correlation questions\n" +
      "- 'combo': { xField, barField, lineField } — two measures on different scales over one dimension\n" +
      "- 'funnel': { nameField, valueField } — sequential pipeline stages with decreasing values\n" +
      "- 'waterfall': { xField, yField } — additive positive/negative contributions to a total\n" +
      "- 'treemap': { nameField, valueField } — hierarchical/part-of-whole with many categories\n" +
      "- 'heatmap': { xField, yField, valueField } — intensity across two categorical dimensions\n" +
      "- 'scolumn': { xField, yField, seriesField } — stacked vertical columns; parts summing to a total per category\n" +
      "- 'shbar': { xField, yField, seriesField } — stacked horizontal bars; same as scolumn but ranked horizontally\n" +
      "- 'barrace': { xField, yField, timeField } — animated ranking of xField by yField across timeField frames\n" +
      "- 'sankey': { xField, yField, valueField } — flows FROM xField (source) TO yField (target) sized by valueField\n" +
      "- 'nightingale': { nameField, valueField } — polar-area rose; part-of-whole where magnitude varies a lot (≤12 rows)\n" +
      "- 'radar': { xField, yField, seriesField? } — compare 3-10 metrics (xField spokes) across one or a few series\n" +
      "- 'wordcloud': { textField, valueField? } — words sized by frequency of a text/category column; " +
      "set valueField to weight each distinct value by a measure instead of counting\n" +
      "- 'table': {} — fallback\n" +
      "All field values MUST be exact column names from the data.",
    userPrompt: `QUESTION: ${args.question}\nINTENT: ${args.plan.intent}\nCOLUMNS: ${args.result.columns.join(", ")}\nSAMPLE ROWS: ${JSON.stringify(sample)}\nROW COUNT: ${args.result.row_count}${preferLine}\n\nReturn JSON like { "type": "bar", "xField": "...", "yField": "..." }`,
  });
  return out;
}

/**
 * Totals, extremes and the row that holds each extreme — computed in code.
 *
 * The narrative model used to derive these from a ten-row sample and state
 * them as fact. It got a total wrong by a factor of two and named the wrong
 * top product; both read as confident prose under a correct chart. Arithmetic
 * is not something to ask a language model for when the rows are right here.
 *
 * Computed over every row the result carries, and says so when that is itself
 * a truncated set — an honest "of the rows shown" beats a total presented as
 * complete.
 */
export function describeResultFacts(result: QueryResult): string {
  const rows = result.rows ?? [];
  if (rows.length === 0) return "";

  const numeric: string[] = [];
  const labels: string[] = [];
  for (const c of result.columns) {
    const vals = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined);
    if (vals.length && vals.every((v) => typeof v === "number" || !Number.isNaN(Number(v)))) {
      numeric.push(c);
    } else if (vals.length) {
      labels.push(c);
    }
  }
  const labelCol = labels[0];

  const lines: string[] = [];
  for (const c of numeric) {
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    let maxLabel = "";
    let minLabel = "";
    for (const r of rows) {
      const raw = r[c];
      // Number(null) is 0 and Number("") is 0, both finite — so a finiteness
      // check alone counts every blank as a zero, dragging min to 0 and
      // labelling it with whichever row happened to be empty. Skip first.
      if (raw === null || raw === undefined || raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      sum += n;
      if (n > max) {
        max = n;
        maxLabel = labelCol ? String(r[labelCol] ?? "") : "";
      }
      if (n < min) {
        min = n;
        minLabel = labelCol ? String(r[labelCol] ?? "") : "";
      }
    }
    if (!Number.isFinite(max)) continue;
    const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
    lines.push(
      `${c}: total=${round(sum)} max=${round(max)}${maxLabel ? ` (${maxLabel})` : ""} ` +
        `min=${round(min)}${minLabel ? ` (${minLabel})` : ""}`,
    );
  }
  if (lines.length === 0) return "";

  const scope = result.capped
    ? `computed over the ${rows.length} rows returned, which are TRUNCATED — describe them as "of the rows shown", never as a complete total`
    : `computed over all ${rows.length} rows`;
  return `\nCOMPUTED FACTS (authoritative — ${scope}):\n${lines.join("\n")}`;
}

export async function summarizeResult(args: {
  question: string;
  result: QueryResult;
  plan: BiPlan;
  docs?: BiDocExcerpt[];
  model?: string;
}): Promise<string> {
  const hasDocs = Boolean(args.docs?.length);
  if (args.result.row_count === 0 && !hasDocs) return "The query returned no rows.";
  const sample = args.result.rows.slice(0, 10);
  // Arithmetic done HERE, not by the model. Measured: given five products it
  // reported "approximately $1.4M" against a true total of $704,186 — double —
  // and named the wrong product as top by units. Both stated flatly, in prose,
  // under a chart that was correct.
  //
  // It could hardly do better: it was shown a TEN-ROW SAMPLE and the total row
  // count, and asked to "lead with the headline number". Any total it produced
  // was either invented or extrapolated from a prefix — the same shape as the
  // snapshot-cap bug, in words instead of a bar.
  const facts = describeResultFacts(args.result);
  const docBlock = hasDocs ? `\n\n${describeDocs(args.docs!)}` : "";
  const out = await llmJson<{ summary: string }>({
    model: args.model,
    systemPrompt: hasDocs
      ? "You are a BI analyst combining a SQL query result (structured data) with knowledge-document " +
        "excerpts (unstructured data). Write 3–5 short sentences for a business user. Lead with the " +
        "headline number from the query result (if it returned no rows, say so). Then cross-reference " +
        "the documents: use them to explain, support or contradict the numbers, naming each document " +
        "you draw on. Only claim connections the excerpts actually support — if the documents contain " +
        "nothing relevant to this question or result, you MUST say plainly that you found no " +
        "correlation between the structured data and the selected documents, then summarize the data " +
        "alone. Never invent document content. Round large numbers (e.g. $1.2M, 3.4k). " +
        "Do NOT show SQL or column names verbatim — speak naturally."
      : "You summarize SQL query results in 2–3 short sentences for a business user. " +
        "Lead with the headline number. Round large numbers (e.g. $1.2M, 3.4k). " +
        "Do NOT show SQL or column names verbatim — speak naturally.",
    // COMPUTED FACTS is the only source for a total or a superlative. The rows
    // are a SAMPLE, so anything derived from them is derived from a prefix.
    userPrompt:
      `QUESTION: ${args.question}\nROWS (sample): ${JSON.stringify(sample)}\n` +
      `TOTAL ROWS: ${args.result.row_count}${args.result.capped ? " (truncated)" : ""}` +
      `${facts}${docBlock}\n\n` +
      `Use the COMPUTED FACTS for every total, maximum and minimum, and for which row holds ` +
      `them — do NOT add up the sample rows yourself, they are only a sample. If a figure you ` +
      `want is not in COMPUTED FACTS, describe the data without it rather than estimating.\n\n` +
      `Return JSON: { "summary": "..." }`,
  });
  return out.summary;
}

// ── Suggested questions for a dataset ──────────────────────────────────

export async function generateSuggestedQuestions(args: {
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  model?: string;
}): Promise<string[]> {
  if (args.datasets.length === 0) return [];
  await ensureGovernedCatalog();
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const out = await llmJson<{ questions: string[] }>({
    model: args.model,
    systemPrompt:
      "Suggest 4 specific, business-relevant questions a user could ask about this data. " +
      "Each question must be answerable with a single SQL query against the schema. " +
      "Mix question types: ranking, totals, time-comparison, breakdowns. Keep each ≤ 12 words.",
    userPrompt: `${schema}\n\nReturn JSON: { "questions": ["...", "...", "...", "..."] }`,
  });
  return (out.questions || []).slice(0, 4);
}

// ── Widget insight (BI dashboards) ─────────────────────────────────────

/**
 * Analyse a dashboard visual's data snapshot and produce a markdown insight
 * card: what the data shows, caveats, and suggested next steps.
 */
export async function generateWidgetInsight(args: {
  title: string;
  sql?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  model?: string;
}): Promise<string> {
  const sample = args.rows.slice(0, 30);
  const out = await llmJson<{ insight: string }>({
    model: args.model,
    systemPrompt:
      "You are a BI analyst writing an insight card that sits next to a dashboard visual. " +
      'Output JSON only: { "insight": "<markdown>" }. Structure the markdown exactly as three ' +
      "bolded sections with tight bullets: '**What the data shows**' (2-3 bullets), " +
      "'**Watch out for**' (1-2 bullets on anomalies, gaps or caveats), and " +
      "'**Suggested next steps**' (1-2 actionable bullets). Be specific — quote real numbers " +
      "from the data, rounded for readability ($1.2M, 3.4k). No preamble, no headings beyond " +
      "the bolded labels.",
    userPrompt: `VISUAL: ${args.title}\nSQL: ${args.sql ?? "n/a"}\nCOLUMNS: ${args.columns.join(", ")}\nTOTAL ROWS: ${args.rows.length}\nROWS (sample): ${JSON.stringify(sample)}\n\nReturn JSON: { "insight": "..." }`,
  });
  return out.insight;
}

// ── Orchestrator ───────────────────────────────────────────────────────

export async function runBiTurn(args: {
  question: string;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  /** Knowledge documents to cross-reference with the query result. */
  documents?: BiDoc[];
  onUpdate: (turn: BiTurn) => void;
  /** Override SQL execution (e.g. run against an external warehouse). */
  execute?: (sql: string) => Promise<QueryResult>;
  /** Human name of the SQL engine when `execute` is provided. */
  dialect?: string;
  /**
   * Local engine behind an injected `execute`, when it is not a warehouse.
   * Ignored without `execute` — the built-in path is always DuckDB.
   */
  localEngine?: "alasql" | "duckdb";
  /** OpenRouter model id for every LLM step (server default when omitted). */
  model?: string;
  /** Chart type the dashboard planner proposed (honored when the shape allows). */
  preferChart?: string;
}): Promise<BiTurn> {
  const docExcerpts = args.documents?.length
    ? extractDocExcerpts(args.question, args.documents)
    : undefined;
  const turn: BiTurn = {
    question: args.question,
    status: "planning",
    docNames: args.documents?.length ? args.documents.map((d) => d.name) : undefined,
  };
  args.onUpdate({ ...turn });
  try {
    turn.plan = await planQuestion({
      question: args.question,
      datasets: args.datasets,
      semantics: args.semantics,
      metrics: args.metrics,
      docs: docExcerpts,
      model: args.model,
    });
    turn.status = "writing_sql";
    args.onUpdate({ ...turn });

    turn.sql = await generateSql({
      question: args.question,
      plan: turn.plan,
      datasets: args.datasets,
      semantics: args.semantics,
      metrics: args.metrics,
      dialect: args.dialect,
      // Name the engine that is ACTUALLY about to run this, keyed off the same
      // `args.execute` test the executor below uses. Injecting an executor and
      // generating SQL for a different engine is how this broke: the browser
      // path swapped to DuckDB while the prompt still described AlaSQL.
      localEngine: args.execute ? args.localEngine : "duckdb",
      model: args.model,
    });
    turn.status = "executing";
    args.onUpdate({ ...turn });

    // Dynamic so the browser engine is loaded only when it is actually used.
    // Callers that inject `execute` — the eval, and anything server-side —
    // never touch it, which is what keeps this module importable under Node.
    turn.result = args.execute
      ? await args.execute(turn.sql)
      : await (await import("@/lib/sqlEngine")).runQuery(turn.sql);
    turn.status = "charting";
    args.onUpdate({ ...turn });

    const [chart, narrative] = await Promise.all([
      suggestChart({
        question: args.question,
        result: turn.result,
        plan: turn.plan,
        model: args.model,
        preferChart: args.preferChart,
      }),
      summarizeResult({
        question: args.question,
        result: turn.result,
        plan: turn.plan,
        docs: docExcerpts,
        model: args.model,
      }),
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

// ── Reader Q&A over published dashboards ───────────────────────────────

/**
 * Answer a viewer's question using ONLY a dashboard's stored widget
 * snapshots — no data-source access needed, so shared (read-only) viewers
 * can use it with the model the publisher selected.
 */
export async function askDashboardQuestion(args: {
  question: string;
  model?: string;
  widgets: {
    title: string;
    kind: string;
    columns?: string[];
    rows?: Record<string, unknown>[];
    text?: string;
  }[];
}): Promise<string> {
  const context = args.widgets
    .slice(0, 16)
    .map((w) => {
      if (w.kind === "text") return `NOTE "${w.title}":\n${(w.text ?? "").slice(0, 800)}`;
      const cols = (w.columns ?? []).join(", ");
      const sample = JSON.stringify((w.rows ?? []).slice(0, 15));
      return `WIDGET "${w.title}"\nCOLUMNS: ${cols}\nROWS (sample of ${w.rows?.length ?? 0}): ${sample}`;
    })
    .join("\n\n");
  const out = await llmJson<{ answer: string }>({
    model: args.model,
    systemPrompt:
      "You are a BI analyst answering questions about a published dashboard. " +
      "Use ONLY the widget data provided — never invent numbers. If the data cannot answer the " +
      "question, say so briefly and name what data would be needed. Answer in tight markdown " +
      "with specific figures, rounded for readability. " +
      'Output JSON only: { "answer": "<markdown>" }.',
    userPrompt: `DASHBOARD DATA:\n${context}\n\nQUESTION: ${args.question}\n\nReturn JSON: { "answer": "..." }`,
  });
  return out.answer;
}

// ── Persistence helpers ─────────────────────────────────────────────────

export async function loadSemantics(tableIds: string[]): Promise<Map<string, SemanticEntry>> {
  const map = new Map<string, SemanticEntry>();
  if (tableIds.length === 0) return map;
  const { data } = await supabase
    .from("user_data_semantics")
    .select(
      "id, table_id, table_description, business_name, column_meta, primary_key, join_hints, is_sample",
    )
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

// ── AI-generated dashboards ────────────────────────────────────────────

/** Turn a business goal into a dashboard title + analyst questions. */
export async function planDashboard(args: {
  goal: string;
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  model?: string;
}): Promise<{ title: string; questions: string[] }> {
  await ensureGovernedCatalog();
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const out = await llmJson<{ title?: string; questions?: string[] }>({
    model: args.model,
    systemPrompt:
      "You design BI dashboards. Given a business goal and the available schema, plan a " +
      "dashboard as a set of 5-8 analyst questions, each answerable with ONE SQL query " +
      "against the schema. Mix widget shapes: start with 2-3 single-number KPI questions " +
      '("total X", "average Y"), then trends over time, rankings and breakdowns. ' +
      "Only reference tables and columns that exist. Output JSON only.",
    userPrompt:
      `${schema}\n\nGOAL: ${args.goal}\n\n` +
      'Return JSON: { "title": "short dashboard title", "questions": ["...", ...] }',
  });
  return {
    title: (out.title ?? "").trim().slice(0, 60) || args.goal.slice(0, 60),
    questions: (out.questions ?? [])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .slice(0, 8),
  };
}

// ── Widget suggestion (analyze table → proposed visuals) ─────────────────

export type WidgetSuggestion = {
  id: string;
  title: string;
  /** "chart" (data-driven, default), "text" (markdown note) or "image" (URL). */
  kind: "chart" | "text" | "image";
  /** Proposed chart type (bar/line/kpi/pie/heatmap/scatter/…). chart kind only. */
  chartType: string;
  /** The analyst question that produces this widget. chart kind only. */
  question: string;
  /** One-line reason this visual is worth building. */
  rationale: string;
  /** Markdown content for a "text" widget. */
  content?: string;
  /** Image URL for an "image" widget. */
  imageUrl?: string;
};

const SUGGESTABLE_CHARTS =
  "kpi, bar, hbar, scolumn, shbar, barrace, line, area, pie, nightingale, radar, combo, scatter, funnel, waterfall, gauge, sankey, treemap, heatmap, wordcloud, boxplot, matrix, table";

/**
 * Analyze a table's structure + semantics and propose a set of dashboard
 * widgets (plus an executive summary), maximizing the variety of chart
 * types the data can support. The user then picks which to generate.
 */
export async function suggestDashboardWidgets(args: {
  datasets: DatasetMeta[];
  semantics: Map<string, SemanticEntry>;
  metrics: SavedMetric[];
  /** Optional focus/goal to steer the suggestions. */
  focus?: string;
  model?: string;
}): Promise<{ title: string; summary: string; suggestions: WidgetSuggestion[] }> {
  await ensureGovernedCatalog();
  const schema = describeSchema(args.datasets, args.semantics, args.metrics);
  const out = await llmJson<{
    title?: string;
    summary?: string;
    widgets?: Array<{
      title?: string;
      kind?: string;
      chartType?: string;
      question?: string;
      rationale?: string;
      content?: string;
      imageUrl?: string;
    }>;
  }>({
    model: args.model,
    systemPrompt:
      "You are a senior BI analyst designing a dashboard from a single table. " +
      "First assess the columns: identify measures (numeric facts), dimensions " +
      "(categorical), dates, geographies and identifiers. Then propose 8-14 widgets " +
      "that together tell the story of this data, MAXIMIZING the variety of chart types " +
      "the columns can actually support — do not use the same type repeatedly when a " +
      `richer one fits. Available chart types: ${SUGGESTABLE_CHARTS}. Guidance: use 'kpi' ` +
      "for headline single numbers (2-4 of them); 'line'/'area' for measures over a date; " +
      "'bar'/'hbar' for rankings and category comparisons; 'pie'/'treemap' for part-of-whole; " +
      "'heatmap'/'matrix' for a measure across two dimensions; 'scatter' for two-measure " +
      "correlation; 'boxplot' for distribution across groups; 'funnel'/'waterfall' where the " +
      "data is sequential/additive; 'scolumn'/'shbar' for stacked parts-of-a-total across a " +
      "category and a second dimension; 'barrace' for a ranking that changes over a date/time " +
      "column; 'radar' to compare a handful of metrics across a few entities; 'nightingale' for " +
      "a rose of ≤12 categories with widely varying magnitudes; 'sankey' for flows between two " +
      "linked columns (source→target) with a value; 'wordcloud' for a free-text or comment column " +
      "to surface frequent terms; 'map'/'bubblemap' ONLY if a real geography column exists. " +
      "Chart widgets (kind 'chart', the default) need a concrete analyst question answerable with " +
      "ONE SQL query on this schema, using ONLY columns that exist. You MAY also add non-data " +
      "widgets: a 'text' widget (set kind:'text' and content: markdown, e.g. a section header or " +
      "note) — no question needed; and, ONLY if the FOCUS explicitly asks for a logo/banner/image " +
      "and gives a URL, an 'image' widget (kind:'image', imageUrl). Never invent image URLs. " +
      "Also write a 2-4 sentence executive summary of " +
      "what this dataset contains and the key things the dashboard reveals. Output JSON only.",
    userPrompt:
      `${schema}\n\n${args.focus ? `FOCUS: ${args.focus}\n\n` : ""}` +
      'Return JSON: { "title": "short dashboard title", "summary": "executive summary (markdown ok)", ' +
      '"widgets": [ { "title": "widget title", "chartType": "bar", "question": "analyst question", ' +
      '"rationale": "why this visual" }, ... ] }',
  });

  const suggestions: WidgetSuggestion[] = (out.widgets ?? [])
    .map((w) => {
      const kind: WidgetSuggestion["kind"] =
        w.kind === "text" ? "text" : w.kind === "image" ? "image" : "chart";
      return {
        id: crypto.randomUUID(),
        kind,
        title: (w.title ?? w.question ?? "").trim().slice(0, 80),
        chartType: (w.chartType ?? "").trim().toLowerCase(),
        question: (w.question ?? "").trim(),
        rationale: (w.rationale ?? "").trim().slice(0, 160),
        content: typeof w.content === "string" ? w.content.trim() : undefined,
        imageUrl: typeof w.imageUrl === "string" ? w.imageUrl.trim() : undefined,
      };
    })
    // Keep widgets that are actually buildable: charts need a question, text
    // needs content, image needs a real http(s) URL.
    .filter((w) =>
      w.kind === "chart"
        ? w.question.length > 0
        : w.kind === "text"
          ? (w.content ?? "").length > 0
          : /^https?:\/\//i.test(w.imageUrl ?? ""),
    )
    .slice(0, 14);

  return {
    title: (out.title ?? "").trim().slice(0, 60) || args.datasets[0]?.name || "Dashboard",
    summary: (out.summary ?? "").trim(),
    suggestions,
  };
}
