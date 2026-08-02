// Data preparation — the visual, step-based pipeline behind the BI Workspace
// "Data preparation" tab.
//
// A prep flow is a SOURCE (a base table + a chain of joins + per-column
// output settings) followed by an ordered list of TRANSFORM STEPS (calculated
// fields, filters, summarize, append/union, pivot, unpivot, split column,
// remove duplicates, find & replace). Steps are reorderable — each one wraps
// the previous relation as a derived table, so the whole flow compiles to a
// single read-only SELECT that previews live and, on "Run & save",
// materialises the cast result as a regular local dataset (usable everywhere:
// SQL IDE, BI charts, AI analyst, agent tools). The recipe itself is persisted
// for re-editing and can be refreshed on a schedule server-side.
//
// This "core" module holds the PURE pipeline (model, schema evolution, SQL
// compiler, validation, casting, profiling) with type-only imports, so both
// the browser (lib/dataPrep.ts) and the server refresh job can use it.
import type { Json } from "@/integrations/supabase/types";
import type { ColumnDef } from "@/lib/sqlEngine";

export const PREP_SAVE_ROW_CAP = 5000;

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

// ── Column types ────────────────────────────────────────────────────────

export type PrepColumnType =
  | "text"
  | "integer"
  | "decimal"
  | "date"
  | "boolean"
  | "location"
  | "category"
  | "currency"
  | "percent"
  | "id";

export const PREP_TYPE_META: Record<
  PrepColumnType,
  { label: string; storage: ColumnDef["type"]; semantic?: string }
> = {
  text: { label: "Text", storage: "string" },
  integer: { label: "Integer", storage: "number" },
  decimal: { label: "Decimal", storage: "number" },
  date: { label: "Date", storage: "date" },
  boolean: { label: "Boolean", storage: "string", semantic: "boolean" },
  location: { label: "Location", storage: "string", semantic: "location" },
  category: { label: "Category", storage: "string", semantic: "category" },
  currency: { label: "Currency", storage: "number", semantic: "currency" },
  percent: { label: "Percentage", storage: "number", semantic: "percent" },
  id: { label: "Identifier", storage: "string", semantic: "identifier" },
};

function isNumericType(t: PrepColumnType): boolean {
  return t === "integer" || t === "decimal" || t === "currency" || t === "percent";
}

export type PrepJoinType = "INNER JOIN" | "LEFT JOIN" | "RIGHT JOIN" | "FULL OUTER JOIN";
export const PREP_JOIN_TYPES: { value: PrepJoinType; label: string }[] = [
  { value: "LEFT JOIN", label: "Left join" },
  { value: "INNER JOIN", label: "Inner join" },
  { value: "RIGHT JOIN", label: "Right join" },
  { value: "FULL OUTER JOIN", label: "Full outer join" },
];

// ── Source model ──────────────────────────────────────────────────────────

export type PrepJoin = {
  table: string;
  type: PrepJoinType;
  /** One of the tables already on the canvas before this one. */
  leftTable: string;
  leftColumn: string;
  rightColumn: string;
};

export type PrepColumn = {
  /** Stable identity: `${table}.${column}` */
  key: string;
  table: string;
  column: string;
  include: boolean;
  outputName: string;
  type: PrepColumnType;
};

// ── Calculated-field function palette ──────────────────────────────────────

export type PrepFnDef = { label: string; snippet: string; hint: string };
export const PREP_FUNCTIONS: { group: string; fns: PrepFnDef[] }[] = [
  {
    group: "Math",
    fns: [
      { label: "+ − × ÷ %", snippet: "( + )", hint: "Arithmetic and modulo (%)" },
      { label: "ROUND", snippet: "ROUND(, 2)", hint: "Round to N decimal places" },
      { label: "ABS", snippet: "ABS()", hint: "Absolute value" },
      { label: "CEIL", snippet: "CEIL()", hint: "Round up to whole number" },
      { label: "FLOOR", snippet: "FLOOR()", hint: "Round down to whole number" },
      { label: "POWER", snippet: "POWER(, 2)", hint: "Raise to a power" },
      { label: "SQRT", snippet: "SQRT()", hint: "Square root" },
    ],
  },
  {
    group: "Text",
    fns: [
      { label: "CONCAT", snippet: "CONCAT(, )", hint: "Join text values together" },
      { label: "UPPER", snippet: "UPPER()", hint: "Convert to UPPERCASE" },
      { label: "LOWER", snippet: "LOWER()", hint: "Convert to lowercase" },
      { label: "TRIM", snippet: "TRIM()", hint: "Remove leading/trailing spaces" },
      { label: "SUBSTRING", snippet: "SUBSTRING(, 1, 3)", hint: "Extract part of text" },
      { label: "REPLACE", snippet: "REPLACE(, 'a', 'b')", hint: "Find and replace text" },
      { label: "LEN", snippet: "LEN()", hint: "Character count" },
    ],
  },
  {
    group: "Date",
    fns: [
      { label: "YEAR", snippet: "YEAR()", hint: "Extract the year" },
      { label: "MONTH", snippet: "MONTH()", hint: "Extract the month (1–12)" },
      { label: "DAY", snippet: "DAY()", hint: "Extract the day of month" },
      {
        label: "DATE_TRUNC",
        snippet: "DATE_TRUNC('month', )",
        hint: "Truncate to year/quarter/month/day",
      },
    ],
  },
  {
    group: "Logic",
    fns: [
      {
        label: "CASE",
        snippet: "CASE WHEN  > 0 THEN 'yes' ELSE 'no' END",
        hint: "Conditional / if-then-else",
      },
      { label: "COALESCE", snippet: "COALESCE(, )", hint: "First non-empty value" },
    ],
  },
];

// ── Filters ─────────────────────────────────────────────────────────────────

export const PREP_FILTER_OPS = [
  { value: "=", label: "equals", needsValue: true },
  { value: "!=", label: "not equals", needsValue: true },
  { value: ">", label: "greater than", needsValue: true },
  { value: ">=", label: "≥ at least", needsValue: true },
  { value: "<", label: "less than", needsValue: true },
  { value: "<=", label: "≤ at most", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "starts_with", label: "starts with", needsValue: true },
  { value: "ends_with", label: "ends with", needsValue: true },
  { value: "is_null", label: "is empty", needsValue: false },
  { value: "is_not_null", label: "is not empty", needsValue: false },
] as const;
export type PrepFilterOp = (typeof PREP_FILTER_OPS)[number]["value"];
export type PrepFilterCombine = "AND" | "OR";
export type PrepFilter = { id: string; column: string; op: PrepFilterOp; value: string };

// ── Aggregate / summarize ────────────────────────────────────────────────────

export const PREP_AGG_FNS = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "count", label: "Count rows" },
  { value: "count_distinct", label: "Count distinct" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
] as const;
export type PrepAggFn = (typeof PREP_AGG_FNS)[number]["value"];
/** Whether a measure aggregates a specific column (false only for count rows). */
export function aggNeedsColumn(fn: PrepAggFn): boolean {
  return fn !== "count";
}
export type PrepMeasure = { id: string; column: string; fn: PrepAggFn; name: string };

// ── Transform steps ─────────────────────────────────────────────────────────
// An ordered, reorderable pipeline. Each step transforms the relation produced
// by the step before it.

export type PrepStep =
  | { id: string; kind: "calc"; name: string; expr: string; type: PrepColumnType }
  | { id: string; kind: "filter"; combine: PrepFilterCombine; conditions: PrepFilter[] }
  | { id: string; kind: "aggregate"; groupBy: string[]; measures: PrepMeasure[] }
  | { id: string; kind: "append"; table: string; columns: string[]; mode: "all" | "distinct" }
  | {
      id: string;
      kind: "unpivot";
      keep: string[];
      value: string[];
      nameField: string;
      valueField: string;
    }
  | {
      id: string;
      kind: "pivot";
      group: string[];
      pivotColumn: string;
      valueColumn: string;
      agg: PrepAggFn;
      values: string[];
    }
  | {
      id: string;
      kind: "split";
      column: string;
      delimiter: string;
      into: string[];
      keepOriginal: boolean;
    }
  | { id: string; kind: "dedupe"; columns: string[] }
  | {
      id: string;
      kind: "replace";
      column: string;
      find: string;
      replaceWith: string;
      mode: "substring" | "exact";
    };

export type PrepStepKind = PrepStep["kind"];

export const PREP_STEP_KINDS: { kind: PrepStepKind; label: string; hint: string }[] = [
  { kind: "calc", label: "Calculated field", hint: "Add a column from a formula" },
  { kind: "filter", label: "Filter rows", hint: "Keep only rows that match" },
  { kind: "aggregate", label: "Summarize", hint: "Group by and roll up with measures" },
  { kind: "append", label: "Append rows", hint: "Union rows from another dataset" },
  { kind: "pivot", label: "Pivot", hint: "Turn row values into columns" },
  { kind: "unpivot", label: "Unpivot", hint: "Turn columns into rows (wide → long)" },
  { kind: "split", label: "Split column", hint: "Split text into multiple columns" },
  { kind: "dedupe", label: "Remove duplicates", hint: "Drop duplicate rows" },
  { kind: "replace", label: "Find & replace", hint: "Replace values in a column" },
];

export function prepStepLabel(step: PrepStep): string {
  const base = PREP_STEP_KINDS.find((k) => k.kind === step.kind)?.label ?? step.kind;
  switch (step.kind) {
    case "calc":
      return `${base}: ${step.name || "(unnamed)"}`;
    case "filter":
      return `${base} (${step.conditions.length})`;
    case "aggregate":
      return `${base} by ${step.groupBy.join(", ") || "(total)"}`;
    case "append":
      return `${base}: ${step.table || "(pick a table)"}`;
    case "pivot":
      return `${base}: ${step.pivotColumn || "(column)"}`;
    case "unpivot":
      return `${base}: ${step.value.length} columns`;
    case "split":
      return `${base}: ${step.column || "(column)"}`;
    case "dedupe":
      return step.columns.length > 0 ? `${base} by ${step.columns.join(", ")}` : base;
    case "replace":
      return `${base}: ${step.column || "(column)"}`;
  }
}

/** Build a sensible default step of the given kind for the available columns. */
export function makeStep(kind: PrepStepKind, cols: PrepSchemaCol[]): PrepStep {
  const names = cols.map((c) => c.name);
  const firstNumeric = cols.find((c) => isNumericType(c.type))?.name ?? names[0] ?? "";
  const firstText = cols.find((c) => !isNumericType(c.type))?.name ?? names[0] ?? "";
  switch (kind) {
    case "calc":
      return { id: uid(), kind, name: freshName("new_field", names), expr: "", type: "decimal" };
    case "filter":
      return {
        id: uid(),
        kind,
        combine: "AND",
        conditions: [{ id: uid(), column: names[0] ?? "", op: "=", value: "" }],
      };
    case "aggregate":
      return { id: uid(), kind, groupBy: firstText ? [firstText] : [], measures: [] };
    case "append":
      return { id: uid(), kind, table: "", columns: [], mode: "all" };
    case "unpivot":
      return { id: uid(), kind, keep: [], value: [], nameField: "metric", valueField: "value" };
    case "pivot":
      return {
        id: uid(),
        kind,
        group: firstText ? [firstText] : [],
        pivotColumn: "",
        valueColumn: firstNumeric,
        agg: "sum",
        values: [],
      };
    case "split":
      return {
        id: uid(),
        kind,
        column: firstText,
        delimiter: ",",
        into: [freshName("part_1", names), freshName("part_2", names)],
        keepOriginal: true,
      };
    case "dedupe":
      return { id: uid(), kind, columns: [] };
    case "replace":
      return { id: uid(), kind, column: firstText, find: "", replaceWith: "", mode: "substring" };
  }
}

function freshName(baseName: string, taken: string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(baseName.toLowerCase())) return baseName;
  let i = 2;
  const m = baseName.match(/^(.*?)(\d+)$/);
  const stem = m ? m[1] : `${baseName}_`;
  while (lower.has(`${stem}${i}`.toLowerCase())) i++;
  return `${stem}${i}`;
}

// ── Flow config ─────────────────────────────────────────────────────────────

/**
 * Where a table on the canvas physically lives.
 *
 * Absent (the default, and every pre-existing flow) means a local dataset.
 * A `warehouse` binding makes the table LIVE — the flow reads it in place
 * instead of a copied snapshot, which is what makes pushdown possible.
 */
export type PrepSourceBinding = {
  kind: "warehouse";
  connectionId: string;
  connectionName: string;
  /** Physical reference in the warehouse, e.g. "public.orders". */
  ref: string;
};

/**
 * Incremental refresh: reprocess only the newest slice instead of rebuilding
 * the whole output. `column` is a DATE output column that advances over time
 * (created_at, updated_at…).
 */
export type PrepIncremental = { column: string };

export type PrepFlowConfig = {
  base: string | null;
  joins: PrepJoin[];
  columns: PrepColumn[];
  steps: PrepStep[];
  /** Flow table name → its origin. Only warehouse-linked tables appear. */
  sources?: Record<string, PrepSourceBinding>;
  /** When set (and eligible), refreshes reprocess from the watermark. */
  incremental?: PrepIncremental;
};

/**
 * The single warehouse connection a flow reads from, or null when it reads
 * local data (or mixes sources — which blocks pushdown, since one query
 * cannot span two systems).
 */
export function prepWarehouseBinding(
  cfg: PrepFlowConfig,
): { connectionId: string; connectionName: string } | null {
  const tables = new Set(prepTables(cfg));
  for (const s of cfg.steps) if (s.kind === "append" && s.table) tables.add(s.table);
  if (tables.size === 0) return null;
  const bindings = [...tables].map((t) => cfg.sources?.[t]);
  if (bindings.some((b) => !b)) return null; // at least one local table
  const ids = new Set(bindings.map((b) => b!.connectionId));
  if (ids.size !== 1) return null; // spans connections
  return { connectionId: bindings[0]!.connectionId, connectionName: bindings[0]!.connectionName };
}

export type PrepTableInfo = { name: string; columns: ColumnDef[] };
export type PrepSchemaCol = { name: string; type: PrepColumnType };

export function emptyPrepConfig(): PrepFlowConfig {
  return { base: null, joins: [], columns: [], steps: [] };
}

export function prepTables(cfg: PrepFlowConfig): string[] {
  return cfg.base ? [cfg.base, ...cfg.joins.map((j) => j.table)] : [];
}

/**
 * Sanitize a name into a safe SQL identifier.
 *
 * Re-exported from lib/datasetParse rather than reimplemented. The copy that
 * used to sit here said it "mirrors sqlEngine.safeTableName EXACTLY —
 * duplicated here because this module is pure (no AlaSQL import), so the
 * server can use it without pulling the browser engine into SSR". That reason
 * has since expired: safeTableName lives in datasetParse, which has ZERO
 * imports, so anything can use it. The two were still identical — but nothing
 * checked that, and this codebase has already been bitten three times by a
 * "mirror" that stopped mirroring.
 */
export { safeTableName as safePrepTableName } from "@/lib/datasetParse";

/** Best-guess join key between two column sets (shared names, prefer *_id). */
export function detectPrepJoinKey(
  left: ColumnDef[],
  right: ColumnDef[],
): { left: string; right: string } | null {
  const rightByLower = new Map(right.map((c) => [c.name.toLowerCase(), c.name]));
  const common = left
    .map((c) => c.name)
    .filter((n) => rightByLower.has(n.toLowerCase()))
    .sort((a, b) => {
      const score = (n: string) => (/_id$/i.test(n) ? 0 : /^id$/i.test(n) ? 1 : 2);
      return score(a) - score(b);
    });
  if (common.length === 0) return null;
  return { left: common[0], right: rightByLower.get(common[0].toLowerCase())! };
}

export function addTableToFlow(
  cfg: PrepFlowConfig,
  table: PrepTableInfo,
  allTables: PrepTableInfo[],
): PrepFlowConfig {
  if (prepTables(cfg).includes(table.name)) return cfg;
  if (!cfg.base) {
    return syncColumns({ ...cfg, base: table.name }, allTables);
  }
  const priors = prepTables(cfg);
  let anchor = priors[priors.length - 1];
  let key: { left: string; right: string } | null = null;
  for (const p of priors) {
    const pInfo = allTables.find((t) => t.name === p);
    if (!pInfo) continue;
    const k = detectPrepJoinKey(pInfo.columns, table.columns);
    if (k) {
      anchor = p;
      key = k;
      break;
    }
  }
  const join: PrepJoin = {
    table: table.name,
    type: "LEFT JOIN",
    leftTable: anchor,
    leftColumn: key?.left ?? "",
    rightColumn: key?.right ?? "",
  };
  return syncColumns({ ...cfg, joins: [...cfg.joins, join] }, allTables);
}

export function removeTableFromFlow(cfg: PrepFlowConfig, name: string): PrepFlowConfig {
  if (cfg.base === name) {
    if (cfg.joins.length === 0) return emptyPrepConfig();
    // Removing the base with joins present: promote the first joined table to
    // be the new base. Joins that keyed off the removed base are re-pointed at
    // the promoted table with their key cleared, so the preview flags exactly
    // what needs re-picking instead of silently guessing a join key.
    const [promoted, ...rest] = cfg.joins;
    const newBase = promoted.table;
    const joins = rest.map((j) =>
      j.leftTable === name ? { ...j, leftTable: newBase, leftColumn: "" } : j,
    );
    return {
      ...cfg,
      base: newBase,
      joins,
      columns: cfg.columns.filter((c) => c.table !== name),
    };
  }
  const joins = cfg.joins.filter((j) => j.table !== name);
  const repaired = joins.map((j) =>
    j.leftTable === name ? { ...j, leftTable: cfg.base ?? "", leftColumn: "", rightColumn: "" } : j,
  );
  return {
    ...cfg,
    joins: repaired,
    columns: cfg.columns.filter((c) => c.table !== name),
  };
}

function safeIdent(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+/g, "_");
  return cleaned || "col";
}

export function syncColumns(cfg: PrepFlowConfig, allTables: PrepTableInfo[]): PrepFlowConfig {
  const tables = prepTables(cfg)
    .map((n) => allTables.find((t) => t.name === n))
    .filter((t): t is PrepTableInfo => Boolean(t));

  const nameCounts = new Map<string, number>();
  for (const t of tables) {
    for (const c of t.columns) {
      const k = c.name.toLowerCase();
      nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
    }
  }

  const existing = new Map(cfg.columns.map((c) => [c.key, c]));
  const columns: PrepColumn[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const key = `${t.name}.${c.name}`;
      const prev = existing.get(key);
      if (prev) {
        columns.push(prev);
        continue;
      }
      const collides = (nameCounts.get(c.name.toLowerCase()) ?? 0) > 1;
      columns.push({
        key,
        table: t.name,
        column: c.name,
        include: true,
        outputName: safeIdent(collides ? `${t.name}_${c.name}` : c.name),
        type: c.type === "number" ? "decimal" : c.type === "date" ? "date" : "text",
      });
    }
  }
  return { ...cfg, columns };
}

// ── Schema evolution ──────────────────────────────────────────────────────
// Fold the column schema through the pipeline so downstream editors, typing,
// casting and profiling all know the shape at any point.

export function sourceColumns(cfg: PrepFlowConfig): PrepSchemaCol[] {
  return cfg.columns.filter((c) => c.include).map((c) => ({ name: c.outputName, type: c.type }));
}

function stepOutputSchema(inCols: PrepSchemaCol[], step: PrepStep): PrepSchemaCol[] {
  const typeOf = (n: string): PrepColumnType => inCols.find((c) => c.name === n)?.type ?? "text";
  switch (step.kind) {
    case "calc":
      return [...inCols, { name: step.name, type: step.type }];
    case "filter":
    case "append":
    case "dedupe":
    case "replace":
      return inCols;
    case "aggregate": {
      const out: PrepSchemaCol[] = step.groupBy.map((g) => ({ name: g, type: typeOf(g) }));
      for (const m of step.measures) {
        const type: PrepColumnType =
          m.fn === "count" || m.fn === "count_distinct"
            ? "integer"
            : m.fn === "sum" || m.fn === "avg"
              ? "decimal"
              : typeOf(m.column);
        out.push({ name: m.name, type });
      }
      return out;
    }
    case "unpivot": {
      const keep = step.keep.map((k) => ({ name: k, type: typeOf(k) }));
      const valType: PrepColumnType = step.value.length > 0 ? typeOf(step.value[0]) : "text";
      return [
        ...keep,
        { name: step.nameField, type: "category" },
        { name: step.valueField, type: valType },
      ];
    }
    case "pivot": {
      const g = step.group.map((x) => ({ name: x, type: typeOf(x) }));
      const vType: PrepColumnType =
        step.agg === "count" || step.agg === "count_distinct"
          ? "integer"
          : step.agg === "sum" || step.agg === "avg"
            ? "decimal"
            : typeOf(step.valueColumn);
      return [...g, ...step.values.map((v) => ({ name: v, type: vType }))];
    }
    case "split": {
      const base = step.keepOriginal ? inCols : inCols.filter((c) => c.name !== step.column);
      return [...base, ...step.into.map((n) => ({ name: n, type: "text" as PrepColumnType }))];
    }
  }
}

export function schemaAfter(cfg: PrepFlowConfig, upto: number): PrepSchemaCol[] {
  let cols = sourceColumns(cfg);
  for (let i = 0; i < upto && i < cfg.steps.length; i++) {
    cols = stepOutputSchema(cols, cfg.steps[i]);
  }
  return cols;
}

/** Columns available as input to the step at `index`. */
export function stepInputColumns(cfg: PrepFlowConfig, index: number): PrepSchemaCol[] {
  return schemaAfter(cfg, index);
}

/** Final output schema after every step. */
export function effectiveOutputColumns(cfg: PrepFlowConfig): PrepSchemaCol[] {
  return schemaAfter(cfg, cfg.steps.length);
}

// ── SQL compilation ─────────────────────────────────────────────────────────

/**
 * SQL dialect the pipeline compiles to.
 *
 * ONE compiler serves both execution paths — the local AlaSQL engine and
 * pushdown into a warehouse. A second warehouse-only compiler would inevitably
 * drift from this one, and "the same flow returns different numbers depending
 * on where it ran" is the exact failure this design refuses.
 */
export type PrepDialect =
  | "alasql"
  // The local columnar engine, and the default. ANSI quoting, ANSI
  // string escaping, and a 1-based SPLIT_PART — so it needs no special cases
  // below; it is listed for exhaustiveness, not for exceptions.
  | "duckdb"
  | "postgres"
  | "mysql"
  | "snowflake"
  | "bigquery"
  | "redshift"
  | "databricks"
  | "azure_synapse"
  | "trino"
  | "athena"
  | "oracle";

const BACKTICK_DIALECTS = new Set<PrepDialect>(["alasql", "mysql", "bigquery", "databricks"]);

function quoteFor(dialect: PrepDialect): (ident: string) => string {
  // Identifiers here are all safeIdent()-shaped, so quoting can never inject.
  return BACKTICK_DIALECTS.has(dialect)
    ? (ident: string) => `\`${ident}\``
    : (ident: string) => `"${ident}"`;
}

// (A module-level `q` hard-wired to AlaSQL backticks lived here. It was
// shadowed at every use — measureSql/filterSql/pivotCell take `q` as a
// parameter and buildStepSql declares its own from the real dialect — so
// it was dead, and dead code pinned to the wrong dialect is a trap.)
const sqlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;
const isNumericLiteral = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());

/**
 * Split one text column into the n-th part, per dialect.
 *
 * Only dialects with a proven 1-based equivalent are listed; anything absent
 * is refused by the fold analyzer rather than approximated.
 */
function splitPartSql(dialect: PrepDialect, col: string, delim: string, n: number): string {
  const d = sqlStr(delim);
  switch (dialect) {
    case "bigquery":
      return `SPLIT(${col}, ${d})[SAFE_OFFSET(${n - 1})]`;
    case "databricks":
      return `SPLIT(${col}, ${d})[${n - 1}]`;
    case "mysql":
      // SUBSTRING_INDEX returns everything up to the n-th part, so peel the
      // last one off to isolate it.
      return n === 1
        ? `SUBSTRING_INDEX(${col}, ${d}, 1)`
        : `SUBSTRING_INDEX(SUBSTRING_INDEX(${col}, ${d}, ${n}), ${d}, -1)`;
    default:
      // alasql (custom fn), postgres, redshift, snowflake, trino, athena, oracle
      return `SPLIT_PART(${col}, ${d}, ${n})`;
  }
}
const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");

function measureSql(m: PrepMeasure, q: (s: string) => string): string {
  switch (m.fn) {
    case "count":
      return "COUNT(*)";
    case "count_distinct":
      return `COUNT(DISTINCT ${q(m.column)})`;
    default:
      return `${m.fn.toUpperCase()}(${q(m.column)})`; // sum / avg / min / max
  }
}

function filterSql(f: PrepFilter, q: (s: string) => string): string {
  const col = q(f.column);
  switch (f.op) {
    case "is_null":
      return `${col} IS NULL`;
    case "is_not_null":
      return `${col} IS NOT NULL`;
    case "contains":
      return `${col} LIKE ${sqlStr(`%${f.value}%`)}`;
    case "starts_with":
      return `${col} LIKE ${sqlStr(`${f.value}%`)}`;
    case "ends_with":
      return `${col} LIKE ${sqlStr(`%${f.value}`)}`;
    default: {
      const v = isNumericLiteral(f.value) ? f.value.trim() : sqlStr(f.value);
      return `${col} ${f.op} ${v}`;
    }
  }
}

function pivotCell(
  agg: PrepAggFn,
  pivotCol: string,
  val: string,
  valueCol: string,
  q: (s: string) => string,
): string {
  const cond = `${q(pivotCol)} = ${sqlStr(val)}`;
  if (agg === "count") return `COUNT(CASE WHEN ${cond} THEN 1 END)`;
  if (agg === "count_distinct") return `COUNT(DISTINCT CASE WHEN ${cond} THEN ${q(valueCol)} END)`;
  return `${agg.toUpperCase()}(CASE WHEN ${cond} THEN ${q(valueCol)} END)`;
}

/** Compile one step, wrapping the previous relation `sql` as a derived table. */
function compileStep(
  sql: string,
  step: PrepStep,
  inCols: PrepSchemaCol[],
  dialect: PrepDialect,
  tableRef: (name: string) => string,
): string {
  const q = quoteFor(dialect);
  const src = `(\n${indent(sql)}\n) AS _s`;
  switch (step.kind) {
    case "calc":
      return `SELECT *, (${step.expr.trim()}) AS ${q(step.name)}\nFROM ${src}`;
    case "filter": {
      const where = step.conditions.map((c) => filterSql(c, q)).join(`\n  ${step.combine} `);
      return `SELECT *\nFROM ${src}\nWHERE ${where}`;
    }
    case "aggregate": {
      const sel = [
        ...step.groupBy.map(q),
        ...step.measures.map((m) => `${measureSql(m, q)} AS ${q(m.name)}`),
      ].join(", ");
      const gb = step.groupBy.length > 0 ? `\nGROUP BY ${step.groupBy.map(q).join(", ")}` : "";
      return `SELECT ${sel}\nFROM ${src}${gb}`;
    }
    case "append": {
      const cols = inCols.map((c) => c.name);
      const left = `SELECT ${cols.map(q).join(", ")}\nFROM ${src}`;
      const right = `SELECT ${cols
        .map((c) => (step.columns.includes(c) ? q(c) : `NULL AS ${q(c)}`))
        .join(", ")}\nFROM ${tableRef(step.table)}`;
      return `${left}\nUNION ${step.mode === "all" ? "ALL " : ""}${right}`;
    }
    case "unpivot": {
      const keepSel = step.keep.map(q);
      const parts = step.value.map(
        (v) =>
          `SELECT ${keepSel
            .concat([`${sqlStr(v)} AS ${q(step.nameField)}`, `${q(v)} AS ${q(step.valueField)}`])
            .join(", ")}\nFROM ${src}`,
      );
      return parts.join("\nUNION ALL\n");
    }
    case "pivot": {
      const cells = step.values.map(
        (v) => `${pivotCell(step.agg, step.pivotColumn, v, step.valueColumn, q)} AS ${q(v)}`,
      );
      const sel = [...step.group.map(q), ...cells].join(", ");
      const gb = step.group.length > 0 ? `\nGROUP BY ${step.group.map(q).join(", ")}` : "";
      return `SELECT ${sel}\nFROM ${src}${gb}`;
    }
    case "split": {
      const parts = step.into.map(
        (n, i) => `${splitPartSql(dialect, q(step.column), step.delimiter, i + 1)} AS ${q(n)}`,
      );
      if (step.keepOriginal) return `SELECT *, ${parts.join(", ")}\nFROM ${src}`;
      const kept = inCols.filter((c) => c.name !== step.column).map((c) => q(c.name));
      return `SELECT ${kept.concat(parts).join(", ")}\nFROM ${src}`;
    }
    case "dedupe": {
      if (step.columns.length === 0) return `SELECT DISTINCT *\nFROM ${src}`;
      const others = inCols.filter((c) => !step.columns.includes(c.name));
      const sel = [
        ...step.columns.map(q),
        ...others.map((c) => `FIRST(${q(c.name)}) AS ${q(c.name)}`),
      ].join(", ");
      return `SELECT ${sel}\nFROM ${src}\nGROUP BY ${step.columns.map(q).join(", ")}`;
    }
    case "replace": {
      const expr =
        step.mode === "exact"
          ? `CASE WHEN ${q(step.column)} = ${sqlStr(step.find)} THEN ${sqlStr(step.replaceWith)} ELSE ${q(step.column)} END`
          : `REPLACE(${q(step.column)}, ${sqlStr(step.find)}, ${sqlStr(step.replaceWith)})`;
      const sel = inCols
        .map((c) => (c.name === step.column ? `${expr} AS ${q(c.name)}` : q(c.name)))
        .join(", ");
      return `SELECT ${sel}\nFROM ${src}`;
    }
  }
}

export type BuildPrepSqlOpts = {
  /** Target SQL dialect. Defaults to the local AlaSQL engine. */
  dialect?: PrepDialect;
  /**
   * Maps a flow table name to its physical reference in the target system.
   * Pushdown passes `schema.table` for the warehouse; the local path quotes
   * the dataset name. Aliased back to the flow's name so every downstream
   * fragment (joins, column refs) keeps working unchanged.
   */
  physicalTable?: (name: string) => string;
};

export function buildPrepSql(cfg: PrepFlowConfig, opts: BuildPrepSqlOpts = {}): string {
  const dialect = opts.dialect ?? "alasql";
  const qq = quoteFor(dialect);
  // A warehouse table is referenced as `schema.table AS flow_name`, so the
  // rest of the compiled SQL can address it by the flow's own table name.
  const tableRef = (name: string) =>
    opts.physicalTable ? `${opts.physicalTable(name)} AS ${qq(name)}` : qq(name);

  const proj = cfg.columns
    .filter((c) => c.include)
    .map((c) => `${qq(c.table)}.${qq(c.column)} AS ${qq(c.outputName)}`);
  let sql = [
    `SELECT ${proj.join(", ")}`,
    `FROM ${tableRef(cfg.base!)}`,
    ...cfg.joins.map(
      (j) =>
        `${j.type} ${tableRef(j.table)} ON ${qq(j.leftTable)}.${qq(j.leftColumn)} = ${qq(j.table)}.${qq(j.rightColumn)}`,
    ),
  ].join("\n");

  let cols = sourceColumns(cfg);
  for (const step of cfg.steps) {
    sql = compileStep(sql, step, cols, dialect, tableRef);
    cols = stepOutputSchema(cols, step);
  }
  return sql;
}

// ── Pushdown (query folding) eligibility ──────────────────────────────────
//
// "Folding" is Power Query's term for pushing pipeline work into the source
// system; Tableau Prep calls it pushdown. The value is obvious — a summarize
// over 500M warehouse rows should return 200 rows, not drag 500M rows across
// the network — but the risk is subtle: a step that compiles to SQL meaning
// something SLIGHTLY different in the target dialect produces wrong numbers
// silently. So this analyzer proves a flow is foldable and REFUSES otherwise,
// with a reason the UI shows. Anything refused still runs locally.

/** Functions a calculated field may use and still be foldable. */
const FOLDABLE_CALC_FNS = new Set([
  // math
  "ROUND",
  "ABS",
  "CEIL",
  "CEILING",
  "FLOOR",
  "POWER",
  "SQRT",
  "MOD",
  // text
  "CONCAT",
  "UPPER",
  "LOWER",
  "TRIM",
  "SUBSTRING",
  "REPLACE",
  "COALESCE",
  // logic
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS",
  "IN",
  "LIKE",
  "BETWEEN",
  "CAST",
  "AS",
  // date (translated identically by every dialect we fold to)
  "YEAR",
  "MONTH",
  "DAY",
]);

/** Dialects whose SPLIT/date semantics we have proven translations for. */
const FOLDABLE_DIALECTS = new Set<PrepDialect>([
  "postgres",
  "redshift",
  "snowflake",
  "bigquery",
  "databricks",
  "mysql",
  "trino",
  "athena",
]);

export type FoldVerdict =
  | { foldable: true }
  | { foldable: false; reason: string; stepIndex?: number };

// ── Incremental refresh eligibility ───────────────────────────────────────
//
// Incremental is only SOUND when each output row derives from one input row,
// so reprocessing a tail slice can replace exactly that slice. A summarize
// folds many rows into one — appending fresh aggregates would double-count —
// and a union brings in a table the watermark doesn't govern. Those refuse.

/** Steps that destroy the row-to-row correspondence incremental relies on. */
const NON_INCREMENTAL_STEPS: Record<string, string> = {
  aggregate: "Summarize combines many rows into one, so a partial re-run would double-count.",
  pivot: "Pivot aggregates across the whole dataset, so it can't be built from a slice.",
  dedupe: "Remove-duplicates compares every row, which a partial re-run can't do.",
  append: "Append unions another table that the watermark doesn't cover.",
};

export type IncrementalVerdict =
  | { ok: true; column: string }
  | { ok: false; reason: string; stepIndex?: number };

/**
 * Is incremental refresh sound for this flow, with this watermark column?
 * The column must be a DATE that exists in the SOURCE projection — a value
 * invented by a later step can't filter the source that feeds it.
 */
export function incrementalEligibility(cfg: PrepFlowConfig): IncrementalVerdict {
  const column = cfg.incremental?.column;
  if (!column) return { ok: false, reason: "No watermark column chosen." };
  const src = cfg.columns.find((c) => c.include && c.outputName === column);
  if (!src) {
    return {
      ok: false,
      reason: `"${column}" isn't one of the flow's source columns — pick a column that comes straight from a source table.`,
    };
  }
  if (src.type !== "date") {
    return {
      ok: false,
      reason: `"${column}" must be a Date column (dates compare reliably in storage; other types don't).`,
    };
  }
  for (let i = 0; i < cfg.steps.length; i++) {
    const blocked = NON_INCREMENTAL_STEPS[cfg.steps[i].kind];
    if (blocked) return { ok: false, reason: blocked, stepIndex: i };
  }
  return { ok: true, column };
}

/**
 * The flow, restricted to rows at or after `since`.
 *
 * The filter goes FIRST so the source scan itself is narrowed (and, on a
 * folded flow, the warehouse gets a WHERE it can use an index for). `>=`
 * rather than `>` is deliberate: the caller deletes the same range before
 * inserting, so boundary rows are recomputed exactly once instead of being
 * duplicated (`>=` alone) or lost forever on a tie (`>`).
 */
export function withIncrementalWindow(cfg: PrepFlowConfig, since: string): PrepFlowConfig {
  const column = cfg.incremental?.column;
  if (!column) return cfg;
  return {
    ...cfg,
    steps: [
      {
        id: "__incremental__",
        kind: "filter",
        combine: "AND",
        conditions: [{ id: "__wm__", column, op: ">=", value: since }],
      },
      ...cfg.steps,
    ],
  };
}

/**
 * Can this flow be compiled to `dialect` with semantics identical to the
 * local engine? Returns the first blocking reason, so the UI can name it.
 */
export function foldEligibility(cfg: PrepFlowConfig, dialect: PrepDialect): FoldVerdict {
  if (!FOLDABLE_DIALECTS.has(dialect)) {
    return { foldable: false, reason: `Pushdown isn't supported for ${dialect} yet.` };
  }
  for (let i = 0; i < cfg.steps.length; i++) {
    const s = cfg.steps[i];
    switch (s.kind) {
      case "calc": {
        // Free-text formulas are the main hazard: an unknown function may not
        // exist (or may differ) in the warehouse.
        const used = s.expr.match(/[A-Za-z_][A-Za-z0-9_]*\s*\(/g) ?? [];
        for (const raw of used) {
          const fn = raw.replace(/\s*\($/, "").toUpperCase();
          if (!FOLDABLE_CALC_FNS.has(fn)) {
            return {
              foldable: false,
              stepIndex: i,
              reason: `The calculated field uses ${fn}(), which isn't proven to behave identically on ${dialect}.`,
            };
          }
        }
        break;
      }
      case "dedupe":
        // Column-scoped dedupe uses AlaSQL's FIRST(), which picks an arbitrary
        // row. No portable equivalent keeps the same semantics, and silently
        // swapping in MIN() would change the values. Plain DISTINCT is fine.
        if (s.columns.length > 0) {
          return {
            foldable: false,
            stepIndex: i,
            reason:
              "Remove-duplicates on specific columns keeps an arbitrary row per group, which has no exact SQL equivalent.",
          };
        }
        break;
      default:
        // filter / aggregate / append / pivot / unpivot / split / replace all
        // compile to ANSI constructs (or a dialect-specific SPLIT we've proven).
        break;
    }
  }
  return { foldable: true };
}

// ── Validation ────────────────────────────────────────────────────────────

export type PrepValidation = { ok: true } | { ok: false; error: string };

function uniqueError(names: string[], what: string): string | null {
  const lower = names.map((n) => n.toLowerCase());
  const dupe = lower.find((n, i) => lower.indexOf(n) !== i);
  if (dupe) return `Two ${what} are named "${dupe}" — rename one.`;
  if (names.some((n) => !n.trim())) return `Every ${what.replace(/s$/, "")} needs a name.`;
  return null;
}

export function validatePrepConfig(cfg: PrepFlowConfig): PrepValidation {
  if (!cfg.base) return { ok: false, error: "Drag a table onto the canvas to start." };
  for (const j of cfg.joins) {
    if (!j.leftTable || !j.leftColumn || !j.rightColumn) {
      return {
        ok: false,
        error: `Set the join keys for "${j.table}" (no shared column was detected).`,
      };
    }
  }
  if (!cfg.columns.some((c) => c.include)) {
    return { ok: false, error: "Include at least one output column." };
  }

  let cols = sourceColumns(cfg);
  const dupSource = uniqueError(
    cols.map((c) => c.name),
    "columns",
  );
  if (dupSource) return { ok: false, error: dupSource };

  for (let i = 0; i < cfg.steps.length; i++) {
    const step = cfg.steps[i];
    const avail = new Set(cols.map((c) => c.name));
    const label = `Step ${i + 1}`;
    const missing = (col: string) =>
      ({ ok: false, error: `${label}: column "${col}" is not available here.` }) as const;

    switch (step.kind) {
      case "calc":
        if (!step.name.trim()) return { ok: false, error: `${label}: name the calculated field.` };
        if (avail.has(step.name))
          return { ok: false, error: `${label}: "${step.name}" already exists — rename it.` };
        if (!step.expr.trim()) return { ok: false, error: `${label}: enter a formula.` };
        break;
      case "filter":
        if (step.conditions.length === 0)
          return { ok: false, error: `${label}: add a condition or remove the filter.` };
        for (const f of step.conditions) {
          if (!f.column || !avail.has(f.column)) return missing(f.column || "(none)");
          const op = PREP_FILTER_OPS.find((o) => o.value === f.op);
          if (op?.needsValue && !f.value.trim())
            return { ok: false, error: `${label}: enter a value for the "${f.column}" filter.` };
        }
        break;
      case "aggregate": {
        if (step.groupBy.length === 0 && step.measures.length === 0)
          return { ok: false, error: `${label}: add a group-by field or a measure.` };
        for (const g of step.groupBy) if (!avail.has(g)) return missing(g);
        for (const m of step.measures) {
          if (!m.name.trim()) return { ok: false, error: `${label}: every measure needs a name.` };
          if (aggNeedsColumn(m.fn) && (!m.column || !avail.has(m.column)))
            return missing(m.column || "(none)");
        }
        break;
      }
      case "append":
        if (!step.table) return { ok: false, error: `${label}: choose a table to append.` };
        break;
      case "unpivot":
        if (step.value.length === 0)
          return { ok: false, error: `${label}: choose at least one column to unpivot.` };
        for (const v of step.value) if (!avail.has(v)) return missing(v);
        for (const k of step.keep) if (!avail.has(k)) return missing(k);
        if (!step.nameField.trim() || !step.valueField.trim())
          return { ok: false, error: `${label}: name the key and value fields.` };
        break;
      case "pivot":
        if (!step.pivotColumn || !avail.has(step.pivotColumn))
          return missing(step.pivotColumn || "(none)");
        if (aggNeedsColumn(step.agg) && (!step.valueColumn || !avail.has(step.valueColumn)))
          return missing(step.valueColumn || "(none)");
        for (const g of step.group) if (!avail.has(g)) return missing(g);
        if (step.values.length === 0)
          return {
            ok: false,
            error: `${label}: detect the values of "${step.pivotColumn}" to pivot on.`,
          };
        break;
      case "split":
        if (!step.column || !avail.has(step.column)) return missing(step.column || "(none)");
        if (!step.delimiter) return { ok: false, error: `${label}: enter a delimiter.` };
        if (step.into.length === 0)
          return { ok: false, error: `${label}: add at least one output column.` };
        break;
      case "dedupe":
        for (const c of step.columns) if (!avail.has(c)) return missing(c);
        break;
      case "replace":
        if (!step.column || !avail.has(step.column)) return missing(step.column || "(none)");
        if (!step.find.trim()) return { ok: false, error: `${label}: enter the text to find.` };
        break;
    }

    cols = stepOutputSchema(cols, step);
    const dup = uniqueError(
      cols.map((c) => c.name),
      "fields",
    );
    if (dup) return { ok: false, error: `${label}: ${dup}` };
  }

  if (cols.length === 0) return { ok: false, error: "The flow has no output columns." };
  return { ok: true };
}

// ── Type casting ────────────────────────────────────────────────────────

function castValue(v: unknown, type: PrepColumnType): { value: unknown; failed: boolean } {
  if (v === null || v === undefined || v === "") return { value: null, failed: false };
  switch (type) {
    case "integer":
    case "decimal":
    case "currency":
    case "percent": {
      if (typeof v === "number") {
        return { value: type === "integer" ? Math.round(v) : v, failed: false };
      }
      const cleaned = String(v).replace(/[^0-9eE.+-]/g, "");
      const n = Number(cleaned);
      if (cleaned === "" || Number.isNaN(n)) return { value: null, failed: true };
      return { value: type === "integer" ? Math.round(n) : n, failed: false };
    }
    case "date": {
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return { value: null, failed: true };
        return { value: v.trim().slice(0, 10), failed: false };
      }
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) return { value: null, failed: true };
      const pad = (n: number) => String(n).padStart(2, "0");
      return {
        value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        failed: false,
      };
    }
    case "boolean": {
      const s = String(v).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return { value: "true", failed: false };
      if (["false", "no", "n", "0"].includes(s)) return { value: "false", failed: false };
      return { value: null, failed: true };
    }
    default:
      return { value: typeof v === "string" ? v : String(v), failed: false };
  }
}

export type CastResult = {
  rows: Record<string, unknown>[];
  columns: ColumnDef[];
  failures: Record<string, number>;
};

export function castRows(rows: Record<string, unknown>[], cfg: PrepFlowConfig): CastResult {
  const cols = effectiveOutputColumns(cfg);
  const failures: Record<string, number> = {};
  const out = rows.map((row) => {
    const r: Record<string, unknown> = {};
    for (const c of cols) {
      const { value, failed } = castValue(row[c.name], c.type);
      if (failed) failures[c.name] = (failures[c.name] ?? 0) + 1;
      r[c.name] = value;
    }
    return r;
  });
  return {
    rows: out,
    columns: cols.map((c) => ({ name: c.name, type: PREP_TYPE_META[c.type].storage })),
    failures,
  };
}

// ── Column profiling ──────────────────────────────────────────────────────

export type PrepColProfile = {
  total: number;
  nulls: number;
  distinct: number;
  numeric: boolean;
  min?: number;
  max?: number;
  avg?: number;
};

export function profilePrepColumns(
  rows: Record<string, unknown>[],
  cols: PrepSchemaCol[],
): Record<string, PrepColProfile> {
  const out: Record<string, PrepColProfile> = {};
  for (const c of cols) {
    const numeric = isNumericType(c.type);
    let nulls = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row[c.name];
      if (v === null || v === undefined || v === "") {
        nulls++;
        continue;
      }
      seen.add(typeof v === "object" ? JSON.stringify(v) : String(v));
      if (numeric && typeof v === "number" && Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
        n++;
      }
    }
    out[c.name] = {
      total: rows.length,
      nulls,
      distinct: seen.size,
      numeric,
      ...(numeric && n > 0 ? { min, max, avg: sum / n } : {}),
    };
  }
  return out;
}

// ── Config parsing / legacy migration ────────────────────────────────────

/** Parse persisted config, migrating pre-steps flows (calcs/filters/aggregate). */
export function parsePrepConfig(v: Json): PrepFlowConfig {
  const cfg = (v ?? {}) as Record<string, unknown>;
  const base = typeof cfg.base === "string" ? cfg.base : null;
  const joins = Array.isArray(cfg.joins) ? (cfg.joins as PrepJoin[]) : [];
  const columns = Array.isArray(cfg.columns) ? (cfg.columns as PrepColumn[]) : [];
  const sources =
    cfg.sources && typeof cfg.sources === "object" && !Array.isArray(cfg.sources)
      ? (cfg.sources as Record<string, PrepSourceBinding>)
      : undefined;

  const incremental =
    cfg.incremental &&
    typeof cfg.incremental === "object" &&
    typeof (cfg.incremental as { column?: unknown }).column === "string"
      ? { column: (cfg.incremental as { column: string }).column }
      : undefined;

  if (Array.isArray(cfg.steps)) {
    return { base, joins, columns, steps: cfg.steps as PrepStep[], sources, incremental };
  }

  // Legacy shape: { calcs, filters, aggregate } → ordered steps.
  const steps: PrepStep[] = [];
  const calcs = cfg.calcs;
  if (Array.isArray(calcs)) {
    for (const c of calcs as Array<Record<string, unknown>>) {
      steps.push({
        id: typeof c.id === "string" ? c.id : uid(),
        kind: "calc",
        name: String(c.name ?? ""),
        expr: String(c.expr ?? ""),
        type: (c.type as PrepColumnType) ?? "decimal",
      });
    }
  }
  const filters = cfg.filters as Record<string, unknown> | undefined;
  if (filters && Array.isArray(filters.conditions) && filters.conditions.length > 0) {
    steps.push({
      id: uid(),
      kind: "filter",
      combine: filters.combine === "OR" ? "OR" : "AND",
      conditions: filters.conditions as PrepFilter[],
    });
  }
  const aggregate = cfg.aggregate as Record<string, unknown> | undefined;
  if (
    aggregate &&
    aggregate.enabled &&
    ((Array.isArray(aggregate.groupBy) && aggregate.groupBy.length > 0) ||
      (Array.isArray(aggregate.measures) && aggregate.measures.length > 0))
  ) {
    steps.push({
      id: uid(),
      kind: "aggregate",
      groupBy: Array.isArray(aggregate.groupBy) ? (aggregate.groupBy as string[]) : [],
      measures: Array.isArray(aggregate.measures) ? (aggregate.measures as PrepMeasure[]) : [],
    });
  }

  return { base, joins, columns, steps, sources, incremental };
}
