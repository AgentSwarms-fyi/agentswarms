// Data preparation — the visual join/typing pipeline behind the BI
// Workspace "Data preparation" tab.
//
// A prep flow is: a base table + a chain of joins (each new table joins one
// of the tables already on the canvas via a key pair) + per-column output
// settings (include / rename / type). The flow compiles to a single AlaSQL
// SELECT, previews live, and "Run & save" materialises the cast result as a
// regular local dataset (usable everywhere: SQL IDE, BI charts, AI analyst,
// agent tools) while the recipe itself is persisted for re-editing.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { saveSemantics } from "@/lib/biAgent";
import {
  runQueryUnlimited,
  safeTableName,
  saveDataset,
  type ColumnDef,
  type DatasetMeta,
} from "@/lib/sqlEngine";

export const PREP_SAVE_ROW_CAP = 5000;

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

export type PrepJoinType = "INNER JOIN" | "LEFT JOIN" | "RIGHT JOIN" | "FULL OUTER JOIN";
export const PREP_JOIN_TYPES: { value: PrepJoinType; label: string }[] = [
  { value: "LEFT JOIN", label: "Left join" },
  { value: "INNER JOIN", label: "Inner join" },
  { value: "RIGHT JOIN", label: "Right join" },
  { value: "FULL OUTER JOIN", label: "Full outer join" },
];

// ── Flow model ──────────────────────────────────────────────────────────

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

// ── Calculated fields ─────────────────────────────────────────────────────
// A user-authored SQL expression evaluated over the projected output columns
// (the aliases produced by the join step). Compiles to `(expr) AS name`.

export type PrepCalc = {
  id: string;
  /** Output column name (safe identifier). */
  name: string;
  /** SQL expression referencing output column names, e.g. `\`amount\` / \`qty\``. */
  expr: string;
  type: PrepColumnType;
};

/** Function palette shown in the formula editor (grouped, click-to-insert). */
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

// ── Row filters ────────────────────────────────────────────────────────────

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

export type PrepFilter = { id: string; column: string; op: PrepFilterOp; value: string };
export type PrepFilters = { combine: "AND" | "OR"; conditions: PrepFilter[] };

// ── Aggregate / summarize ──────────────────────────────────────────────────

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
export type PrepAggregate = { enabled: boolean; groupBy: string[]; measures: PrepMeasure[] };

export type PrepFlowConfig = {
  base: string | null;
  joins: PrepJoin[];
  columns: PrepColumn[];
  calcs: PrepCalc[];
  filters: PrepFilters;
  aggregate: PrepAggregate;
};

export type PrepTableInfo = { name: string; columns: ColumnDef[] };

export function emptyPrepConfig(): PrepFlowConfig {
  return {
    base: null,
    joins: [],
    columns: [],
    calcs: [],
    filters: { combine: "AND", conditions: [] },
    aggregate: { enabled: false, groupBy: [], measures: [] },
  };
}

/** Column names available to downstream steps (filters, group-by, measures). */
export function preAggOutputNames(cfg: PrepFlowConfig): string[] {
  return [
    ...cfg.columns.filter((c) => c.include).map((c) => c.outputName),
    ...cfg.calcs.map((c) => c.name),
  ];
}

/**
 * The final output schema after every step (calcs, then — if summarizing —
 * the group-by dimensions and measures replace the row-level columns).
 */
export function effectiveOutputColumns(
  cfg: PrepFlowConfig,
): { name: string; type: PrepColumnType }[] {
  const rowLevel: { name: string; type: PrepColumnType }[] = [
    ...cfg.columns.filter((c) => c.include).map((c) => ({ name: c.outputName, type: c.type })),
    ...cfg.calcs.map((c) => ({ name: c.name, type: c.type })),
  ];
  const agg = cfg.aggregate;
  if (agg?.enabled && (agg.groupBy.length > 0 || agg.measures.length > 0)) {
    const typeOf = (n: string): PrepColumnType =>
      rowLevel.find((r) => r.name === n)?.type ?? "text";
    const out: { name: string; type: PrepColumnType }[] = [];
    for (const g of agg.groupBy) out.push({ name: g, type: typeOf(g) });
    for (const m of agg.measures) {
      const type: PrepColumnType =
        m.fn === "count" || m.fn === "count_distinct"
          ? "integer"
          : m.fn === "sum" || m.fn === "avg"
            ? "decimal"
            : typeOf(m.column); // min/max preserve the source column's type
      out.push({ name: m.name, type });
    }
    return out;
  }
  return rowLevel;
}

/**
 * Drop filters / group-by / measures that reference columns no longer present
 * (e.g. after a table or column is removed). Keeps a loaded flow valid.
 */
export function reconcileDerived(cfg: PrepFlowConfig): PrepFlowConfig {
  const avail = new Set(preAggOutputNames(cfg));
  return {
    ...cfg,
    filters: {
      ...cfg.filters,
      conditions: cfg.filters.conditions.filter((f) => avail.has(f.column)),
    },
    aggregate: {
      ...cfg.aggregate,
      groupBy: cfg.aggregate.groupBy.filter((g) => avail.has(g)),
      measures: cfg.aggregate.measures.filter((m) => !aggNeedsColumn(m.fn) || avail.has(m.column)),
    },
  };
}

export function prepTables(cfg: PrepFlowConfig): string[] {
  return cfg.base ? [cfg.base, ...cfg.joins.map((j) => j.table)] : [];
}

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

/**
 * Add a table to the flow. First drop becomes the base; later drops become
 * joins anchored to whichever prior table shares a key (falls back to the
 * base with empty key selects for the user to fill).
 */
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

/** Remove a table (base only when alone; join removal re-anchors dependants). */
export function removeTableFromFlow(cfg: PrepFlowConfig, name: string): PrepFlowConfig {
  if (cfg.base === name) {
    if (cfg.joins.length > 0) return cfg; // UI prevents this; keep config valid
    return emptyPrepConfig();
  }
  const joins = cfg.joins.filter((j) => j.table !== name);
  // Any join that anchored on the removed table falls back to the base.
  const repaired = joins.map((j) =>
    j.leftTable === name ? { ...j, leftTable: cfg.base ?? "", leftColumn: "", rightColumn: "" } : j,
  );
  return reconcileDerived({
    ...cfg,
    joins: repaired,
    columns: cfg.columns.filter((c) => c.table !== name),
  });
}

function safeIdent(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+/g, "_");
  return cleaned || "col";
}

/**
 * Rebuild the output-column list from the tables on the canvas, preserving
 * the user's include/rename/type edits for columns that still exist.
 * Name collisions across tables are auto-prefixed with the table name.
 */
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

// ── SQL compilation ─────────────────────────────────────────────────────

const q = (ident: string) => `\`${ident}\``;
const sqlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;
const isNumericLiteral = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());
const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");

export type PrepValidation = { ok: true } | { ok: false; error: string };

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

  // Column + calculated-field names must be unique and non-empty (they share
  // one SELECT level, so a collision or blank alias is a hard error).
  const rowNames = preAggOutputNames(cfg);
  if (rowNames.some((n) => !n.trim())) {
    return { ok: false, error: "Every column and calculated field needs a name." };
  }
  const lower = rowNames.map((n) => n.toLowerCase());
  const dupe = lower.find((n, i) => lower.indexOf(n) !== i);
  if (dupe) return { ok: false, error: `Two fields are named "${dupe}" — rename one.` };

  for (const c of cfg.calcs) {
    if (!c.expr.trim()) {
      return { ok: false, error: `Calculated field "${c.name || "(unnamed)"}" needs a formula.` };
    }
  }

  const avail = new Set(rowNames);
  for (const f of cfg.filters.conditions) {
    if (!f.column || !avail.has(f.column)) {
      return { ok: false, error: `A filter refers to a column that no longer exists.` };
    }
    const op = PREP_FILTER_OPS.find((o) => o.value === f.op);
    if (op?.needsValue && !f.value.trim()) {
      return { ok: false, error: `Enter a value for the "${f.column}" filter.` };
    }
  }

  const agg = cfg.aggregate;
  if (agg.enabled) {
    if (agg.groupBy.length === 0 && agg.measures.length === 0) {
      return { ok: false, error: "Add a group-by field or a measure to summarize." };
    }
    for (const g of agg.groupBy) {
      if (!avail.has(g)) return { ok: false, error: `Group-by field "${g}" no longer exists.` };
    }
    for (const m of agg.measures) {
      if (!m.name.trim()) return { ok: false, error: "Every measure needs a name." };
      if (aggNeedsColumn(m.fn) && (!m.column || !avail.has(m.column))) {
        return { ok: false, error: `Measure "${m.name}" refers to a missing column.` };
      }
    }
    const outNames = effectiveOutputColumns(cfg).map((c) => c.name.toLowerCase());
    const aggDupe = outNames.find((n, i) => outNames.indexOf(n) !== i);
    if (aggDupe) {
      return { ok: false, error: `Two summarized fields are named "${aggDupe}" — rename one.` };
    }
  }

  return { ok: true };
}

function measureSql(m: PrepMeasure): string {
  switch (m.fn) {
    case "count":
      return "COUNT(*)";
    case "count_distinct":
      return `COUNT(DISTINCT ${q(m.column)})`;
    default:
      return `${m.fn.toUpperCase()}(${q(m.column)})`; // sum / avg / min / max
  }
}

function filterSql(f: PrepFilter): string {
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

/**
 * Compile the flow to a single read-only SELECT. Each step wraps the previous
 * as a derived table so aliases resolve cleanly:
 *   join → (calculated fields) → (row filters) → (aggregate / summarize)
 */
export function buildPrepSql(cfg: PrepFlowConfig): string {
  const selects = cfg.columns
    .filter((c) => c.include)
    .map((c) => `${q(c.table)}.${q(c.column)} AS ${q(c.outputName)}`);
  let sql = [
    `SELECT ${selects.join(", ")}`,
    `FROM ${q(cfg.base!)}`,
    ...cfg.joins.map(
      (j) =>
        `${j.type} ${q(j.table)} ON ${q(j.leftTable)}.${q(j.leftColumn)} = ${q(j.table)}.${q(j.rightColumn)}`,
    ),
  ].join("\n");

  if (cfg.calcs.length > 0) {
    const extra = cfg.calcs.map((c) => `(${c.expr.trim()}) AS ${q(c.name)}`).join(", ");
    sql = `SELECT *, ${extra}\nFROM (\n${indent(sql)}\n) AS _prep_calc`;
  }

  if (cfg.filters.conditions.length > 0) {
    const where = cfg.filters.conditions.map(filterSql).join(`\n  ${cfg.filters.combine} `);
    sql = `SELECT *\nFROM (\n${indent(sql)}\n) AS _prep_flt\nWHERE ${where}`;
  }

  const agg = cfg.aggregate;
  if (agg.enabled && (agg.groupBy.length > 0 || agg.measures.length > 0)) {
    const sel = [
      ...agg.groupBy.map(q),
      ...agg.measures.map((m) => `${measureSql(m)} AS ${q(m.name)}`),
    ].join(", ");
    const groupBy = agg.groupBy.length > 0 ? `\nGROUP BY ${agg.groupBy.map(q).join(", ")}` : "";
    sql = `SELECT ${sel}\nFROM (\n${indent(sql)}\n) AS _prep_agg${groupBy}`;
  }

  return sql;
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
      // ISO-ish strings: keep the calendar date verbatim (parsing them
      // round-trips through UTC and can shift a day in other timezones).
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return { value: null, failed: true };
        return { value: v.trim().slice(0, 10), failed: false };
      }
      // Everything else parses in local time — read back local components.
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
  /** outputName → number of values that could not be converted (set to null). */
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
// Lightweight per-column stats computed over a preview sample so the user can
// spot nulls, cardinality and numeric ranges while shaping the data.

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
  cols: { name: string; type: PrepColumnType }[],
): Record<string, PrepColProfile> {
  const out: Record<string, PrepColProfile> = {};
  for (const c of cols) {
    const numeric =
      c.type === "integer" || c.type === "decimal" || c.type === "currency" || c.type === "percent";
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

// ── Run & save ──────────────────────────────────────────────────────────

export type PrepRunResult = {
  dataset: DatasetMeta;
  rowCount: number;
  capped: boolean;
  failures: Record<string, number>;
};

export async function runAndSavePrep(args: {
  userId: string;
  flowName: string;
  outputName: string;
  cfg: PrepFlowConfig;
}): Promise<PrepRunResult> {
  const valid = validatePrepConfig(args.cfg);
  if (!valid.ok) throw new Error(valid.error);

  const sql = buildPrepSql(args.cfg);
  const raw = runQueryUnlimited(sql, PREP_SAVE_ROW_CAP);
  const cast = castRows(raw.rows, args.cfg);
  if (cast.rows.length === 0) throw new Error("The flow produced no rows — nothing to save.");

  const dataset = await saveDataset({
    userId: args.userId,
    tableName: safeTableName(args.outputName),
    sourceFilename: `prep:${args.flowName}`,
    rows: cast.rows,
    columns: cast.columns,
  });

  // Record semantic tags (location, category, currency…) in the semantic
  // layer so the BI agent and chart tooling know what the columns mean.
  const columnMeta: Record<string, { semantic_type?: string }> = {};
  for (const c of effectiveOutputColumns(args.cfg)) {
    const semantic = PREP_TYPE_META[c.type].semantic;
    if (semantic) columnMeta[c.name] = { semantic_type: semantic };
  }
  try {
    await saveSemantics({
      userId: args.userId,
      tableId: dataset.id,
      table_description: `Prepared dataset built by the "${args.flowName}" data-prep flow`,
      business_name: args.flowName,
      column_meta: columnMeta,
      primary_key: null,
    });
  } catch {
    /* semantics are an enhancement — saving the data already succeeded */
  }

  return {
    dataset,
    rowCount: cast.rows.length,
    capped: raw.capped,
    failures: cast.failures,
  };
}

// ── Flow persistence ────────────────────────────────────────────────────

export type PrepFlowRow = {
  id: string;
  user_id: string;
  name: string;
  config: Json;
  output_table_id: string | null;
  output_table_name: string | null;
  last_run_at: string | null;
  updated_at: string;
};

export function parsePrepConfig(v: Json): PrepFlowConfig {
  const cfg = (v ?? {}) as Partial<PrepFlowConfig>;
  const filters = (cfg.filters ?? {}) as Partial<PrepFilters>;
  const aggregate = (cfg.aggregate ?? {}) as Partial<PrepAggregate>;
  return {
    base: typeof cfg.base === "string" ? cfg.base : null,
    joins: Array.isArray(cfg.joins) ? (cfg.joins as PrepJoin[]) : [],
    columns: Array.isArray(cfg.columns) ? (cfg.columns as PrepColumn[]) : [],
    calcs: Array.isArray(cfg.calcs) ? (cfg.calcs as PrepCalc[]) : [],
    filters: {
      combine: filters.combine === "OR" ? "OR" : "AND",
      conditions: Array.isArray(filters.conditions) ? (filters.conditions as PrepFilter[]) : [],
    },
    aggregate: {
      enabled: Boolean(aggregate.enabled),
      groupBy: Array.isArray(aggregate.groupBy) ? (aggregate.groupBy as string[]) : [],
      measures: Array.isArray(aggregate.measures) ? (aggregate.measures as PrepMeasure[]) : [],
    },
  };
}

export async function listPrepFlows(): Promise<PrepFlowRow[]> {
  const { data, error } = await supabase
    .from("user_prep_flows")
    .select(
      "id, user_id, name, config, output_table_id, output_table_name, last_run_at, updated_at",
    )
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PrepFlowRow[];
}

export async function savePrepFlow(args: {
  id: string | null;
  userId: string;
  name: string;
  cfg: PrepFlowConfig;
  outputTableId?: string | null;
  outputTableName?: string | null;
  markRun?: boolean;
}): Promise<string> {
  const payload = {
    name: args.name,
    config: args.cfg as unknown as Json,
    ...(args.outputTableId !== undefined ? { output_table_id: args.outputTableId } : {}),
    ...(args.outputTableName !== undefined ? { output_table_name: args.outputTableName } : {}),
    ...(args.markRun ? { last_run_at: new Date().toISOString() } : {}),
  };
  if (args.id) {
    const { error } = await supabase.from("user_prep_flows").update(payload).eq("id", args.id);
    if (error) throw new Error(error.message);
    return args.id;
  }
  const { data, error } = await supabase
    .from("user_prep_flows")
    .insert({ ...payload, user_id: args.userId })
    .select("id")
    .single();
  if (error || !data) {
    const msg = error?.message?.includes("duplicate")
      ? `You already have a flow named "${args.name}"`
      : (error?.message ?? "Could not save the flow");
    throw new Error(msg);
  }
  return data.id;
}

export async function deletePrepFlow(id: string): Promise<void> {
  const { error } = await supabase.from("user_prep_flows").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
