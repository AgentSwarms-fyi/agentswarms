// ServiceNow connector (Table API).
//
// Auth is basic — a username and password for an integration user. ServiceNow
// also offers OAuth, and deliberately not used here for the reason every other
// connector pastes a credential: an OAuth redirect needs a public callback URL
// that a self-hosted deployment behind a firewall may not have.
//
// The datasets contain exactly what that user can read. ServiceNow enforces
// ACLs on the Table API, so pointing this at a read-only integration user with
// a narrow role is both possible and the right thing to do.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** ServiceNow's practical ceiling for one Table API page. */
const PAGE_SIZE = 1000;

type ServiceNowCfg = Extract<SaasConfig, { provider: "servicenow" }>;

/**
 * The tables offered.
 *
 * Every one is a standard table present on any instance, so the list can be
 * static — asking the instance which tables exist would return thousands,
 * most of them internal plumbing nobody wants as a dataset.
 */
const STREAMS: Record<string, { label: string; table: string }> = {
  incident: { label: "Incidents", table: "incident" },
  change_request: { label: "Change requests", table: "change_request" },
  problem: { label: "Problems", table: "problem" },
  sc_request: { label: "Service catalog requests", table: "sc_request" },
  sc_req_item: { label: "Requested items", table: "sc_req_item" },
  task: { label: "Tasks", table: "task" },
  sys_user: { label: "Users", table: "sys_user" },
  cmdb_ci: { label: "Configuration items", table: "cmdb_ci" },
};

/** https://<instance>.service-now.com, accepting a pasted full URL too. */
export function serviceNowOrigin(instance: string): string {
  const s = instance
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.service-now\.com$/i, "");
  if (!s)
    throw new Error("ServiceNow: enter your instance name, e.g. acme or acme.service-now.com");
  return `https://${s}.service-now.com`;
}

type TableResult = { result?: Record<string, unknown>[]; error?: { message?: string } };

async function snowFetch(
  cfg: ServiceNowCfg,
  table: string,
  params: URLSearchParams,
): Promise<TableResult> {
  const url = `${serviceNowOrigin(cfg.instance)}/api/now/table/${table}?${params}`;
  // Basic auth is what an integration user has; the header is built here
  // rather than stored so the stored credential stays the raw pair.
  const basic = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  const res = await connectorFetch(url, {
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 401) {
    throw new Error("ServiceNow: those credentials were rejected. Check the user and password.");
  }
  if (res.status === 403) {
    throw new Error(
      "ServiceNow: that user cannot read this table. Grant the integration user a role " +
        "with read access to it (snc_read_only is often enough).",
    );
  }
  const body = (await res.json().catch(() => ({}))) as TableResult;
  if (!res.ok) {
    throw new Error(`ServiceNow: ${body.error?.message ?? `HTTP ${res.status}`}`);
  }
  return body;
}

export async function listServiceNowStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  // One cheap call so bad credentials fail during setup rather than at the
  // first sync. `sysparm_limit=1` on a table every instance has.
  await snowFetch(
    cfg as ServiceNowCfg,
    "incident",
    new URLSearchParams({ sysparm_limit: "1", sysparm_fields: "sys_id" }),
  );
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

/**
 * Every ServiceNow table carries `sys_updated_on`, so every stream follows.
 *
 * `sys_id` is the key: it is a GUID that survives renames and re-parenting,
 * whereas `number` (INC0012345) is display text that an admin can reformat.
 */
export function serviceNowIncremental(streamId: string): IncrementalSpec | null {
  if (!STREAMS[streamId]) return null;
  return { cursorField: "sys_updated_on", primaryKey: "sys_id", compare: "iso" };
}

/**
 * ServiceNow's own datetime format: "YYYY-MM-DD HH:MM:SS", always UTC on the
 * raw value.
 *
 * The stored cursor is whatever came back in `sys_updated_on`, which is that
 * format rather than ISO-8601 — so it is parsed leniently on the way in and
 * re-emitted in ServiceNow's shape on the way out.
 */
function snowStamp(since: string): string | null {
  // Accept both the raw ServiceNow form and an ISO string, because a cursor
  // written by an older build could be either.
  const iso = since.includes("T") ? since : `${since.replace(" ", "T")}Z`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

export async function* fetchServiceNowRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`ServiceNow: unknown table "${streamId}"`);
  const c = cfg as ServiceNowCfg;

  // ORDERBY makes the offset paging below safe: without it ServiceNow does not
  // promise a stable order, and an offset into an unordered set can repeat or
  // skip rows as records change during the sync.
  //
  // `>=` for the same reason every connector here uses a closed interval: the
  // record on the boundary comes back and is folded away by its sys_id, where
  // `>` would drop everything sharing the last second seen.
  const stamp = since ? snowStamp(since) : null;
  const query = stamp ? `sys_updated_on>=${stamp}^ORDERBYsys_updated_on` : "ORDERBYsys_updated_on";

  let offset = 0;
  for (;;) {
    const page = await snowFetch(
      c,
      stream.table,
      new URLSearchParams({
        sysparm_query: query,
        sysparm_limit: String(PAGE_SIZE),
        sysparm_offset: String(offset),
        // RAW values, not display values. `sysparm_display_value=true` renders
        // dates in the instance's own format and timezone, which would make
        // the cursor unparseable and shift the window by the instance's
        // offset. Reference fields arrive as {link, value} and are flattened.
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      }),
    );
    const rows = page.result ?? [];
    if (rows.length === 0) return;
    for (const r of rows) yield flattenRecord(r);
    // A short page is the end. ServiceNow has no "has_more" flag, so this is
    // the only signal available.
    if (rows.length < PAGE_SIZE) return;
    offset += rows.length;
  }
}
