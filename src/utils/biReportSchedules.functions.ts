// Server functions behind the Schedule dialog of a report (R509) and of a
// dashboard (R510).
//
// Every write goes through here, never straight from the browser: the table
// has no write policy, because who a report may be sent to is checked against
// the instance's policy (accounts on this install, REPORT_EMAIL_DOMAINS),
// which RLS cannot see. Each call resolves the caller and scopes by user_id;
// reports and dashboards are scheduled by their owner only.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { parseLayout, parsePages, parseWidgets } from "@/lib/biDashboards";
import { parseParams, type BiParamConfig } from "@/lib/biParams";
import {
  cleanPageIds,
  cleanStoredValues,
  cleanSubjectLine,
  MAX_RECIPIENTS,
  MAX_SCHEDULES_PER_REPORT,
  MESSAGE_MAX,
  nextReportRun,
  parseRecipients,
  refusedRecipientsMessage,
  SCHEDULE_NAME_MAX,
  SUBJECT_MAX,
  validateSchedule,
  valuesSummary,
  type ReportCadence,
  type ReportScheduleFields,
} from "@/lib/biReportSchedule";
import { reportParams, type ReportPageSetup } from "@/lib/biReports";
import { callerFailure } from "@/utils/callerLookup.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ id: string; email: string | null }> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Not signed in"));
  return { id: data.user.id, email: data.user.email ?? null };
}

const MISSING_TABLE = /does not exist|schema cache|Could not find the (table|.* column)/i;
const needsMigration = (kind: ScheduleTarget["kind"]) =>
  kind === "dashboard"
    ? "Sending a dashboard needs a database update this install has not applied yet " +
      "(migration 20261119000000_bi_dashboard_schedules). Ask an administrator to apply it."
    : "Scheduling needs a database update this install has not applied yet " +
      "(migration 20261118000000_bi_report_schedules). Ask an administrator to apply it.";

/** What a schedule sends. */
export type ScheduleTarget = { kind: "report" | "dashboard"; id: string };

const TARGET = z.object({ kind: z.enum(["report", "dashboard"]), id: z.string().uuid() });

const targetColumn = (t: ScheduleTarget) => (t.kind === "dashboard" ? "dashboard_id" : "report_id");

export type ReportScheduleView = {
  id: string;
  report_id: string | null;
  dashboard_id: string | null;
  /** A dashboard schedule's page ids; empty = every page. */
  pages: string[];
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
};

export type ReportDeliveryView = {
  id: string;
  schedule_id: string | null;
  ran_at: string;
  trigger: string;
  status: string;
  recipients: number;
  pages: number | null;
  bytes: number | null;
  detail: string | null;
};

function toView(row: Record<string, unknown>): ReportScheduleView {
  return {
    id: String(row.id),
    report_id: (row.report_id as string | null) ?? null,
    dashboard_id: (row.dashboard_id as string | null) ?? null,
    pages: Array.isArray(row.pages) ? (row.pages as string[]) : [],
    name: String(row.name ?? ""),
    enabled: Boolean(row.enabled),
    cadence: String(row.cadence) as ReportCadence,
    at_hour: Number(row.at_hour ?? 8),
    weekday: Number(row.weekday ?? 1),
    month_day: Number(row.month_day ?? 1),
    timezone: String(row.timezone ?? "UTC"),
    recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
    subject: String(row.subject ?? ""),
    message: String(row.message ?? ""),
    param_values:
      row.param_values && typeof row.param_values === "object"
        ? (row.param_values as Record<string, string>)
        : {},
    skip_empty: Boolean(row.skip_empty),
    next_run_at: String(row.next_run_at ?? ""),
    last_run_at: (row.last_run_at as string | null) ?? null,
    last_status: (row.last_status as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
  };
}

/**
 * The caller's report or dashboard: its parameters and, for a dashboard, its
 * page ids. Throws when it is not theirs.
 */
async function ownedTarget(
  userId: string,
  t: ScheduleTarget,
): Promise<{ params: BiParamConfig[]; pageIds: string[] }> {
  if (t.kind === "report") {
    const { data: row, error } = await supabaseAdmin
      .from("bi_reports")
      .select("id, page")
      .eq("id", t.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`This report could not be read: ${error.message}`);
    if (!row) throw new Error("Report not found");
    return { params: reportParams((row.page ?? {}) as ReportPageSetup), pageIds: [] };
  }
  const { data: row, error } = await supabaseAdmin
    .from("bi_dashboards")
    .select("id, filters, widgets, layout, pages")
    .eq("id", t.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`This dashboard could not be read: ${error.message}`);
  if (!row) throw new Error("Dashboard not found");
  const top = parseWidgets(row.widgets);
  const pages = parsePages(row.pages, top, parseLayout(row.layout, top));
  return { params: parseParams(row.filters), pageIds: pages.map((p) => p.id) };
}

// Per process, like the run limits elsewhere: a button pressed in a loop
// must not turn the install into a mail cannon or a report-rendering farm.
const recent = new Map<string, number[]>();
function throttled(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    recent.set(key, hits);
    return true;
  }
  hits.push(now);
  recent.set(key, hits);
  return false;
}

/** How the operator's recipient policy reads, for the dialog to explain. */
function policyNote(): { anyDomain: boolean; domains: string[] } {
  const entries = (process.env.REPORT_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { anyDomain: entries.includes("*"), domains: entries.filter((e) => e !== "*") };
}

export const biReportSchedulesList = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), target: TARGET }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          schedules: ReportScheduleView[];
          deliveries: ReportDeliveryView[];
          mailer: boolean;
          policy: { anyDomain: boolean; domains: string[] };
          ownerEmail: string | null;
          needsMigration?: string;
        }
    > => {
      try {
        const me = await resolveCaller(data.accessToken);
        await ownedTarget(me.id, data.target);
        const { isMailerConfigured } = await import("@/lib/email/mailer.server");
        const base = { mailer: isMailerConfigured(), policy: policyNote(), ownerEmail: me.email };
        const col = targetColumn(data.target);
        const { data: rows, error } = await supabaseAdmin
          .from("bi_report_schedules")
          .select("*")
          .eq(col, data.target.id)
          .eq("user_id", me.id)
          .order("created_at");
        if (error) {
          if (MISSING_TABLE.test(error.message)) {
            return {
              ok: true,
              schedules: [],
              deliveries: [],
              needsMigration: needsMigration(data.target.kind),
              ...base,
            };
          }
          return { ok: false, error: error.message };
        }
        const { data: dels } = await supabaseAdmin
          .from("bi_report_deliveries")
          .select("id, schedule_id, ran_at, trigger, status, recipients, pages, bytes, detail")
          .eq(col, data.target.id)
          .eq("user_id", me.id)
          .order("ran_at", { ascending: false })
          .limit(30);
        return {
          ok: true,
          schedules: (rows ?? []).map((r) => toView(r as Record<string, unknown>)),
          deliveries: (dels ?? []) as ReportDeliveryView[],
          ...base,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

const FIELDS = z.object({
  name: z.string().max(SCHEDULE_NAME_MAX),
  enabled: z.boolean(),
  cadence: z.enum(["daily", "weekdays", "weekly", "monthly"]),
  at_hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  month_day: z.number().int().min(0).max(28),
  timezone: z.string().max(64),
  recipients: z.array(z.string().max(254)).max(MAX_RECIPIENTS * 2),
  subject: z.string().max(SUBJECT_MAX),
  message: z.string().max(MESSAGE_MAX),
  param_values: z.record(z.string(), z.string().max(500)),
  skip_empty: z.boolean(),
});

export const biReportScheduleSave = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        target: TARGET,
        id: z.string().uuid().nullable().optional(),
        fields: FIELDS,
        /** A dashboard's pages to send; empty = every page. */
        pages: z.array(z.string().max(100)).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; schedule: ReportScheduleView }> => {
    try {
      const me = await resolveCaller(data.accessToken);
      const { params, pageIds } = await ownedTarget(me.id, data.target);
      const { valid, invalid } = parseRecipients(data.fields.recipients);
      if (invalid.length)
        return { ok: false, error: `Not an email address: ${invalid.join(", ")}` };
      const fields: ReportScheduleFields = {
        ...data.fields,
        name: data.fields.name.trim(),
        recipients: valid,
        subject: cleanSubjectLine(data.fields.subject),
        message: data.fields.message.trim(),
        param_values: cleanStoredValues(params, data.fields.param_values),
      };
      const problem = validateSchedule(fields);
      if (problem) return { ok: false, error: problem };

      const { recipientCheck } = await import("@/utils/bi/reportSchedule.server");
      const { refused } = await recipientCheck(valid);
      if (refused.length) return { ok: false, error: refusedRecipientsMessage(refused) };

      const col = targetColumn(data.target);
      const row = {
        user_id: me.id,
        [col]: data.target.id,
        // Only a dashboard's row names the R510 columns, so report schedules
        // keep saving on an install that has not applied that migration yet.
        ...(data.target.kind === "dashboard"
          ? { pages: cleanPageIds(data.pages ?? [], pageIds) }
          : {}),
        name: fields.name,
        enabled: fields.enabled,
        cadence: fields.cadence,
        at_hour: fields.at_hour,
        weekday: fields.weekday,
        month_day: fields.month_day,
        timezone: fields.timezone,
        recipients: fields.recipients,
        subject: fields.subject,
        message: fields.message,
        param_values: fields.param_values as Json,
        skip_empty: fields.skip_empty,
        // Worked out from the timing as saved, so an edit to the hour or the
        // zone moves the next run, and switching a schedule back on does not
        // fire it at once for a slot it missed while off.
        next_run_at: nextReportRun(fields, new Date()).toISOString(),
        updated_at: new Date().toISOString(),
      };
      const thing = data.target.kind === "dashboard" ? "dashboard" : "report";
      if (!data.id) {
        const { count, error: countErr } = await supabaseAdmin
          .from("bi_report_schedules")
          .select("id", { count: "exact", head: true })
          .eq(col, data.target.id)
          .eq("user_id", me.id);
        if (countErr) {
          return {
            ok: false,
            error: MISSING_TABLE.test(countErr.message)
              ? needsMigration(data.target.kind)
              : countErr.message,
          };
        }
        if ((count ?? 0) >= MAX_SCHEDULES_PER_REPORT) {
          return {
            ok: false,
            error: `A ${thing} has at most ${MAX_SCHEDULES_PER_REPORT} schedules. Change or delete one.`,
          };
        }
      }
      const q = data.id
        ? supabaseAdmin
            .from("bi_report_schedules")
            .update(row as never)
            .eq("id", data.id)
            .eq("user_id", me.id)
            .eq(col, data.target.id)
        : supabaseAdmin.from("bi_report_schedules").insert(row as never);
      const { data: saved, error } = await q.select("*").maybeSingle();
      if (error) {
        return {
          ok: false,
          error: MISSING_TABLE.test(error.message)
            ? needsMigration(data.target.kind)
            : error.message,
        };
      }
      if (!saved) return { ok: false, error: "Schedule not found" };
      return { ok: true, schedule: toView(saved as Record<string, unknown>) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export const biReportScheduleDelete = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    try {
      const me = await resolveCaller(data.accessToken);
      const { error } = await supabaseAdmin
        .from("bi_report_schedules")
        .delete()
        .eq("id", data.id)
        .eq("user_id", me.id);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export const biReportScheduleSend = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        /** Send only to the caller: a test of what recipients will get. */
        toMe: z.boolean(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; status: string; detail: string | null; recipients: number }> => {
      try {
        const me = await resolveCaller(data.accessToken);
        if (throttled(`send:${me.id}`, 6, 10 * 60_000)) {
          return { ok: false, error: "Too many sends in the last ten minutes. Try again shortly." };
        }
        if (data.toMe && !me.email) {
          return { ok: false, error: "Your account has no email address to send a test to." };
        }
        const { data: row, error } = await supabaseAdmin
          .from("bi_report_schedules")
          .select("*")
          .eq("id", data.id)
          .eq("user_id", me.id)
          .maybeSingle();
        if (error) return { ok: false, error: error.message };
        if (!row) return { ok: false, error: "Schedule not found" };
        const { deliverSchedule } = await import("@/utils/bi/reportSchedule.server");
        const out = await deliverSchedule(
          row as unknown as import("@/utils/bi/reportSchedule.server").ReportScheduleRow,
          { trigger: "manual", onlyTo: data.toMe ? (me.email ?? undefined) : undefined },
        );
        return { ok: true, status: out.status, detail: out.detail, recipients: out.recipients };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

export const biReportSchedulePreview = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        target: TARGET,
        param_values: z.record(z.string(), z.string().max(500)),
        timezone: z.string().max(64),
        pages: z.array(z.string().max(100)).max(100).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          pdf: string;
          pages: number;
          bytes: number;
          values: string;
          fellBack: string[];
          failures: string[];
          empty: boolean;
        }
    > => {
      try {
        const me = await resolveCaller(data.accessToken);
        if (throttled(`preview:${me.id}`, 20, 10 * 60_000)) {
          return {
            ok: false,
            error: "Too many previews in the last ten minutes. Try again shortly.",
          };
        }
        const { params, pageIds } = await ownedTarget(me.id, data.target);
        const stored = cleanStoredValues(params, data.param_values);
        const run =
          data.target.kind === "dashboard"
            ? await (
                await import("@/utils/bi/dashboardSchedule.server")
              ).runDashboard({
                userId: me.id,
                dashboardId: data.target.id,
                stored,
                timezone: data.timezone,
                pageIds: cleanPageIds(data.pages ?? [], pageIds),
              })
            : await (
                await import("@/utils/bi/reportSchedule.server")
              ).runReport({
                userId: me.id,
                reportId: data.target.id,
                stored,
                timezone: data.timezone,
              });
        return {
          ok: true,
          pdf: Buffer.from(run.bytes).toString("base64"),
          pages: run.pages,
          bytes: run.bytes.byteLength,
          values: valuesSummary(run.params, run.values),
          fellBack: run.fellBack,
          failures: run.failures,
          empty: run.empty,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
