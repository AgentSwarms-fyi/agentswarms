// Google Analytics 4 connector (Data API v1beta).
//
// THE ODD ONE OUT, and worth reading before the code. Every other connector
// here syncs RECORDS: a charge, an issue, a contact, each with an id and a
// modified time. GA4 has no records to fetch. Its Data API answers a question
// — these dimensions, these metrics, over this date range — and returns
// aggregated rows that exist only because you asked for them.
//
// That changes three things:
//
//   1. A "stream" is a REPORT DEFINITION, not an object type. `sessions by
//      channel by day` is a stream; there is no table of sessions to page
//      through.
//   2. The cursor is a DATE, and the unit of progress is a day.
//   3. There is no natural primary key, so one is composed from the date and
//      the dimension values. Without it a merge could not tell yesterday's
//      "organic search" row from today's.
//
// Auth is a service account, like Google Sheets — and the account's email must
// be added to the GA4 property as a Viewer, which is the step people miss.

import { GOOGLE_SCOPES, googleAccessToken } from "@/utils/google/serviceAccount.server";
import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://analyticsdata.googleapis.com/v1beta";

/** The Data API's ceiling for one response. */
const PAGE_SIZE = 100_000;

/**
 * How many days before the stored mark to re-read on every incremental run.
 *
 * GA4 RESTATES recent days. A day's numbers are not final when the day ends:
 * late hits, session stitching and modelled conversions keep arriving for
 * hours or days afterwards. A connector that followed the cursor naively would
 * write the first, incomplete figure for each day and never look at it again —
 * so a dashboard would show yesterday's traffic permanently understated, with
 * nothing to indicate it.
 *
 * Re-reading a fortnight costs one request per stream and the merge replaces
 * those days by key. Google's own guidance is that data is stable within about
 * 48 hours; fourteen days is generous on purpose, because the failure it
 * prevents is invisible and the cost of preventing it is a rounding error.
 */
const RESTATEMENT_DAYS = 14;

/** How far back a FIRST sync reaches. */
const INITIAL_DAYS = 365;

type Ga4Cfg = Extract<SaasConfig, { provider: "ga4" }>;

/**
 * The reports offered.
 *
 * A fixed list rather than a report builder, because the point of this
 * connector is to land GA4 numbers somewhere they can be joined to everything
 * else — not to reimplement GA4's exploration UI. Every report includes `date`
 * so it can be followed and so it can be joined on a calendar.
 */
const STREAMS: Record<string, { label: string; dimensions: string[]; metrics: string[] }> = {
  traffic_by_channel: {
    label: "Traffic by channel, daily",
    dimensions: ["date", "sessionDefaultChannelGroup"],
    metrics: ["sessions", "totalUsers", "newUsers", "engagedSessions", "bounceRate"],
  },
  traffic_by_source: {
    label: "Traffic by source and medium, daily",
    dimensions: ["date", "sessionSource", "sessionMedium"],
    metrics: ["sessions", "totalUsers", "engagedSessions"],
  },
  pages: {
    label: "Pages, daily",
    dimensions: ["date", "pagePath"],
    metrics: ["screenPageViews", "totalUsers", "userEngagementDuration"],
  },
  events: {
    label: "Events, daily",
    dimensions: ["date", "eventName"],
    metrics: ["eventCount", "totalUsers"],
  },
  countries: {
    label: "Countries, daily",
    dimensions: ["date", "country"],
    metrics: ["sessions", "totalUsers"],
  },
  devices: {
    label: "Devices, daily",
    dimensions: ["date", "deviceCategory"],
    metrics: ["sessions", "totalUsers", "screenPageViews"],
  },
  conversions: {
    label: "Key events, daily",
    dimensions: ["date", "eventName"],
    metrics: ["keyEvents", "totalRevenue"],
  },
};

/** The property id, from a bare number or a pasted `properties/123` string. */
export function propertyId(input: string): string {
  const s = input.trim().replace(/^properties\//i, "");
  if (!/^\d+$/.test(s)) {
    throw new Error(
      "GA4: the property id is the number in Admin → Property settings, e.g. 123456789 — " +
        "not the measurement id (G-…) or the stream id.",
    );
  }
  return s;
}

/** `YYYY-MM-DD` in UTC, which is what the Data API's date range expects. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** GA4 answers with `YYYYMMDD`; a dataset wants a date anyone can compare. */
export function dashDate(compact: unknown): string | null {
  const s = String(compact ?? "");
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

type ReportReply = {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: { name?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
  error?: { message?: string; status?: string };
};

async function runReport(cfg: Ga4Cfg, body: Record<string, unknown>): Promise<ReportReply> {
  const token = await googleAccessToken(cfg.service_account_json, {
    scope: GOOGLE_SCOPES.analyticsReadonly,
    label: "GA4",
  });
  const res = await connectorFetch(`${API}/properties/${propertyId(cfg.property_id)}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const reply = (await res.json().catch(() => ({}))) as ReportReply;
  if (res.status === 403) {
    throw new Error(
      "GA4: the service account cannot read that property. Add its client_email as a " +
        "Viewer under Admin → Property access management.",
    );
  }
  if (!res.ok) {
    throw new Error(`GA4: ${reply.error?.message ?? `HTTP ${res.status}`}`);
  }
  return reply;
}

export async function listGa4Streams(cfg: SaasConfig): Promise<SaasStream[]> {
  // One cheap report so a bad key or a missing property grant fails during
  // setup rather than at the first sync. Yesterday only, one metric.
  const yesterday = isoDay(new Date(Date.now() - 86_400_000));
  await runReport(cfg as Ga4Cfg, {
    dateRanges: [{ startDate: yesterday, endDate: yesterday }],
    metrics: [{ name: "sessions" }],
    limit: 1,
  });
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

/**
 * Every report is followed on its `date` column, keyed by the synthetic
 * `row_key` composed below.
 *
 * The key is what makes re-reading restated days safe: the same day and the
 * same dimension values produce the same key, so the merge REPLACES the old
 * figure instead of adding a second row for it.
 */
export function ga4Incremental(streamId: string): IncrementalSpec | null {
  if (!STREAMS[streamId]) return null;
  return { cursorField: "date", primaryKey: "row_key", compare: "iso" };
}

export async function* fetchGa4Rows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`GA4: unknown report "${streamId}"`);
  const c = cfg as Ga4Cfg;

  const at = since ? new Date(since) : null;
  const from =
    at && !Number.isNaN(at.getTime())
      ? // Back up past the restatement window, not to the mark itself.
        new Date(at.getTime() - RESTATEMENT_DAYS * 86_400_000)
      : new Date(Date.now() - INITIAL_DAYS * 86_400_000);
  // `today` rather than yesterday: a partial day is still worth having, and
  // the restatement window means it is re-read until it settles.
  const to = new Date();

  let offset = 0;
  for (;;) {
    const reply = await runReport(c, {
      dateRanges: [{ startDate: isoDay(from), endDate: isoDay(to) }],
      dimensions: stream.dimensions.map((name) => ({ name })),
      metrics: stream.metrics.map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: PAGE_SIZE,
      offset,
    });
    const rows = reply.rows ?? [];
    if (rows.length === 0) return;

    const dims = (reply.dimensionHeaders ?? []).map((h) => h.name ?? "");
    const mets = (reply.metricHeaders ?? []).map((h) => h.name ?? "");
    for (const r of rows) {
      const out: Record<string, unknown> = {};
      const dimValues: string[] = [];
      dims.forEach((name, i) => {
        const raw = r.dimensionValues?.[i]?.value ?? null;
        dimValues.push(String(raw ?? ""));
        out[name] = name === "date" ? (dashDate(raw) ?? raw) : raw;
      });
      mets.forEach((name, i) => {
        const raw = r.metricValues?.[i]?.value;
        // Metrics arrive as STRINGS, every one of them. Left alone the dataset
        // types them as text and a dashboard cannot sum a column of sessions.
        const n = raw === undefined || raw === "" ? null : Number(raw);
        out[name] = n !== null && Number.isFinite(n) ? n : (raw ?? null);
      });
      // The synthetic key: the whole dimension tuple, which is exactly what
      // makes a row unique in an aggregate.
      out.row_key = dimValues.join("␟");
      // `date` is renamed on the way out only if GA4 did not include it; every
      // report here does, so the cursor always has something to read.
      yield flattenRecord(out);
    }

    offset += rows.length;
    if (typeof reply.rowCount === "number" && offset >= reply.rowCount) return;
    if (rows.length < PAGE_SIZE) return;
  }
}
