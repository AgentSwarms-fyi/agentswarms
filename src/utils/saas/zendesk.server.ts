// Zendesk connector: tickets, users and organizations, as datasets.
//
// AUTH IS EMAIL + API TOKEN. Zendesk's OAuth needs a registered client and a
// public redirect; an API token (Admin Center → Apps and integrations → APIs)
// is created once and pasted. Zendesk's Basic scheme for tokens is the
// slightly odd `email/token:<token>` — the "/token" suffix is not a typo, and
// omitting it is the single most common reason a valid token returns 401.
//
// Cursor pagination throughout (`page[size]`, `meta.has_more`,
// `meta.after_cursor`). Offset pagination is capped at 10,000 records by
// Zendesk, which is exactly the size of support desk that needs this
// connector most.
import { flattenRecord } from "./flatten";
import type { SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Zendesk's maximum cursor page. */
const PAGE_SIZE = 100;

type ZendeskCfg = Extract<SaasConfig, { provider: "zendesk" }>;

const STREAMS: Record<string, { label: string; path: string; key: string }> = {
  tickets: { label: "Tickets", path: "/api/v2/tickets.json", key: "tickets" },
  users: { label: "Users", path: "/api/v2/users.json", key: "users" },
  organizations: {
    label: "Organizations",
    path: "/api/v2/organizations.json",
    key: "organizations",
  },
};

/** https://<subdomain>.zendesk.com, accepting a pasted full URL too. */
export function zendeskOrigin(subdomain: string): string {
  const s = subdomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.zendesk\.com.*$/i, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+$/i.test(s)) throw new Error(`Zendesk: "${subdomain}" is not a subdomain`);
  return `https://${s.toLowerCase()}.zendesk.com`;
}

/** The token form Zendesk expects: `email/token:<api token>`, base64. */
export function zendeskAuthHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString("base64")}`;
}

async function zendeskFetch<T>(cfg: ZendeskCfg, path: string, params: URLSearchParams): Promise<T> {
  const url = `${zendeskOrigin(cfg.subdomain)}${path}${params.toString() ? `?${params}` : ""}`;
  const res = await connectorFetch(
    url,
    {
      headers: {
        Authorization: zendeskAuthHeader(cfg.email, cfg.api_token),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    },
    { label: "Zendesk" },
  );
  if (res.status === 401) {
    throw new Error(
      "Zendesk: the email or API token was rejected (Admin Center → Apps and integrations → APIs).",
    );
  }
  if (res.status === 403) {
    throw new Error(
      "Zendesk: that account cannot read this resource — an agent role or higher is needed.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zendesk: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function listZendeskStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as ZendeskCfg;
  // Cheapest authenticated call, so a bad token fails during setup.
  await zendeskFetch(c, "/api/v2/users/me.json", new URLSearchParams());
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

type Page = {
  meta?: { has_more?: boolean; after_cursor?: string | null };
} & Record<string, unknown>;

export async function* fetchZendeskRows(
  cfg: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Zendesk: unknown stream "${streamId}"`);
  const c = cfg as ZendeskCfg;
  let cursor: string | null | undefined;
  for (;;) {
    const params = new URLSearchParams({ "page[size]": String(PAGE_SIZE) });
    if (cursor) params.set("page[after]", cursor);
    const page = await zendeskFetch<Page>(c, stream.path, params);
    const rows = (page[stream.key] as Record<string, unknown>[] | undefined) ?? [];
    if (rows.length === 0) return;
    for (const r of rows) yield flattenRecord(r);
    if (!page.meta?.has_more || !page.meta.after_cursor) return;
    cursor = page.meta.after_cursor;
  }
}
