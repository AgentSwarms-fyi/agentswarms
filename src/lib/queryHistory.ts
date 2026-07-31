// SQL workbench query history — owner-scoped by RLS, so plain Supabase
// queries are safe from the browser.
import { supabase } from "@/integrations/supabase/client";

export type QueryHistoryEntry = {
  id: string;
  source: "local" | "warehouse";
  connection_id: string | null;
  connection_name: string | null;
  sql: string;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
};

/** Entries kept per user; older ones are trimmed as new queries are recorded. */
export const HISTORY_LIMIT = 200;

/** Longest statement stored — an enormous generated query is not worth keeping whole. */
const MAX_SQL = 20_000;

export async function recordQuery(
  userId: string,
  entry: {
    source: "local" | "warehouse";
    connectionId?: string | null;
    connectionName?: string | null;
    sql: string;
    rowCount?: number | null;
    durationMs?: number | null;
    error?: string | null;
  },
): Promise<void> {
  const sql = entry.sql.trim();
  if (!sql) return;
  const { error } = await supabase.from("sql_query_history").insert({
    user_id: userId,
    source: entry.source,
    connection_id: entry.connectionId ?? null,
    connection_name: entry.connectionName ?? null,
    sql: sql.slice(0, MAX_SQL),
    row_count: entry.rowCount ?? null,
    duration_ms: entry.durationMs ?? null,
    error: entry.error?.slice(0, 500) ?? null,
  });
  if (error) throw new Error(error.message);
  await trimHistory(userId);
}

/**
 * Keep the newest HISTORY_LIMIT entries.
 *
 * Trimming here rather than in the scheduler keeps the work proportional to
 * the user doing it — a person running one query a week never pays for the
 * person running thousands.
 */
async function trimHistory(userId: string): Promise<void> {
  try {
    const { data: stale } = await supabase
      .from("sql_query_history")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(HISTORY_LIMIT, HISTORY_LIMIT + 199);
    if (stale && stale.length > 0) {
      await supabase
        .from("sql_query_history")
        .delete()
        .in(
          "id",
          stale.map((r) => r.id),
        );
    }
  } catch {
    /* trimming is housekeeping — never fail a query over it */
  }
}

export async function loadQueryHistory(limit = 50): Promise<QueryHistoryEntry[]> {
  const { data, error } = await supabase
    .from("sql_query_history")
    .select(
      "id, source, connection_id, connection_name, sql, row_count, duration_ms, error, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    source: r.source === "warehouse" ? "warehouse" : "local",
  }));
}

export async function deleteQueryHistoryEntry(id: string): Promise<void> {
  const { error } = await supabase.from("sql_query_history").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function clearQueryHistory(userId: string): Promise<void> {
  const { error } = await supabase.from("sql_query_history").delete().eq("user_id", userId);
  if (error) throw new Error(error.message);
}

/** Collapse whitespace for a one-line preview in the history list. */
export function previewSql(sql: string, max = 90): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
