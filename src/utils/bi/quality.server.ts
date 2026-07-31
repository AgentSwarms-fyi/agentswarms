// Server-side execution of a dataset's quality tests.
//
// Lives on the server because it (a) reads full row volumes with the service
// role, (b) writes data_quality_results, which the owner may only read, and
// (c) raises notifications. The ASSERTIONS themselves are pure and live in
// lib/dataQualityCore, so the same logic is testable without a database.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  anyTestNeedsRows,
  describeQualityTest,
  evaluateQualityTest,
  rollupQuality,
  type QualityOutcome,
  type QualityRollup,
  type QualityTest,
  type QualityTestConfig,
  type QualityTestKind,
} from "@/lib/dataQualityCore";

/** How many rows a check will read. Read per call so a deployment can raise
 *  it without a restart. */
export function qualityRowCap(): number {
  const n = Number(process.env.DATA_QUALITY_ROW_CAP);
  return Number.isFinite(n) && n > 0 ? n : 200_000;
}

/** How often the scheduled sweep re-checks a dataset that has enabled tests. */
function sweepIntervalMs(): number {
  const n = Number(process.env.DATA_QUALITY_INTERVAL_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : 60) * 60_000;
}

const PAGE = 1000;

type TestRow = {
  id: string;
  table_id: string;
  kind: string;
  column_name: string | null;
  config: Json;
  enabled: boolean;
  severity: string;
};

function toTest(r: TestRow): QualityTest {
  return {
    id: r.id,
    table_id: r.table_id,
    kind: r.kind as QualityTestKind,
    column_name: r.column_name,
    config: (r.config ?? {}) as QualityTestConfig,
    enabled: r.enabled,
    severity: r.severity === "warn" ? "warn" : "error",
  };
}

/** Read up to `cap` rows of a dataset, plus the true total. */
async function loadRows(
  tableId: string,
  cap: number,
): Promise<{ rows: Record<string, unknown>[]; total: number; capped: boolean }> {
  const { count } = await supabaseAdmin
    .from("user_data_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", tableId);
  const total = count ?? 0;

  const rows: Record<string, unknown>[] = [];
  for (let start = 0; start < cap; start += PAGE) {
    const { data: chunk, error } = await supabaseAdmin
      .from("user_data_rows")
      .select("row")
      .eq("table_id", tableId)
      .range(start, Math.min(start + PAGE, cap) - 1);
    if (error) throw new Error(error.message);
    if (!chunk || chunk.length === 0) break;
    rows.push(...chunk.map((c) => c.row as Record<string, unknown>));
    if (chunk.length < PAGE) break;
  }
  return { rows, total: Math.max(total, rows.length), capped: total > rows.length };
}

/**
 * Only counting rows — used when every configured test is row-independent
 * (a row_count_min, or a freshness SLA on the dataset's load time). This is
 * what makes an hourly sweep over large tables affordable.
 */
async function countRows(tableId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("user_data_rows")
    .select("id", { count: "exact", head: true })
    .eq("table_id", tableId);
  return count ?? 0;
}

export type QualityRunResult = {
  tableId: string;
  tableName: string;
  rollup: QualityRollup;
  results: { test: QualityTest; outcome: QualityOutcome }[];
};

/**
 * Evaluate every enabled test on one dataset, persist the results, and notify
 * the owner when the dataset's verdict CHANGES.
 *
 * Notifying on change rather than on every failing run is deliberate: a
 * dataset that fails an hourly check would otherwise deliver 24 identical
 * alerts a day, which trains people to ignore them.
 */
export async function runQualityTestsForTable(args: {
  userId: string;
  tableId: string;
  /** Skips notifications — used for the interactive "Run tests" button, where
   *  the user is already looking at the results. */
  quiet?: boolean;
}): Promise<QualityRunResult> {
  const { data: table, error: tErr } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, user_id, data_loaded_at, updated_at, created_at")
    .eq("id", args.tableId)
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (!table) throw new Error("Dataset not found");
  if (table.user_id !== args.userId) throw new Error("Dataset not found");

  const { data: testRows, error: qErr } = await supabaseAdmin
    .from("data_quality_tests")
    .select("id, table_id, kind, column_name, config, enabled, severity")
    .eq("table_id", args.tableId)
    .eq("user_id", args.userId);
  if (qErr) throw new Error(qErr.message);

  const tests = (testRows ?? []).map((r) => toTest(r as TestRow)).filter((t) => t.enabled);
  if (tests.length === 0) {
    return {
      tableId: args.tableId,
      tableName: table.name,
      rollup: rollupQuality([], new Map()),
      results: [],
    };
  }

  // Previous verdict, so we can notify only on a transition.
  const before = await latestResultsFor(args.userId, [args.tableId]);
  const beforeRollup = rollupQuality(tests, before.get(args.tableId) ?? new Map());

  const cap = qualityRowCap();
  const needsRows = anyTestNeedsRows(tests);
  const loaded = needsRows
    ? await loadRows(args.tableId, cap)
    : {
        rows: [] as Record<string, unknown>[],
        total: await countRows(args.tableId),
        capped: false,
      };

  const ctx = {
    rows: loaded.rows,
    totalRows: loaded.total,
    capped: loaded.capped,
    // data_loaded_at, NOT updated_at: the latter is trigger-stamped on any
    // metadata edit, so a rename would make stale data look fresh.
    lastLoadedAt: table.data_loaded_at ?? table.updated_at ?? table.created_at ?? null,
    now: Date.now(),
  };

  const results = tests.map((test) => ({ test, outcome: evaluateQualityTest(test, ctx) }));

  const ranAt = new Date().toISOString();
  const { error: insErr } = await supabaseAdmin.from("data_quality_results").insert(
    results.map(({ test, outcome }) => ({
      test_id: test.id,
      table_id: args.tableId,
      user_id: args.userId,
      status: outcome.status,
      failing_rows: Math.min(outcome.failingRows, 2_147_483_647),
      total_rows: Math.min(outcome.totalRows, 2_147_483_647),
      detail: outcome.detail.slice(0, 1000),
      ran_at: ranAt,
    })),
  );
  if (insErr) throw new Error(insErr.message);

  const latest = new Map(
    results.map(({ test, outcome }) => [test.id, { status: outcome.status, ran_at: ranAt }]),
  );
  const rollup = rollupQuality(tests, latest);

  if (!args.quiet && rollup.status !== beforeRollup.status) {
    await notifyVerdictChange(args.userId, table.name, args.tableId, beforeRollup, rollup, results);
  }

  await pruneResults(args.tableId);
  return { tableId: args.tableId, tableName: table.name, rollup, results };
}

/** Keep result history bounded — this table grows once per test per sweep. */
async function pruneResults(tableId: string): Promise<void> {
  const keep = Number(process.env.DATA_QUALITY_KEEP_RESULTS);
  const limit = Number.isFinite(keep) && keep > 0 ? keep : 500;
  try {
    const { data: old } = await supabaseAdmin
      .from("data_quality_results")
      .select("id")
      .eq("table_id", tableId)
      .order("ran_at", { ascending: false })
      .range(limit, limit + 499);
    if (old && old.length > 0) {
      await supabaseAdmin
        .from("data_quality_results")
        .delete()
        .in(
          "id",
          old.map((r) => r.id),
        );
    }
  } catch {
    /* history pruning is housekeeping — never fail a check over it */
  }
}

async function notifyVerdictChange(
  userId: string,
  tableName: string,
  tableId: string,
  before: QualityRollup,
  after: QualityRollup,
  results: { test: QualityTest; outcome: QualityOutcome }[],
): Promise<void> {
  try {
    const { notifyUser } = await import("@/utils/notify.server");
    const bad = results.filter((r) => r.outcome.status !== "pass");
    if (after.status === "pass") {
      await notifyUser(userId, {
        title: `Data quality recovered — "${tableName}"`,
        body: `All ${after.total} check${after.total === 1 ? "" : "s"} on "${tableName}" pass again.`,
        link: "/catalog",
        kind: "alert",
      });
      return;
    }
    const lines = bad
      .slice(0, 5)
      .map(
        (r) =>
          `• ${describeQualityTest(r.test)}${r.test.severity === "warn" ? " (warn)" : ""}: ${r.outcome.detail}`,
      )
      .join("\n");
    await notifyUser(userId, {
      title:
        after.status === "fail"
          ? `Data quality failing — "${tableName}"`
          : `Data quality ${after.status} — "${tableName}"`,
      body:
        `${bad.length} of ${after.total} check${after.total === 1 ? "" : "s"} on "${tableName}" ` +
        `did not pass (was "${before.status}").\n${lines}` +
        (bad.length > 5 ? `\n…and ${bad.length - 5} more.` : ""),
      link: "/catalog",
      kind: "error",
    });
  } catch (e) {
    console.warn("[data-quality] notification failed:", (e as Error).message);
  }
  void tableId;
}

/** Newest result per test, grouped by table. */
export async function latestResultsFor(
  userId: string,
  tableIds: string[],
): Promise<Map<string, Map<string, { status: QualityOutcome["status"]; ran_at: string }>>> {
  const out = new Map<string, Map<string, { status: QualityOutcome["status"]; ran_at: string }>>();
  if (tableIds.length === 0) return out;
  const { data } = await supabaseAdmin
    .from("data_quality_results")
    .select("test_id, table_id, status, ran_at")
    .eq("user_id", userId)
    .in("table_id", tableIds)
    .order("ran_at", { ascending: false })
    .limit(5000);
  for (const r of data ?? []) {
    let m = out.get(r.table_id);
    if (!m) {
      m = new Map();
      out.set(r.table_id, m);
    }
    // Rows arrive newest-first, so the first sighting of a test wins.
    if (!m.has(r.test_id)) {
      m.set(r.test_id, { status: r.status as QualityOutcome["status"], ran_at: r.ran_at });
    }
  }
  return out;
}

// ── Scheduled sweep ──────────────────────────────────────────────────────

let lastSweep = 0;

/**
 * Re-check every dataset that has enabled tests and has not been checked
 * within the sweep interval.
 *
 * A freshness SLA only means something if it fires when NOTHING happens — a
 * table that stopped refreshing produces no event of its own, so the sweep is
 * the mechanism that notices the silence.
 */
export async function processDueQualityChecks(force = false): Promise<number> {
  const now = Date.now();
  const interval = sweepIntervalMs();
  if (!force && now - lastSweep < Math.min(interval, 5 * 60_000)) return 0;
  lastSweep = now;

  const { data: tests } = await supabaseAdmin
    .from("data_quality_tests")
    .select("table_id, user_id")
    .eq("enabled", true)
    .limit(5000);
  if (!tests || tests.length === 0) return 0;

  // Unique (table, owner) pairs.
  const targets = new Map<string, string>();
  for (const t of tests) targets.set(t.table_id, t.user_id);

  const ids = [...targets.keys()];
  const { data: recent } = await supabaseAdmin
    .from("data_quality_results")
    .select("table_id, ran_at")
    .in("table_id", ids)
    .order("ran_at", { ascending: false })
    .limit(5000);
  const lastRun = new Map<string, number>();
  for (const r of recent ?? []) {
    if (!lastRun.has(r.table_id)) lastRun.set(r.table_id, new Date(r.ran_at).getTime());
  }

  const BATCH_LIMIT = 25;
  let ran = 0;
  for (const [tableId, userId] of targets) {
    if (ran >= BATCH_LIMIT) break;
    const last = lastRun.get(tableId);
    if (!force && last !== undefined && now - last < interval) continue;
    try {
      await runQualityTestsForTable({ userId, tableId });
      ran++;
    } catch (e) {
      console.warn(`[data-quality] check failed for ${tableId}:`, (e as Error).message);
    }
  }
  return ran;
}
