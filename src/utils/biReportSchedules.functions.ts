// Server functions behind a report's Schedule dialog (R509).
//
// Every write goes through here, never straight from the browser: the table
// has no write policy, because who a report may be sent to is checked against
// the instance's policy (accounts on this install, REPORT_EMAIL_DOMAINS),
// which RLS cannot see. Each call resolves the caller and scopes by user_id;
// a report is owner-only, and so are its schedules.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
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

const MISSING_TABLE = /does not exist|schema cache|Could not find the table/i;
const NEEDS_MIGRATION =
  "Scheduling needs a database update this install has not applied yet " +
  "(migration 20261118000000_bi_report_schedules). Ask an administrator to apply it.";

export type ReportScheduleView = {
  id: string;
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
    report_id: String(row.report_id),
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

/** The caller's report's parameters; throws when the report is not theirs. */
async function ownedReportParams(userId: string, reportId: string) {
  const { data: row, error } = await supabaseAdmin
    .from("bi_reports")
    .select("id, page")
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`This report could not be read: ${error.message}`);
  if (!row) throw new Error("Report not found");
  return reportParams((row.page ?? {}) as ReportPageSetup);
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
    z.object({ accessToken: z.string().min(1), reportId: z.string().uuid() }).parse(input),
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
          needsMigration?: true;
        }
    > => {
      try {
        const me = await resolveCaller(data.accessToken);
        await ownedReportParams(me.id, data.reportId);
        const { isMailerConfigured } = await import("@/lib/email/mailer.server");
        const base = { mailer: isMailerConfigured(), policy: policyNote(), ownerEmail: me.email };
        const { data: rows, error } = await supabaseAdmin
          .from("bi_report_schedules")
          .select("*")
          .eq("report_id", data.reportId)
          .eq("user_id", me.id)
          .order("created_at");
        if (error) {
          if (MISSING_TABLE.test(error.message)) {
            return { ok: true, schedules: [], deliveries: [], needsMigration: true, ...base };
          }
          return { ok: false, error: error.message };
        }
        const { data: dels } = await supabaseAdmin
          .from("bi_report_deliveries")
          .select("id, schedule_id, ran_at, trigger, status, recipients, pages, bytes, detail")
          .eq("report_id", data.reportId)
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
        reportId: z.string().uuid(),
        id: z.string().uuid().nullable().optional(),
        fields: FIELDS,
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; schedule: ReportScheduleView }> => {
    try {
      const me = await resolveCaller(data.accessToken);
      const params = await ownedReportParams(me.id, data.reportId);
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

      const row = {
        user_id: me.id,
        report_id: data.reportId,
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
      if (!data.id) {
        const { count, error: countErr } = await supabaseAdmin
          .from("bi_report_schedules")
          .select("id", { count: "exact", head: true })
          .eq("report_id", data.reportId)
          .eq("user_id", me.id);
        if (countErr) {
          return {
            ok: false,
            error: MISSING_TABLE.test(countErr.message) ? NEEDS_MIGRATION : countErr.message,
          };
        }
        if ((count ?? 0) >= MAX_SCHEDULES_PER_REPORT) {
          return {
            ok: false,
            error: `A report has at most ${MAX_SCHEDULES_PER_REPORT} schedules. Change or delete one.`,
          };
        }
      }
      const q = data.id
        ? supabaseAdmin
            .from("bi_report_schedules")
            .update(row)
            .eq("id", data.id)
            .eq("user_id", me.id)
            .eq("report_id", data.reportId)
        : supabaseAdmin.from("bi_report_schedules").insert(row);
      const { data: saved, error } = await q.select("*").maybeSingle();
      if (error) {
        return {
          ok: false,
          error: MISSING_TABLE.test(error.message) ? NEEDS_MIGRATION : error.message,
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
        reportId: z.string().uuid(),
        param_values: z.record(z.string(), z.string().max(500)),
        timezone: z.string().max(64),
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
        const params = await ownedReportParams(me.id, data.reportId);
        const { runReport } = await import("@/utils/bi/reportSchedule.server");
        const run = await runReport({
          userId: me.id,
          reportId: data.reportId,
          stored: cleanStoredValues(params, data.param_values),
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
