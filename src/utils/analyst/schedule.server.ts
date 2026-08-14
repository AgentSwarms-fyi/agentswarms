// Server-side processor for scheduled analyses.
//
// Shares the cron tick with dashboards, prep flows and catalog crawls (see
// bi/refresh.server), and follows the same shape: take what is due, run it,
// record status, advance next_run_at whatever happened — a schedule that
// stops advancing on failure re-runs the same broken query every tick.
//
// It re-executes the analysis's PINNED SQL. No model is called: re-planning
// would let the methodology drift between runs, and a 6am dependency on an LLM
// is a 6am dependency on someone else's uptime. See lib/analystSchedule for
// why that is the honest design rather than merely the cheap one.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  analysisChanges,
  pinnedSteps,
  refreshedTurn,
  runDigest,
  type StepResult,
} from "@/lib/analystSchedule";
import { trimTurnForStorage, type AnalystSource, type AnalystTurn } from "@/lib/aiAnalyst";
import { computeNextRun, runLocalSqlForUser } from "@/utils/bi/refresh.server";

/** How many schedules one pass will process. */
const SCHEDULES_PER_RUN = 10;
const ROW_CAP = 1000;

let processing = false;
let lastProcessed = 0;
const MIN_PROCESS_INTERVAL_MS = 30_000;

/** Run one step's SQL against whatever the analyst is scoped to. */
async function runStepSql(userId: string, source: AnalystSource, sql: string): Promise<StepResult> {
  try {
    if (source.kind === "warehouse") {
      const { loadWarehouseConnectionForUser } =
        await import("@/utils/warehouse/connections.server");
      const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
      const conn = await loadWarehouseConnectionForUser(
        supabaseAdmin,
        { connectionId: source.connection_id },
        userId,
      );
      const res = await executeWarehouseQuery(conn.config, sql, ROW_CAP, { userId });
      return {
        columns: res.columns.map((c) => c.name),
        rows: res.rows,
        rowCount: res.rows.length,
      };
    }
    const res = await runLocalSqlForUser(userId, sql);
    return { columns: res.columns, rows: res.rows, rowCount: res.rows.length };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }
}

/**
 * Refresh one analysis: re-run its pinned steps and store the result.
 *
 * Exported for the "Run now" path, so the button and the scheduler exercise
 * exactly the same code — a "Run now" that took a different route would be
 * testing something the schedule never does.
 */
export async function refreshAnalysisServer(threadId: string): Promise<{
  userId: string;
  title: string;
  changes: string[];
  failures: number;
}> {
  const { data: thread, error } = await supabaseAdmin
    .from("ai_analyst_threads")
    .select("id, user_id, title, turns, analyst_id")
    .eq("id", threadId)
    .single();
  if (error || !thread) throw new Error(error?.message ?? "Analysis not found");

  const { data: analyst } = await supabaseAdmin
    .from("ai_analysts")
    .select("id, source")
    .eq("id", thread.analyst_id)
    .single();
  if (!analyst) throw new Error("The analyst this analysis belongs to no longer exists");
  const source = analyst.source as AnalystSource;

  const turns = (Array.isArray(thread.turns) ? thread.turns : []) as unknown as AnalystTurn[];
  if (turns.length === 0) throw new Error("This analysis has no turns to refresh");

  // The LAST turn is the analysis; earlier ones are its conversation history
  // and re-running them would rewrite answers nobody asked to refresh.
  const index = turns.length - 1;
  const before = turns[index];

  const results: StepResult[] = [];
  for (const s of pinnedSteps(before)) {
    results.push(await runStepSql(thread.user_id, source, s.sql ?? ""));
  }

  const after = refreshedTurn(before, results);
  const changes = analysisChanges(before, after);
  const failures = after.steps.filter((s) => s.error).length;

  const next = turns.slice();
  next[index] = trimTurnForStorage(after);
  const { error: writeErr } = await supabaseAdmin
    .from("ai_analyst_threads")
    .update({ turns: next as never, updated_at: new Date().toISOString() })
    .eq("id", threadId);
  if (writeErr) throw new Error(writeErr.message);

  return { userId: thread.user_id, title: thread.title, changes, failures };
}

/** Refresh every due analysis (idempotent, internally throttled). */
export async function processDueAnalyses(force = false): Promise<number> {
  const now = Date.now();
  if (processing) return 0;
  if (!force && now - lastProcessed < MIN_PROCESS_INTERVAL_MS) return 0;
  processing = true;
  lastProcessed = now;
  try {
    const { data: due } = await supabaseAdmin
      .from("ai_analyst_schedules")
      .select("*")
      .eq("enabled", true)
      .lte("next_run_at", new Date().toISOString())
      .order("next_run_at")
      .limit(SCHEDULES_PER_RUN);

    let ran = 0;
    for (const s of due ?? []) {
      let status = "ok";
      let lastError: string | null = null;
      try {
        const res = await refreshAnalysisServer(s.thread_id);
        const digest = runDigest(res.title, res.changes);
        const { notifyUser } = await import("@/utils/notify.server");
        await notifyUser(res.userId, {
          title: digest.title,
          body: digest.body,
          link: "/ai-analyst",
          kind: res.changes.length > 0 ? "insight" : "info",
        });
        if (res.failures > 0) {
          status = "partial";
          lastError = `${res.failures} step(s) failed`;
        }
        if (s.email_report) {
          const { sendMail } = await import("@/lib/email/mailer.server");
          const { emailShell, siteUrl } = await import("@/utils/bi/refresh.server");
          const { data: u } = await supabaseAdmin.auth.admin.getUserById(res.userId);
          const to = u.user?.email;
          if (to) {
            void sendMail({
              to,
              subject: `🧠 ${res.title} — scheduled analysis`,
              html: emailShell(
                res.title,
                `<p style="font-size:14px;margin:0;white-space:pre-line">${escapeHtml(digest.body)}</p>`,
                `${siteUrl()}/ai-analyst`,
                "Open analysis",
              ),
              text: digest.body,
            }).catch((e) => console.warn("[analyst-schedule] email failed:", (e as Error).message));
          }
        }
      } catch (e) {
        status = "error";
        lastError = (e as Error).message.slice(0, 500);
      }
      // Advance whatever happened: a schedule that stalls on failure re-runs
      // the same broken query every tick and never recovers on its own.
      await supabaseAdmin
        .from("ai_analyst_schedules")
        .update({
          last_run_at: new Date().toISOString(),
          last_status: status,
          last_error: lastError,
          next_run_at: computeNextRun(s.cadence, s.at_hour, s.weekday, new Date()).toISOString(),
        })
        .eq("id", s.id);
      ran++;
    }
    return ran;
  } finally {
    processing = false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
