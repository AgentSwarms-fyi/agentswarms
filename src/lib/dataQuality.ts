// Browser-side reads/writes for quality tests.
//
// Tests are owner-scoped by RLS, so plain Supabase queries are safe here.
// RESULTS are insert-only from the server (the owner may read but not write
// them), which is what stops a red check from being edited green.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  rollupQuality,
  type QualityResult,
  type QualityRollup,
  type QualityStatus,
  type QualityTest,
  type QualityTestConfig,
  type QualityTestKind,
  type QualitySeverity,
} from "@/lib/dataQualityCore";

export async function listQualityTests(tableId?: string): Promise<QualityTest[]> {
  let q = supabase
    .from("data_quality_tests")
    .select("id, table_id, kind, column_name, config, enabled, severity, created_at")
    .order("created_at", { ascending: true });
  if (tableId) q = q.eq("table_id", tableId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    table_id: r.table_id,
    kind: r.kind as QualityTestKind,
    column_name: r.column_name,
    config: (r.config ?? {}) as QualityTestConfig,
    enabled: r.enabled,
    severity: (r.severity === "warn" ? "warn" : "error") as QualitySeverity,
    created_at: r.created_at,
  }));
}

export async function createQualityTest(
  userId: string,
  t: {
    table_id: string;
    kind: QualityTestKind;
    column_name: string | null;
    config: QualityTestConfig;
    severity: QualitySeverity;
  },
): Promise<string> {
  const { data, error } = await supabase
    .from("data_quality_tests")
    .insert({
      user_id: userId,
      table_id: t.table_id,
      kind: t.kind,
      column_name: t.column_name,
      config: t.config as unknown as Json,
      severity: t.severity,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to save the test");
  return data.id;
}

export async function setQualityTestEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("data_quality_tests").update({ enabled }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteQualityTest(id: string): Promise<void> {
  const { error } = await supabase.from("data_quality_tests").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Newest result per test for the given tables (or all of the user's). */
export async function loadLatestQualityResults(tableIds?: string[]): Promise<QualityResult[]> {
  let q = supabase
    .from("data_quality_results")
    .select("id, test_id, table_id, status, failing_rows, total_rows, detail, ran_at")
    .order("ran_at", { ascending: false })
    .limit(5000);
  if (tableIds && tableIds.length > 0) q = q.in("table_id", tableIds);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  const out: QualityResult[] = [];
  for (const r of data ?? []) {
    // Newest-first, so the first sighting of a test is its latest result.
    if (seen.has(r.test_id)) continue;
    seen.add(r.test_id);
    out.push({
      id: r.id,
      test_id: r.test_id,
      table_id: r.table_id,
      status: r.status as QualityStatus,
      failingRows: r.failing_rows,
      totalRows: r.total_rows,
      detail: r.detail ?? "",
      ran_at: r.ran_at,
    });
  }
  return out;
}

/** Full run history for one test, newest first. */
export async function loadQualityHistory(testId: string, limit = 30): Promise<QualityResult[]> {
  const { data, error } = await supabase
    .from("data_quality_results")
    .select("id, test_id, table_id, status, failing_rows, total_rows, detail, ran_at")
    .eq("test_id", testId)
    .order("ran_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    test_id: r.test_id,
    table_id: r.table_id,
    status: r.status as QualityStatus,
    failingRows: r.failing_rows,
    totalRows: r.total_rows,
    detail: r.detail ?? "",
    ran_at: r.ran_at,
  }));
}

/** Per-dataset verdicts, for badging a list of assets in one pass. */
export function rollupByTable(
  tests: QualityTest[],
  results: QualityResult[],
): Map<string, QualityRollup> {
  const byTable = new Map<string, QualityTest[]>();
  for (const t of tests) {
    const arr = byTable.get(t.table_id) ?? [];
    arr.push(t);
    byTable.set(t.table_id, arr);
  }
  const latest = new Map<string, Map<string, { status: QualityStatus; ran_at: string }>>();
  for (const r of results) {
    let m = latest.get(r.table_id);
    if (!m) {
      m = new Map();
      latest.set(r.table_id, m);
    }
    if (!m.has(r.test_id)) m.set(r.test_id, { status: r.status, ran_at: r.ran_at });
  }
  const out = new Map<string, QualityRollup>();
  for (const [tableId, ts] of byTable) {
    out.set(tableId, rollupQuality(ts, latest.get(tableId) ?? new Map()));
  }
  return out;
}
