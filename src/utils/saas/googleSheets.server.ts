// Google Sheets connector.
//
// Auth is a SERVICE ACCOUNT rather than OAuth, deliberately. A self-hosted
// deployment cannot complete an OAuth consent flow without the operator
// registering their own Google app, whereas a service-account key is a file
// they paste once. The trade is that the sheet must be shared with the key's
// client_email, which is one step and a clear 403 when it is missed.
//
// The scope is spreadsheets.READONLY. Nothing here ever writes to a user's
// sheet, and asking for write access we do not use would be the kind of thing
// a security review rightly stops.

import { GOOGLE_SCOPES, googleAccessToken } from "@/utils/google/serviceAccount.server";
import type { SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Cells requested per page. Sheets caps a response by size, not row count. */
const PAGE_ROWS = 5000;

/**
 * Accept either a bare spreadsheet id or the URL from the browser bar.
 *
 * Users copy the URL — expecting the id means the first attempt fails with a
 * 404 that says nothing about why.
 */
export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // A bare id: Google's are long and use this alphabet. Rejecting anything
  // else here turns a paste mistake into a clear message rather than a 404.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  throw new Error(
    "That does not look like a Google Sheets id or URL. Paste the sheet's address from your browser.",
  );
}

async function sheetsFetch<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await connectorFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403) {
      throw new Error(
        "Google Sheets: access denied. Share the sheet with the service account's " +
          "client_email (Share → paste the address → Viewer).",
      );
    }
    if (res.status === 404) {
      throw new Error("Google Sheets: no spreadsheet with that id, or it is not shared.");
    }
    throw new Error(`Google Sheets: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** This connector's slice of the config union, narrowed once at the top. */
type SheetsCfg = Extract<SaasConfig, { provider: "google_sheets" }>;

function token(cfg: SheetsCfg): Promise<string> {
  return googleAccessToken(cfg.service_account_json, {
    scope: GOOGLE_SCOPES.sheetsReadonly,
    label: "Google Sheets",
  });
}

type SheetMeta = {
  sheets?: {
    properties?: {
      title?: string;
      sheetId?: number;
      gridProperties?: { rowCount?: number; columnCount?: number };
    };
  }[];
};

/** Each worksheet (tab) is a stream, and becomes its own dataset. */
export async function listSheetStreams(config: SaasConfig): Promise<SaasStream[]> {
  const cfg = config as SheetsCfg;
  const id = extractSpreadsheetId(cfg.spreadsheet_id);
  const meta = await sheetsFetch<SheetMeta>(await token(cfg), id, {
    // Only the tab list — asking for cell data here would download the whole
    // spreadsheet just to render a picker.
    fields: "sheets.properties(title,sheetId,gridProperties(rowCount))",
  });
  const streams = (meta.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is NonNullable<typeof p> => !!p?.title)
    .map((p) => ({
      id: p.title!,
      label: p.title!,
      // gridProperties counts ALLOCATED rows, not filled ones, and is usually
      // 1000 for an almost-empty sheet. Reported as the hint it is.
      rowCountHint: p.gridProperties?.rowCount,
    }));
  if (streams.length === 0) throw new Error("Google Sheets: this spreadsheet has no worksheets.");
  return streams;
}

/** A1 range for one page of a named worksheet, quoted for titles with spaces. */
function pageRange(title: string, startRow: number, rows: number): string {
  // A single quote inside a sheet title is escaped by doubling it in A1
  // notation. Without this, a tab called "Q3 'final'" produces a 400.
  const quoted = `'${title.replace(/'/g, "''")}'`;
  return `${quoted}!${startRow}:${startRow + rows - 1}`;
}

/**
 * Turn the header row plus a data row into an object.
 *
 * Sheets omits trailing empty cells entirely, so a row's array is often
 * SHORTER than the header. Indexing the header (not the row) is what keeps
 * every row the same shape — the alternative silently drops the last columns
 * from any row whose tail is blank.
 */
function toRow(header: string[], cells: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  header.forEach((name, i) => {
    out[name] = cells[i] ?? "";
  });
  return out;
}

/**
 * Make the header usable as column names.
 *
 * Blank and duplicate headers are both normal in real spreadsheets, and both
 * would otherwise collapse columns into one another as the object is built.
 */
export function normaliseHeader(raw: unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((cell, i) => {
    let name = String(cell ?? "").trim();
    if (!name) name = `column_${i + 1}`;
    const prior = seen.get(name);
    if (prior === undefined) {
      seen.set(name, 1);
      return name;
    }
    seen.set(name, prior + 1);
    return `${name}_${prior + 1}`;
  });
}

type ValuesResponse = { values?: unknown[][] };

/**
 * Yield every row of one worksheet, a page at a time.
 *
 * Paged by A1 row range rather than by a page token: the Sheets values API has
 * no cursor, so the range IS the cursor. A page that comes back shorter than
 * requested is the end of the data.
 */
export async function* fetchSheetRows(
  config: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const cfg = config as SheetsCfg;
  const id = extractSpreadsheetId(cfg.spreadsheet_id);
  const accessToken = await token(cfg);

  const first = await sheetsFetch<ValuesResponse>(
    accessToken,
    `${id}/values/${encodeURIComponent(pageRange(streamId, 1, PAGE_ROWS))}`,
    // UNFORMATTED_VALUE returns 1234.5 rather than "$1,234.50", so type
    // inference sees a number. FORMATTED would make every currency column text.
    { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" },
  );
  const rows = first.values ?? [];
  if (rows.length === 0) return;

  const header = normaliseHeader(rows[0]);
  for (const cells of rows.slice(1)) yield toRow(header, cells);

  // The first page held the header, so subsequent pages start one row later
  // than a naive multiple would suggest.
  let nextStart = 1 + PAGE_ROWS;
  let lastLength = rows.length;
  while (lastLength >= PAGE_ROWS) {
    const page = await sheetsFetch<ValuesResponse>(
      accessToken,
      `${id}/values/${encodeURIComponent(pageRange(streamId, nextStart, PAGE_ROWS))}`,
      { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" },
    );
    const pageRows = page.values ?? [];
    for (const cells of pageRows) yield toRow(header, cells);
    lastLength = pageRows.length;
    nextStart += PAGE_ROWS;
  }
}
