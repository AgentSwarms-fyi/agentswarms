// What the assistant reads about one of the reader's things (R552).
//
// The assistant could find a thing by name (find_my_work) and link it, but
// never say anything about it: "is my churn model healthy?" or "what does the
// Sales dashboard show?" had no answer. `describe_my_thing` reads one thing
// with the reader's own token and returns a few lines of plain facts made by
// the functions here — the kind of thing, whose it is, and what a person
// would want to know first — never a credential, a prompt's text, a
// pipeline's code or a dashboard's data.
//
// Pure: each function takes the columns it is given, so a test can feed it
// rows and the server decides what is read.
import { NODE_KIND_LABEL, type WorkflowNodeKind } from "@/lib/workflows";

/** At most this many items of a list are named; the rest are counted. */
export const LIST_MAX = 12;
/** A description is cut here. */
const TEXT_MAX = 300;

type Json = unknown;

const day = (iso: unknown) =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;
const text = (v: unknown, max = TEXT_MAX) => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** "a, b, c and 4 more". */
export function listOf(items: readonly string[], max = LIST_MAX): string {
  const named = items.filter(Boolean);
  if (named.length <= max) return named.join(", ");
  return `${named.slice(0, max).join(", ")} and ${named.length - max} more`;
}

/** The first line: a link to it, what it is, and whose. */
export function headline(args: {
  name: string;
  href: string;
  kindLabel: string;
  mine: boolean;
  sample?: boolean;
}): string {
  const name = args.name.replace(/[[\]]/g, "").slice(0, 120) || "(untitled)";
  const whose = args.sample ? "a sample" : args.mine ? "yours" : "shared with you";
  return `[${name}](${args.href}) — ${args.kindLabel}, ${whose}.`;
}

function tail(row: { description?: unknown; updated_at?: unknown }): string[] {
  const out: string[] = [];
  const d = text(row.description);
  if (d) out.push(`Description: ${d}`);
  const changed = day(row.updated_at);
  if (changed) out.push(`Last changed ${changed}.`);
  return out;
}

export function describeModel(
  row: {
    task?: unknown;
    target_column?: unknown;
    source?: Json;
    feature_columns?: unknown;
    description?: unknown;
    updated_at?: unknown;
  },
  production: {
    version: number;
    algorithm?: string | null;
    metric?: string;
    value?: number | null;
  } | null,
  health: string | null,
): string[] {
  const out: string[] = [];
  const src = row.source as { schema?: unknown; table?: unknown } | null;
  const from =
    src && typeof src.schema === "string" && typeof src.table === "string"
      ? ` from ${src.schema}.${src.table}`
      : "";
  const target =
    typeof row.target_column === "string" && row.target_column
      ? `, predicting ${row.target_column}`
      : "";
  const features = Array.isArray(row.feature_columns) ? row.feature_columns.length : 0;
  out.push(
    `Task: ${text(row.task, 40) || "unknown"}${target}${from}${features ? ` (${features} chosen features)` : ""}.`,
  );
  if (production) {
    const metric =
      production.metric && typeof production.value === "number"
        ? `, ${production.metric} ${production.value.toFixed(3)} at training`
        : "";
    out.push(
      `In production: version ${production.version}${production.algorithm ? `, ${production.algorithm}` : ""}${metric}.`,
    );
  } else {
    out.push("No version is in production.");
  }
  if (health) out.push(health);
  return [...out, ...tail(row)];
}

export function describeDataset(row: {
  columns?: Json;
  parquet_rows?: unknown;
  source_filename?: unknown;
  storage_mode?: unknown;
  data_loaded_at?: unknown;
  updated_at?: unknown;
}): string[] {
  const out: string[] = [];
  const cols = Array.isArray(row.columns)
    ? (row.columns as { name?: unknown; type?: unknown }[]).map((c) =>
        typeof c?.name === "string"
          ? `${c.name} (${typeof c.type === "string" ? c.type : "?"})`
          : "",
      )
    : [];
  out.push(cols.length ? `${cols.length} columns: ${listOf(cols, 30)}.` : "No columns recorded.");
  if (typeof row.parquet_rows === "number")
    out.push(`${row.parquet_rows.toLocaleString("en-US")} rows.`);
  const from = text(row.source_filename, 120);
  if (from) out.push(`Loaded from ${from}.`);
  const loaded = day(row.data_loaded_at);
  if (loaded) out.push(`Data last loaded ${loaded}.`);
  const changed = day(row.updated_at);
  if (changed) out.push(`Last changed ${changed}.`);
  return out;
}

/** Page names and widget titles only: never a widget's query or its data. */
export function describeDashboard(row: {
  pages?: Json;
  widgets?: Json;
  published?: unknown;
  description?: unknown;
  updated_at?: unknown;
}): string[] {
  const titles = (ws: Json) =>
    Array.isArray(ws)
      ? (ws as { title?: unknown }[]).map((w) => text(w?.title, 80)).filter(Boolean)
      : [];
  const pages =
    Array.isArray(row.pages) && row.pages.length
      ? (row.pages as { name?: unknown; widgets?: Json }[]).map((p) => ({
          name: text(p?.name, 60) || "Untitled page",
          titles: titles(p?.widgets),
        }))
      : [{ name: "Page 1", titles: titles(row.widgets) }];
  const total = pages.reduce((n, p) => n + p.titles.length, 0);
  const out = [
    `${pages.length} page${pages.length === 1 ? "" : "s"}, ${total} visual${total === 1 ? "" : "s"}.`,
  ];
  for (const p of pages.slice(0, 6)) {
    out.push(`- ${p.name}: ${p.titles.length ? listOf(p.titles, 10) : "no titled visuals"}`);
  }
  if (pages.length > 6) out.push(`- and ${pages.length - 6} more pages`);
  if (row.published === true) out.push("Published as a link.");
  return [...out, ...tail(row)];
}

/** The steps by name and kind, the schedule and the last run: never a step's settings. */
export function describeWorkflow(row: {
  graph?: Json;
  cron_expr?: unknown;
  timezone?: unknown;
  is_active?: unknown;
  last_run_at?: unknown;
  last_run_status?: unknown;
  description?: unknown;
  updated_at?: unknown;
}): string[] {
  const nodes = Array.isArray((row.graph as { nodes?: unknown } | null)?.nodes)
    ? ((row.graph as { nodes: { kind?: unknown; label?: unknown }[] }).nodes ?? [])
    : [];
  const steps = nodes.map((n) => {
    const kind = NODE_KIND_LABEL[n.kind as WorkflowNodeKind] ?? text(n.kind, 30);
    const label = text(n.label, 60);
    return label && label !== kind ? `${label} (${kind})` : kind;
  });
  const out = [steps.length ? `${steps.length} steps: ${listOf(steps)}.` : "No steps yet."];
  const cron = text(row.cron_expr, 60);
  out.push(
    cron
      ? `Runs on a schedule (${cron}${row.timezone ? `, ${text(row.timezone, 40)}` : ""})${row.is_active === false ? ", paused" : ""}.`
      : "Not scheduled: it runs when started.",
  );
  const last = day(row.last_run_at);
  if (last) out.push(`Last run ${last}: ${text(row.last_run_status, 30) || "status unknown"}.`);
  return [...out, ...tail(row)];
}

/** What it runs on and the tools it may use: never its instructions. */
export function describeAgent(row: {
  llm_provider?: unknown;
  llm_model?: unknown;
  tools?: unknown;
  knowledge_base_id?: unknown;
  is_active?: unknown;
  description?: unknown;
  updated_at?: unknown;
}): string[] {
  const out: string[] = [];
  const model = [text(row.llm_provider, 40), text(row.llm_model, 80)].filter(Boolean).join("/");
  out.push(model ? `Model: ${model}.` : "Model: the workspace default.");
  const tools = Array.isArray(row.tools) ? row.tools.map((t) => text(t, 40)).filter(Boolean) : [];
  out.push(tools.length ? `Tools: ${listOf(tools)}.` : "No tools.");
  if (row.knowledge_base_id) out.push("Answers from a knowledge base.");
  if (row.is_active === false) out.push("Switched off.");
  return [...out, ...tail(row)];
}

export function describeSwarm(row: {
  nodes?: Json;
  is_deployed?: unknown;
  published_at?: unknown;
  description?: unknown;
  updated_at?: unknown;
}): string[] {
  const nodes = Array.isArray(row.nodes)
    ? (row.nodes as { type?: unknown; data?: { label?: unknown; kind?: unknown } }[])
    : [];
  const labels = nodes.map(
    (n) => text(n?.data?.label, 60) || text(n?.data?.kind, 30) || text(n?.type, 30),
  );
  const out = [nodes.length ? `${nodes.length} nodes: ${listOf(labels)}.` : "No nodes yet."];
  if (row.is_deployed === true) out.push("Deployed.");
  const published = day(row.published_at);
  if (published) out.push(`Published ${published}.`);
  return [...out, ...tail(row)];
}

/** Where it runs and when: never its code or the secrets it uses. */
export function describePipeline(row: {
  engine?: unknown;
  mode?: unknown;
  cron_expr?: unknown;
  timezone?: unknown;
  is_active?: unknown;
  last_run_at?: unknown;
  last_run_status?: unknown;
  description?: unknown;
  updated_at?: unknown;
}): string[] {
  const out: string[] = [];
  const engine = text(row.engine, 30);
  const mode = text(row.mode, 30);
  if (engine || mode)
    out.push(`Runs on ${engine || "the default engine"}${mode ? `, ${mode}` : ""}.`);
  const cron = text(row.cron_expr, 60);
  out.push(
    cron
      ? `Scheduled (${cron}${row.timezone ? `, ${text(row.timezone, 40)}` : ""})${row.is_active === false ? ", paused" : ""}.`
      : "Not scheduled.",
  );
  const last = day(row.last_run_at);
  if (last) out.push(`Last run ${last}: ${text(row.last_run_status, 30) || "status unknown"}.`);
  return [...out, ...tail(row)];
}

/** Anything else: what search knows, and where to open it. */
export function describeGeneric(
  detail: string | undefined,
  updatedAt: string | null | undefined,
): string[] {
  const out: string[] = [];
  const d = text(detail);
  if (d) out.push(`Description: ${d}`);
  const changed = day(updatedAt);
  if (changed) out.push(`Last changed ${changed}.`);
  out.push("Open it for the rest; the assistant reads only its name and description.");
  return out;
}
