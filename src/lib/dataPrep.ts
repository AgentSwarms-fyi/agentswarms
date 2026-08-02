// Data preparation — browser-side persistence + "run & save" for prep flows.
//
// The PURE pipeline (model, schema, SQL compiler, validation, casting,
// profiling, config migration) lives in lib/dataPrepCore.ts and is re-exported
// here so existing imports from "@/lib/dataPrep" keep working. This module adds
// the pieces that need the browser SQL engine and the Supabase client:
// materialising results and CRUD on saved flows.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { saveSemantics } from "@/lib/biAgent";
import { BROWSER_SQL_DIALECT } from "@/lib/browserDuckdb";
import { runQueryUnlimited, safeTableName, saveDataset, type DatasetMeta } from "@/lib/sqlEngine";
import {
  buildPrepSql,
  castRows,
  effectiveOutputColumns,
  PREP_SAVE_ROW_CAP,
  PREP_TYPE_META,
  validatePrepConfig,
  type PrepFlowConfig,
} from "@/lib/dataPrepCore";

export * from "@/lib/dataPrepCore";

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

  const sql = buildPrepSql(args.cfg, { dialect: BROWSER_SQL_DIALECT });
  const raw = await runQueryUnlimited(sql, PREP_SAVE_ROW_CAP);
  const cast = castRows(raw.rows, args.cfg);
  if (cast.rows.length === 0) throw new Error("The flow produced no rows — nothing to save.");

  const dataset = await saveDataset({
    userId: args.userId,
    tableName: safeTableName(args.outputName),
    sourceFilename: `prep:${args.flowName}`,
    rows: cast.rows,
    columns: cast.columns,
    versionReason: "prep_run",
  });

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
  refresh_interval_minutes: number | null;
  refresh_enabled: boolean | null;
  last_refresh_at: string | null;
  last_refresh_error: string | null;
};

export async function listPrepFlows(): Promise<PrepFlowRow[]> {
  const { data, error } = await supabase
    .from("user_prep_flows")
    .select(
      "id, user_id, name, config, output_table_id, output_table_name, last_run_at, updated_at, refresh_interval_minutes, refresh_enabled, last_refresh_at, last_refresh_error",
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

/** Configure (or disable) server-side scheduled refresh for a saved flow. */
export async function setPrepRefreshSchedule(args: {
  id: string;
  enabled: boolean;
  intervalMinutes: number | null;
}): Promise<void> {
  const { error } = await supabase
    .from("user_prep_flows")
    .update({
      refresh_enabled: args.enabled,
      refresh_interval_minutes: args.intervalMinutes,
    })
    .eq("id", args.id);
  if (error) throw new Error(error.message);
}

export async function deletePrepFlow(id: string): Promise<void> {
  const { error } = await supabase.from("user_prep_flows").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
