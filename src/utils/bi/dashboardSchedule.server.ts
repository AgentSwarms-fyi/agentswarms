// A dashboard run for a schedule (R510): the dashboard sent as a PDF.
//
// The same contract as a report's run (reportSchedule.server runReport), so a
// schedule, Send now, Send to me and Preview PDF treat the two alike. The
// widgets run through the scheduled refresh's own runner, as the dashboard's
// OWNER and at the schedule's parameter values, on copies: nothing is written
// back, because a copy run for one schedule's values is not the snapshot every
// viewer sees.
import { PDFDocument } from "pdf-lib";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildDashboardPdfBytes } from "@/lib/biDashboardPdf";
import { parseLayout, parsePages, parseWidgets, type BiWidget } from "@/lib/biDashboards";
import { withTokensFilled } from "@/lib/biInteract";
import { parseParams } from "@/lib/biParams";
import { resolveReportImages } from "@/lib/biReportImages";
import {
  isValidTimeZone,
  pagesToSend,
  runClock,
  scheduledValues,
  valuesSummary,
} from "@/lib/biReportSchedule";
import type { ReportBlock } from "@/lib/biReports";
import { fetchPicture, type ReportRun } from "@/utils/bi/reportSchedule.server";

export async function runDashboard(opts: {
  userId: string;
  dashboardId: string;
  stored: Record<string, string>;
  timezone: string;
  /** Page ids to send; empty = every page. */
  pageIds: string[];
  now?: Date;
}): Promise<ReportRun> {
  const now = opts.now ?? new Date();
  const { data: row, error } = await supabaseAdmin
    .from("bi_dashboards")
    .select("id, user_id, name, widgets, layout, pages, filters")
    .eq("id", opts.dashboardId)
    .eq("user_id", opts.userId)
    .maybeSingle();
  if (error) throw new Error(`The dashboard could not be read: ${error.message}`);
  if (!row) throw new Error("The dashboard no longer exists.");

  const top = parseWidgets(row.widgets);
  const all = parsePages(row.pages, top, parseLayout(row.layout, top));
  const { pages: chosen, note } = pagesToSend(all, opts.pageIds);
  const params = parseParams(row.filters);
  const tz = isValidTimeZone(opts.timezone) ? opts.timezone : "UTC";
  const { values, fellBack } = scheduledValues(params, opts.stored, now, tz);

  // Copies: the runner fills rows in place.
  const copies = chosen.map((p) => ({
    name: p.name,
    layout: p.layout,
    widgets: p.widgets.map((w) => ({ ...w })),
  }));
  const widgets = copies.flatMap((p) => p.widgets);
  const failed = new Map<string, string>();
  const { runDashboardWidgets } = await import("@/utils/bi/refresh.server");
  const failures = await runDashboardWidgets({
    userId: opts.userId,
    widgets: widgets as never,
    filters: row.filters,
    values,
    incremental: false,
    onFailure: (w, message) => {
      if (w.id) failed.set(w.id, message.slice(0, 200));
    },
  });

  const queried = widgets.filter(
    (w) => w.kind === "chart" && (w.sql || w.source?.kind === "semantic"),
  );
  const withRows = queried.filter((w) => (w.rows ?? []).length > 0);

  // {{param}} in titles and text, at the values this copy ran with.
  const state = { params, values, selected: null };
  const printed = copies.map((p) => ({ ...p, widgets: withTokensFilled(p.widgets, state) }));

  const pictures = widgets
    .filter((w): w is BiWidget & { image: { src: string } } => w.kind === "image" && !!w.image?.src)
    .map((w) => ({ id: w.id, kind: "image", src: w.image.src }) as unknown as ReportBlock);
  const images = await resolveReportImages(pictures, (url) => fetchPicture(String(url)));

  const { renderVisualMarkup } = await import("@/utils/bi/reportCharts.server");
  const bytes = await buildDashboardPdfBytes({
    name: row.name,
    pages: printed,
    clock: runClock(now, tz),
    renderVisual: (w) => (size) => renderVisualMarkup(w.chart!, w.rows ?? [], size, w.columns),
    images,
    failures: failed,
    valuesLine: params.length ? valuesSummary(params, values) : undefined,
  });
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  return {
    bytes,
    pages,
    reportName: row.name,
    params,
    values,
    fellBack,
    failures,
    empty: queried.length > 0 && withRows.length === 0,
    queried: queried.length,
    notes: note ? [note] : [],
  };
}
