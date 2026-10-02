// Server functions behind BI → Reports.
//
// A report is owner-only, so every call resolves the caller and scopes by
// user_id. The blocks carry cached rows exactly as a dashboard's widgets do,
// which is what lets a chart lifted off a dashboard keep working here.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  DEFAULT_FOOTER,
  DEFAULT_HEADER,
  DEFAULT_PAGE,
  MAX_BLOCKS,
  REPORT_NAME_MAX,
  clampMargin,
  validateReport,
  type BiReport,
  type ReportBand,
  type ReportBlock,
  type ReportPageSetup,
} from "@/lib/biReports";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

/**
 * A report as it travels over the wire.
 *
 * `blocks` stays `Json` rather than `ReportBlock[]` for the same reason a
 * dashboard's widgets do: the framework proves the return type is
 * serialisable, and a block holds cached rows typed `unknown`. The client
 * parses it back into `ReportBlock[]` on arrival.
 */
export type BiReportRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  page: BiReport["page"];
  header: ReportBand;
  footer: ReportBand;
  blocks: Json;
  created_at: string;
  updated_at: string;
};

/** A stored row as the app's own types, with every default filled in. */
function toReport(row: Record<string, unknown>): BiReportRow {
  const page = (row.page ?? {}) as Partial<ReportPageSetup>;
  const setup: ReportPageSetup = {
    size: page.size ?? DEFAULT_PAGE.size,
    orientation: page.orientation === "landscape" ? "landscape" : "portrait",
    margin: clampMargin(Number(page.margin ?? DEFAULT_PAGE.margin), 595),
  };
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name ?? ""),
    description: (row.description as string | null) ?? null,
    page: setup,
    header: (row.header ?? {}) as ReportBand,
    footer: (row.footer ?? {}) as ReportBand,
    blocks: (Array.isArray(row.blocks) ? row.blocks : []) as unknown as Json,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export const biReportsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<Fail | { ok: true; reports: BiReportRow[] }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: rows, error } = await supabaseAdmin
      .from("bi_reports")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, reports: (rows ?? []).map(toReport) };
  });

export const biReportGet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; report: BiReportRow }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: row } = await supabaseAdmin
      .from("bi_reports")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return { ok: false, error: "Report not found" };
    return { ok: true, report: toReport(row) };
  });

const BAND = z.object({
  left: z.string().max(200).optional(),
  center: z.string().max(200).optional(),
  right: z.string().max(200).optional(),
});

export const biReportSave = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid().nullable().optional(),
        name: z.string().trim().min(1).max(REPORT_NAME_MAX),
        description: z.string().trim().max(2000).nullable().optional(),
        page: z.object({
          size: z.enum(["a4", "letter", "legal", "a3"]),
          orientation: z.enum(["portrait", "landscape"]),
          margin: z.number(),
        }),
        header: BAND,
        footer: BAND,
        // Blocks carry cached rows, so this is the large half of the payload.
        blocks: z.array(z.record(z.string(), z.unknown())).max(MAX_BLOCKS),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; id: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const blocks = data.blocks as unknown as ReportBlock[];
    const invalid = validateReport({ name: data.name, page: data.page, blocks });
    if (invalid) return { ok: false, error: invalid };

    const patch = {
      user_id: userId,
      name: data.name,
      description: data.description ?? null,
      page: { ...data.page, margin: clampMargin(data.page.margin, 595) } as unknown as Json,
      header: data.header as unknown as Json,
      footer: data.footer as unknown as Json,
      blocks: blocks as unknown as Json,
      updated_at: new Date().toISOString(),
    };
    const q = data.id
      ? supabaseAdmin.from("bi_reports").update(patch).eq("id", data.id).eq("user_id", userId)
      : supabaseAdmin.from("bi_reports").insert(patch);
    const { data: row, error } = await q.select("id").maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: "Report not found" };
    return { ok: true, id: String(row.id) };
  });

export const biReportCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        name: z.string().trim().min(1).max(REPORT_NAME_MAX),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; id: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: row, error } = await supabaseAdmin
      .from("bi_reports")
      .insert({
        user_id: userId,
        name: data.name,
        page: DEFAULT_PAGE as unknown as Json,
        header: DEFAULT_HEADER as unknown as Json,
        // A page number by default: the first thing anybody misses on a
        // printed report is which page they are holding.
        footer: DEFAULT_FOOTER as unknown as Json,
        blocks: [] as unknown as Json,
      })
      .select("id")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Could not create the report" };
    return { ok: true, id: String(row.id) };
  });

export const biReportDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { error } = await supabaseAdmin
      .from("bi_reports")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
