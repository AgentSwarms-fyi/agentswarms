// Data preparation — browser-side persistence for prep flows.
//
// The PURE pipeline (model, schema, SQL compiler, validation, casting,
// profiling, config migration) lives in lib/dataPrepCore.ts and is re-exported
// here so existing imports from "@/lib/dataPrep" keep working. This module adds
// the piece that needs the Supabase client: CRUD on saved flows. Running a flow
// and saving its output happens on the server, in utils/bi/prep.server.ts.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { PrepFlowConfig } from "@/lib/dataPrepCore";

export * from "@/lib/dataPrepCore";

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
