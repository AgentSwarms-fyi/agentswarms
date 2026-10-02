// Airtable connector.
//
// Auth is a personal access token with `data.records:read` and
// `schema.bases:read` — the second is what lets the picker list bases and
// tables, and a token without it fails at setup rather than at sync.
//
// FULL REFRESH, and unlike the other connectors here that is not a gap waiting
// to be filled. Airtable exposes no universal "last modified" on a record: a
// base only has one if somebody added a Last Modified Time FIELD to that
// table, which most have not and which this cannot rely on. Guessing at a
// field with a likely name would follow the wrong column on some bases and
// silently miss edits, which is worse than re-reading. Airtable bases are
// small by design — the row ceiling is in the tens of thousands — so a full
// read is cheap, exactly as it is for a Google Sheets worksheet.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://api.airtable.com/v0";

/** Airtable's maximum page. */
const PAGE_SIZE = 100;

/** Tables offered as streams, across every base. */
const MAX_TABLES = 200;

type AirtableCfg = Extract<SaasConfig, { provider: "airtable" }>;

async function airtableFetch<T>(cfg: AirtableCfg, url: string): Promise<T> {
  const res = await connectorFetch(url, {
    headers: { Authorization: `Bearer ${cfg.access_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error("Airtable: that token was rejected. Check it has not been revoked.");
  }
  if (res.status === 403) {
    throw new Error(
      "Airtable: this token lacks a scope or a base. It needs data.records:read and " +
        "schema.bases:read, and each base must be added to the token's access list.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Airtable: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

/** `{baseId, tableId}` for a stream id, or null if it is not a table stream. */
export function tableOf(streamId: string): { baseId: string; tableId: string } | null {
  const m = /^records:(app[A-Za-z0-9]+):(tbl[A-Za-z0-9]+)$/.exec(streamId);
  return m ? { baseId: m[1], tableId: m[2] } : null;
}

export async function listAirtableStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as AirtableCfg;
  const streams: SaasStream[] = [];

  type BasesPage = { bases?: { id?: string; name?: string }[]; offset?: string };
  let baseOffset: string | undefined;
  const bases: { id: string; name: string }[] = [];
  do {
    const url = new URL(`${API}/meta/bases`);
    if (baseOffset) url.searchParams.set("offset", baseOffset);
    const page = await airtableFetch<BasesPage>(c, url.toString());
    for (const b of page.bases ?? []) {
      if (b.id) bases.push({ id: b.id, name: b.name ?? b.id });
    }
    baseOffset = page.offset;
  } while (baseOffset);

  if (bases.length === 0) {
    throw new Error(
      "Airtable: this token can see no bases. Add them to the token's access list at " +
        "airtable.com/create/tokens.",
    );
  }

  type TablesPage = { tables?: { id?: string; name?: string }[] };
  for (const base of bases) {
    const page = await airtableFetch<TablesPage>(c, `${API}/meta/bases/${base.id}/tables`);
    for (const t of page.tables ?? []) {
      if (!t.id) continue;
      streams.push({
        id: `records:${base.id}:${t.id}`,
        label: `${base.name} — ${t.name ?? t.id}`,
      });
      if (streams.length >= MAX_TABLES) return streams;
    }
  }
  return streams;
}

/**
 * Nothing to follow. See the note at the top of this file: Airtable has no
 * universal modified timestamp, and guessing at a field would miss edits
 * silently on the bases that name theirs differently.
 */
export function airtableIncremental(_streamId: string): IncrementalSpec | null {
  void _streamId;
  return null;
}

type RecordsPage = {
  records?: { id?: string; createdTime?: string; fields?: Record<string, unknown> }[];
  offset?: string;
};

export async function* fetchAirtableRows(
  cfg: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const target = tableOf(streamId);
  if (!target) throw new Error(`Airtable: unknown stream "${streamId}"`);
  const c = cfg as AirtableCfg;

  let offset: string | undefined;
  do {
    const url = new URL(`${API}/${target.baseId}/${target.tableId}`);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (offset) url.searchParams.set("offset", offset);
    const page = await airtableFetch<RecordsPage>(c, url.toString());
    const rows = page.records ?? [];
    if (rows.length === 0) return;
    for (const r of rows) {
      // The fields sit inside `fields` and the id beside them, so the two are
      // merged — otherwise every column would be prefixed `fields_`.
      //
      // An EMPTY Airtable cell is omitted from `fields` entirely rather than
      // sent as null, so a record's column set varies row to row. The shared
      // ingest path infers columns across the whole stream, which is what
      // makes that survivable.
      yield flattenRecord({
        id: r.id ?? null,
        created_time: r.createdTime ?? null,
        ...(r.fields ?? {}),
      });
    }
    // Airtable's own cursor; its absence is the end.
    offset = page.offset;
  } while (offset);
}
