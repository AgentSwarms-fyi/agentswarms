// Scheduled report delivery: running, rendering and sending (R509).
//
// One path for all three callers: the scheduler's tick, the "Send now"
// button, and "Preview the PDF" in the schedule dialog. A preview that took a
// different route would be testing something the schedule never does.
//
// A run is the report's OWNER running it: every block's query reads what the
// owner may read (their datasets and the shares granted to them, under their
// masks; their warehouse connections, by their id). Whoever receives the PDF
// receives what the owner chose to send, which is why who may receive it is
// an instance policy (lib/biReportSchedule recipientVerdict), checked when a
// schedule is saved and again here, when it sends.
import { PDFDocument } from "pdf-lib";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reconcileChartFields } from "@/lib/biChartFields";
import type { BiWidget } from "@/lib/biDashboards";
import { substituteParams, type BiParamConfig, type BiParamValues } from "@/lib/biParams";
import { buildReportPdfBytes } from "@/lib/biReportPdf";
import { resolveReportImages } from "@/lib/biReportImages";
import {
  reportParams,
  type BiReport,
  type ReportBlock,
  type ReportPageSetup,
} from "@/lib/biReports";
import {
  attachmentName,
  deliverySubject,
  isValidTimeZone,
  MAX_ATTACHMENT_BYTES,
  nextReportRun,
  recipientVerdict,
  runClock,
  scheduledValues,
  sizeLabel,
  valuesSummary,
  type ReportCadence,
} from "@/lib/biReportSchedule";
import { fillParamTokens } from "@/lib/biReports";

/** A schedule row as stored. */
export type ReportScheduleRow = {
  id: string;
  user_id: string;
  report_id: string;
  name: string;
  enabled: boolean;
  cadence: ReportCadence;
  at_hour: number;
  weekday: number;
  month_day: number;
  timezone: string;
  recipients: string[];
  subject: string;
  message: string;
  param_values: Record<string, string>;
  skip_empty: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type ReportRun = {
  bytes: Uint8Array;
  pages: number;
  reportName: string;
  params: BiParamConfig[];
  values: BiParamValues;
  /** Parameters whose stored value no longer fits, run at their default. */
  fellBack: string[];
  /** "Block title: why", one per block whose query failed. */
  failures: string[];
  /** Every block with a query came back with no rows. */
  empty: boolean;
  /** How many blocks ran a query. */
  queried: number;
};

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** A picture's bytes from the web, through the SSRF guard, size-capped. */
async function fetchPicture(url: string): Promise<Response> {
  const { safeFetch } = await import("@/utils/ssrfGuard.server");
  const res = await safeFetch(url, { signal: AbortSignal.timeout(10_000), blockPrivate: true });
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > IMAGE_MAX_BYTES) throw new Error("picture too large");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > IMAGE_MAX_BYTES) throw new Error("picture too large");
  return new Response(buf, { status: res.status, headers: res.headers });
}

/** The owner's report, as the app's own types. Throws when it is gone. */
async function loadReport(userId: string, reportId: string): Promise<BiReport & { id: string }> {
  const { data: row, error } = await supabaseAdmin
    .from("bi_reports")
    .select("*")
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`The report could not be read: ${error.message}`);
  if (!row) throw new Error("The report no longer exists.");
  const { toReport } = await import("@/utils/biReports.functions");
  const r = toReport(row as Record<string, unknown>);
  return {
    id: r.id,
    name: r.name,
    page: r.page as ReportPageSetup,
    header: r.header,
    footer: r.footer,
    blocks: r.blocks as unknown as ReportBlock[],
  } as BiReport & { id: string };
}

type Runner = (sql: string) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;

/** Re-run one block's query with the values filled, as its owner. */
async function runBlockWidget(
  widget: BiWidget,
  sql: string,
  userId: string,
  local: () => Promise<Runner>,
  rowCap: number,
): Promise<BiWidget> {
  const source = widget.source ?? { kind: "local" as const };
  let res: { columns: string[]; rows: Record<string, unknown>[] };
  if (source.kind === "warehouse") {
    const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
    const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
    // By the OWNER's id: a service-role load without it would read a
    // connection the owner cannot (see bi-embed-security).
    const conn = await loadWarehouseConnectionForUser(
      supabaseAdmin,
      { connectionId: source.connection_id },
      userId,
    );
    const out = await executeWarehouseQuery(conn.config, sql, rowCap, { userId });
    res = { columns: out.columns.map((c) => c.name), rows: out.rows };
  } else if (source.kind === "semantic") {
    throw new Error("a governed source is not run on a schedule; open the report to refresh it");
  } else {
    res = await (await local())(sql);
  }
  const next: BiWidget = {
    ...widget,
    columns: res.columns,
    rows: res.rows,
    truncated: res.rows.length >= rowCap,
    refreshed_at: new Date().toISOString(),
  };
  // A chart keeps drawing when the query's columns move under it, as in the
  // designer (runWidget).
  if (next.chart && next.chart.type !== "table") {
    const fields = reconcileChartFields({
      chart: next.chart,
      columns: res.columns,
      rows: res.rows,
    });
    if (fields.verdict !== "ok") next.chart = fields.chart;
  }
  return next;
}

/**
 * Run a report for given parameter values and lay it out as a PDF. Every
 * block with a query re-runs; one that fails prints as empty and is named in
 * `failures`, rather than printing the numbers its last run left behind.
 */
export async function runReport(opts: {
  userId: string;
  reportId: string;
  stored: Record<string, string>;
  timezone: string;
  now?: Date;
}): Promise<ReportRun> {
  const now = opts.now ?? new Date();
  const report = await loadReport(opts.userId, opts.reportId);
  const params = reportParams(report.page);
  const tz = isValidTimeZone(opts.timezone) ? opts.timezone : "UTC";
  const { values, fellBack } = scheduledValues(params, opts.stored, now, tz);

  const { widgetRowCap } = await import("@/lib/biDashboards");
  const rowCap = widgetRowCap();
  let runner: Promise<Runner> | null = null;
  const local = () => {
    if (!runner) {
      runner = import("@/utils/bi/refresh.server").then((m) =>
        m.localSqlRunnerForUser(opts.userId),
      );
    }
    return runner;
  };

  const failures: string[] = [];
  let queried = 0;
  let withRows = 0;
  const blocks: ReportBlock[] = [];
  for (const b of report.blocks) {
    if (!("widget" in b) || !b.widget.sql?.trim()) {
      blocks.push(b);
      continue;
    }
    queried++;
    const sql = substituteParams(b.widget.sql, params, values);
    try {
      const widget = await runBlockWidget(b.widget, sql, opts.userId, local, rowCap);
      if ((widget.rows ?? []).length > 0) withRows++;
      blocks.push({ ...b, widget } as ReportBlock);
    } catch (e) {
      const title =
        b.widget.title || (b.kind === "fields" ? "Fields" : b.kind === "table" ? "Table" : "Chart");
      failures.push(`${title}: ${(e as Error).message.slice(0, 200)}`);
      blocks.push({ ...b, widget: { ...b.widget, rows: [], columns: [] } } as ReportBlock);
    }
  }

  const images = await resolveReportImages(blocks, (url) => fetchPicture(String(url)));
  const { renderVisualMarkup } = await import("@/utils/bi/reportCharts.server");
  const bytes = await buildReportPdfBytes({
    report: { ...report, blocks },
    images,
    values,
    now,
    clock: runClock(now, tz),
    renderVisual: (block) => (size) =>
      renderVisualMarkup(block.widget.chart!, block.widget.rows ?? [], size),
  });
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  return {
    bytes,
    pages,
    reportName: report.name,
    params,
    values,
    fellBack,
    failures,
    empty: queried > 0 && withRows === 0,
    queried,
  };
}

/** Lower-cased addresses among these that are accounts on this install. */
export async function accountsAmong(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const { data, error } = await supabaseAdmin.rpc("report_recipient_accounts", {
    _emails: emails,
  });
  if (error) throw new Error(`Recipients could not be checked: ${error.message}`);
  return new Set((data ?? []).map((e) => e.toLowerCase()));
}

export async function recipientCheck(recipients: string[]) {
  const accounts = await accountsAmong(recipients);
  return recipientVerdict(recipients, accounts, process.env.REPORT_EMAIL_DOMAINS);
}

async function ownerEmail(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type DeliveryOutcome = {
  status: "sent" | "skipped" | "partial" | "failed";
  detail: string | null;
  recipients: number;
  pages: number | null;
  bytes: number | null;
};

/**
 * Run the report for a schedule and send it. Records the delivery and
 * returns what happened; never throws for a run that failed, because the
 * caller has to stamp the schedule's clock either way.
 */
export async function deliverSchedule(
  s: ReportScheduleRow,
  opts: { trigger: "schedule" | "manual"; onlyTo?: string; now?: Date },
): Promise<DeliveryOutcome> {
  const now = opts.now ?? new Date();
  let outcome: DeliveryOutcome;
  try {
    outcome = await deliverOnce(s, opts.onlyTo, now);
  } catch (e) {
    outcome = {
      status: "failed",
      detail: (e as Error).message.slice(0, 900),
      recipients: 0,
      pages: null,
      bytes: null,
    };
  }
  const { error } = await supabaseAdmin.from("bi_report_deliveries").insert({
    user_id: s.user_id,
    report_id: s.report_id,
    schedule_id: s.id,
    trigger: opts.trigger,
    status: outcome.status,
    recipients: outcome.recipients,
    pages: outcome.pages,
    bytes: outcome.bytes,
    detail: outcome.detail?.slice(0, 1000) ?? null,
  });
  if (error) console.warn(`[report-schedule] delivery not recorded: ${error.message}`);
  return outcome;
}

async function deliverOnce(
  s: ReportScheduleRow,
  onlyTo: string | undefined,
  now: Date,
): Promise<DeliveryOutcome> {
  const { isMailerConfigured, sendMail } = await import("@/lib/email/mailer.server");
  if (!isMailerConfigured()) {
    throw new Error(
      "No mail transport is configured on this install (set SMTP_HOST or RESEND_API_KEY), so nothing was sent.",
    );
  }
  // Who it may go to is decided NOW, not when it was saved: an account can be
  // closed and the operator's domain list can change in between.
  const wanted = onlyTo ? [onlyTo.toLowerCase()] : s.recipients;
  const { allowed, refused } = onlyTo
    ? { allowed: wanted, refused: [] as string[] }
    : await recipientCheck(wanted);
  if (allowed.length === 0) {
    throw new Error(
      `None of the recipients can receive reports from this install any more: ${refused.join(", ")}`,
    );
  }

  const run = await runReport({
    userId: s.user_id,
    reportId: s.report_id,
    stored: s.param_values ?? {},
    timezone: s.timezone,
    now,
  });
  const notes: string[] = [];
  if (run.fellBack.length) {
    notes.push(
      `Run at the default for ${run.fellBack.join(", ")}: the saved value no longer fits.`,
    );
  }
  if (run.failures.length) notes.push(`Not refreshed: ${run.failures.join("; ")}`);
  if (refused.length) notes.push(`Not sent to ${refused.join(", ")}: no longer allowed.`);

  if (s.skip_empty && run.empty && !onlyTo) {
    return {
      status: "skipped",
      detail: ["Every query came back empty, and the schedule skips empty reports.", ...notes].join(
        " ",
      ),
      recipients: 0,
      pages: run.pages,
      bytes: run.bytes.byteLength,
    };
  }
  if (run.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `The PDF is ${sizeLabel(run.bytes.byteLength)}, over the ${sizeLabel(MAX_ATTACHMENT_BYTES)} an email can carry. Show fewer rows or pages.`,
    );
  }

  const tz = isValidTimeZone(s.timezone) ? s.timezone : "UTC";
  const runDay = runClock(now, tz).date;
  const subject = deliverySubject(s.subject, run.reportName, (t) =>
    fillParamTokens(t.replace(/\{\{\s*date\s*\}\}/g, runDay), run.params, run.values),
  );
  const filename = attachmentName(run.reportName, runDay);
  const summary = valuesSummary(run.params, run.values);
  const owner = await ownerEmail(s.user_id);

  const { emailShell } = await import("@/utils/bi/refresh.server");
  // One set of lines for both bodies, so the text part says what the HTML says.
  const attached = `${filename} (${run.pages} ${run.pages === 1 ? "page" : "pages"}, ${sizeLabel(run.bytes.byteLength)})`;
  const notRefreshed = run.failures.length
    ? `Some parts could not be refreshed and are empty in this copy: ${run.failures.join("; ")}`
    : "";
  const signOff = `Sent on a schedule ("${s.name}")${owner ? ` set up by ${owner}` : ""}. Reply to reach them.`;
  const body =
    (s.message.trim()
      ? `<p style="font-size:14px;margin:0 0 12px;white-space:pre-line">${escapeHtml(s.message.trim())}</p>`
      : "") +
    (summary
      ? `<p style="font-size:13px;margin:0 0 6px;color:#374151"><strong>Run for:</strong> ${escapeHtml(summary)}</p>`
      : "") +
    `<p style="font-size:13px;margin:0 0 6px;color:#374151">Attached: ${escapeHtml(attached)}</p>` +
    (notRefreshed
      ? `<p style="font-size:13px;margin:0 0 6px;color:#b45309">${escapeHtml(notRefreshed)}</p>`
      : "") +
    `<p style="font-size:12px;margin:16px 0 0;color:#6b7280">${escapeHtml(signOff)}</p>`;
  const text = [
    s.message.trim(),
    summary ? `Run for: ${summary}` : "",
    `Attached: ${attached}`,
    notRefreshed,
    signOff,
  ]
    .filter(Boolean)
    .join("\n\n");

  let sent = 0;
  const failedTo: string[] = [];
  // One message each: recipients do not see one another's addresses.
  for (const to of allowed) {
    const res = await sendMail({
      to,
      subject,
      html: emailShell(escapeHtml(run.reportName), body, "", ""),
      text,
      replyTo: owner ?? undefined,
      attachments: [{ filename, content: run.bytes, contentType: "application/pdf" }],
    });
    if (res.sent) sent++;
    else failedTo.push(`${to} (${res.reason ?? "not sent"})`);
  }
  if (failedTo.length) notes.push(`Failed for ${failedTo.join(", ")}`);
  const status: DeliveryOutcome["status"] =
    sent === 0
      ? "failed"
      : failedTo.length || refused.length || run.failures.length
        ? "partial"
        : "sent";
  return {
    status,
    detail: notes.length ? notes.join(" ") : null,
    recipients: sent,
    pages: run.pages,
    bytes: run.bytes.byteLength,
  };
}

/** How many schedules one pass sends: each is a full report run. */
const SCHEDULES_PER_PASS = 5;
let processing = false;
let lastProcessed = 0;
const MIN_INTERVAL_MS = 30_000;

/**
 * Send every report schedule that is due. Each one is CLAIMED before it runs
 * by moving its clock on, on the condition that nobody moved it first, so
 * two passes that overlap cannot send the same report twice. A run that then
 * fails has still had its turn: a schedule that stalls on failure would
 * re-run the same broken report every minute.
 */
export async function processDueReportSchedules(force = false): Promise<number> {
  const now = Date.now();
  if (processing) return 0;
  if (!force && now - lastProcessed < MIN_INTERVAL_MS) return 0;
  processing = true;
  lastProcessed = now;
  try {
    const { data: due, error } = await supabaseAdmin
      .from("bi_report_schedules")
      .select("*")
      .eq("enabled", true)
      .lte("next_run_at", new Date().toISOString())
      .order("next_run_at")
      .limit(SCHEDULES_PER_PASS);
    if (error) {
      // Before the migration is applied the table does not exist; that is not
      // a failed pass, there is simply nothing to send.
      if (/does not exist|schema cache|Could not find the table/i.test(error.message)) return 0;
      throw new Error(`could not read due report schedules: ${error.message}`);
    }
    let ran = 0;
    for (const s of (due ?? []) as unknown as ReportScheduleRow[]) {
      const next = nextReportRun(s, new Date()).toISOString();
      const { data: claimed, error: claimErr } = await supabaseAdmin
        .from("bi_report_schedules")
        .update({ next_run_at: next })
        .eq("id", s.id)
        .eq("next_run_at", s.next_run_at)
        .select("id");
      if (claimErr || !(claimed as unknown[] | null)?.length) continue;
      const outcome = await deliverSchedule(s, { trigger: "schedule" });
      await supabaseAdmin
        .from("bi_report_schedules")
        .update({
          last_run_at: new Date().toISOString(),
          last_status: outcome.status,
          last_error: outcome.status === "sent" ? null : (outcome.detail?.slice(0, 500) ?? null),
        })
        .eq("id", s.id);
      if (outcome.status === "failed") {
        const { notifyUser } = await import("@/utils/notify.server");
        await notifyUser(s.user_id, {
          title: `A scheduled report was not sent — "${s.name}"`,
          body: outcome.detail ?? "The run failed.",
          link: `/bi/report/${s.report_id}`,
          kind: "warning",
        });
      }
      ran++;
    }
    return ran;
  } finally {
    processing = false;
  }
}

let lastPurge = 0;

/** Delivery records older than a year, at most hourly; the schedules say what is current. */
export async function purgeOldReportDeliveries(): Promise<void> {
  if (Date.now() - lastPurge < 3_600_000) return;
  lastPurge = Date.now();
  const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const { error } = await supabaseAdmin.from("bi_report_deliveries").delete().lt("ran_at", cutoff);
  if (error && !/does not exist|schema cache|Could not find the table/i.test(error.message)) {
    console.warn(`[report-schedule] old deliveries not purged: ${error.message}`);
  }
}
