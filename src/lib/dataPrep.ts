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

export type PrepFlowConfig = {
  base: string | null;
  joins: PrepJoin[];
  columns: PrepColumn[];
};

export type PrepTableInfo = { name: string; columns: ColumnDef[] };

export function emptyPrepConfig(): PrepFlowConfig {
  return { base: null, joins: [], columns: [] };
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
    return { base: null, joins: [], columns: [] };
  }
  const joins = cfg.joins.filter((j) => j.table !== name);
  // Any join that anchored on the removed table falls back to the base.
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
  const names = cfg.columns.filter((c) => c.include).map((c) => c.outputName.toLowerCase());
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) return { ok: false, error: `Two output columns are named "${dupe}" — rename one.` };
  if (names.some((n) => !n.trim())) return { ok: false, error: "Output columns need names." };
  return { ok: true };
}

export function buildPrepSql(cfg: PrepFlowConfig): string {
  const selects = cfg.columns
    .filter((c) => c.include)
    .map((c) => `${q(c.table)}.${q(c.column)} AS ${q(c.outputName)}`);
  const lines = [`SELECT ${selects.join(", ")}`, `FROM ${q(cfg.base!)}`];
  for (const j of cfg.joins) {
    lines.push(
      `${j.type} ${q(j.table)} ON ${q(j.leftTable)}.${q(j.leftColumn)} = ${q(j.table)}.${q(j.rightColumn)}`,
    );
  }
  return lines.join("\n");
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
  const included = cfg.columns.filter((c) => c.include);
  const failures: Record<string, number> = {};
  const out = rows.map((row) => {
    const r: Record<string, unknown> = {};
    for (const c of included) {
      const { value, failed } = castValue(row[c.outputName], c.type);
      if (failed) failures[c.outputName] = (failures[c.outputName] ?? 0) + 1;
      r[c.outputName] = value;
    }
    return r;
  });
  return {
    rows: out,
    columns: included.map((c) => ({ name: c.outputName, type: PREP_TYPE_META[c.type].storage })),
    failures,
  };
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
  for (const c of args.cfg.columns) {
    const semantic = PREP_TYPE_META[c.type].semantic;
    if (c.include && semantic) columnMeta[c.outputName] = { semantic_type: semantic };
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
  return {
    base: typeof cfg.base === "string" ? cfg.base : null,
    joins: Array.isArray(cfg.joins) ? (cfg.joins as PrepJoin[]) : [],
    columns: Array.isArray(cfg.columns) ? (cfg.columns as PrepColumn[]) : [],
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
