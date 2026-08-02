// Salesforce connector (REST + SOQL).
//
// AUTH IS THE CLIENT CREDENTIALS FLOW, not the authorisation-code flow. The
// same reasoning as HubSpot: a redirect-based flow needs a public callback URL
// that a self-hosted deployment cannot be assumed to have. Client credentials
// is server-to-server by design, needs no browser round trip, and Salesforce
// has supported it for connected apps since Winter '23.
//
// The username-password flow would also avoid a redirect and is deliberately
// NOT used — Salesforce has been retiring it, and it requires storing a user's
// password plus a security token rather than an app credential that can be
// revoked on its own.

import { flattenRecord } from "./flatten";
import type { SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Pinned so a Salesforce release cannot reshape a dataset under a dashboard. */
const API_VERSION = "v61.0";

/** SOQL's own ceiling for one page; `nextRecordsUrl` carries the rest. */
const PAGE_SIZE = 2000;

type SalesforceCfg = Extract<SaasConfig, { provider: "salesforce" }>;

const STREAMS: Record<string, { label: string; object: string }> = {
  accounts: { label: "Accounts", object: "Account" },
  contacts: { label: "Contacts", object: "Contact" },
  leads: { label: "Leads", object: "Lead" },
  opportunities: { label: "Opportunities", object: "Opportunity" },
  cases: { label: "Cases", object: "Case" },
  campaigns: { label: "Campaigns", object: "Campaign" },
  users: { label: "Users", object: "User" },
};

/**
 * Normalise whatever was pasted into an instance origin.
 *
 * People paste the address bar, which includes a path and often the Lightning
 * host. Demanding the exact form produces a 404 that explains nothing.
 */
export function normaliseInstanceUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, "");
  if (!s)
    throw new Error("Salesforce: enter your instance URL, e.g. https://acme.my.salesforce.com");
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Salesforce: "${input}" is not a valid URL.`);
  }
  if (!/\.salesforce\.com$|\.force\.com$/i.test(url.hostname)) {
    throw new Error(
      `Salesforce: "${url.hostname}" is not a Salesforce domain. ` +
        "Use your My Domain address, e.g. acme.my.salesforce.com.",
    );
  }
  // Origin only — a path would be carried into every API call.
  return url.origin;
}

/**
 * Exchange the connected app's credentials for an access token.
 *
 * Salesforce returns its own `instance_url`, which can differ from the login
 * host (sandboxes and My Domain redirects). Using the RETURNED one rather than
 * the configured one is what makes those work.
 */
async function authenticate(cfg: SalesforceCfg): Promise<{ token: string; instance: string }> {
  const base = normaliseInstanceUrl(cfg.instance_url);
  const res = await connectorFetch(`${base}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    instance_url?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // Salesforce's own description is far more useful than the status; the
    // usual cause is the connected app having no "run as" user configured for
    // the client-credentials flow, which it names explicitly.
    throw new Error(
      `Salesforce auth: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`,
    );
  }
  return { token: body.access_token, instance: body.instance_url ?? base };
}

async function sfGet<T>(instance: string, token: string, path: string): Promise<T> {
  // `path` is either one we build or a nextRecordsUrl Salesforce handed back,
  // which is already absolute-from-root.
  const url = path.startsWith("http") ? path : `${instance}${path}`;
  const res = await connectorFetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Salesforce errors are an ARRAY of {message, errorCode}.
    try {
      const arr = JSON.parse(text) as { message?: string; errorCode?: string }[];
      const first = Array.isArray(arr) ? arr[0] : null;
      if (first?.message) throw new Error(`Salesforce: ${first.message}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Salesforce:")) throw e;
    }
    throw new Error(`Salesforce: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function listSalesforceStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  // Authenticating here means a bad connected app fails during setup rather
  // than at the first sync.
  await authenticate(cfg as SalesforceCfg);
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

type DescribeResult = {
  fields?: { name?: string; type?: string }[];
};

/**
 * Queryable field names for an object.
 *
 * `SELECT FIELDS(ALL)` exists but caps at 200 rows, which is useless for a
 * sync. So the object is described and the field list built explicitly —
 * which also lets the unqueryable types be excluded.
 */
async function queryableFields(instance: string, token: string, object: string): Promise<string[]> {
  const describe = await sfGet<DescribeResult>(
    instance,
    token,
    `/services/data/${API_VERSION}/sobjects/${object}/describe`,
  );
  const fields = (describe.fields ?? [])
    .filter((f) => {
      if (!f.name) return false;
      // COMPOUND AND BINARY FIELDS CANNOT APPEAR IN A SOQL SELECT. `address`
      // and `location` are aggregates of other fields that ARE queryable, and
      // `base64` is a document body. Including any of them makes the whole
      // query fail with MALFORMED_QUERY — one bad field breaks the object.
      return f.type !== "address" && f.type !== "location" && f.type !== "base64";
    })
    .map((f) => f.name!);
  if (fields.length === 0) throw new Error(`Salesforce: no queryable fields on ${object}`);
  return fields;
}

type QueryResult = {
  records?: Record<string, unknown>[];
  done?: boolean;
  nextRecordsUrl?: string;
};

export async function* fetchSalesforceRows(
  cfg: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Salesforce: unknown object "${streamId}"`);
  const { token, instance } = await authenticate(cfg as SalesforceCfg);

  const fields = await queryableFields(instance, token, stream.object);
  const soql = `SELECT ${fields.join(",")} FROM ${stream.object} LIMIT ${PAGE_SIZE}`;
  let path: string | undefined =
    `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;

  while (path) {
    const page: QueryResult = await sfGet<QueryResult>(instance, token, path);
    const records = page.records ?? [];
    if (records.length === 0) return;

    for (const r of records) {
      // Every record carries an `attributes` object holding its type and a
      // REST URL. It is metadata about the response, not data, and flattening
      // it adds two useless columns to every dataset.
      const { attributes: _drop, ...rest } = r as Record<string, unknown> & {
        attributes?: unknown;
      };
      void _drop;
      yield flattenRecord(rest);
    }

    // `done` is authoritative and nextRecordsUrl is absent once finished.
    path = page.done ? undefined : page.nextRecordsUrl;
  }
}
