// Notion connector (databases → datasets).
//
// Auth is an internal integration token. The integration must be SHARED with
// each database from Notion's own UI — a token alone sees nothing, which is
// the single most common setup mistake and the reason an empty stream list
// says so rather than reporting "no databases".
//
// One dataset per database, the way Jira gives one per project.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://api.notion.com/v1";

/**
 * Pinned. Notion requires this header and versions its response shapes by it,
 * so leaving it to Notion's default would let a synced dataset change columns
 * underneath a dashboard.
 */
const NOTION_VERSION = "2022-06-28";

const PAGE_SIZE = 100;

/** Databases offered as streams. More than this and the picker is a wall. */
const MAX_DATABASES = 200;

type NotionCfg = Extract<SaasConfig, { provider: "notion" }>;

async function notionFetch<T>(cfg: NotionCfg, path: string, body?: unknown): Promise<T> {
  const res = await connectorFetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${cfg.access_token}`,
      "Notion-Version": NOTION_VERSION,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error("Notion: that token was rejected. Use an internal integration secret.");
  }
  if (res.status === 404) {
    throw new Error(
      "Notion: that database is not shared with this integration. Open it in Notion, " +
        "then ••• → Connections → add the integration.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Notion: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

/** The plain text of a Notion rich-text or title array. */
function plain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((v) => (v as { plain_text?: string })?.plain_text ?? "")
    .join("")
    .trim();
}

/**
 * One Notion property, reduced to something a column can hold.
 *
 * Notion wraps every value in its type — a date is
 * `{type:"date",date:{start,end}}`, a person is an array of user objects. Left
 * alone, flattening produces columns like `properties_Owner_people_0_id` and a
 * dataset nobody can query. Each common type is unwrapped to the value a
 * person would expect to see, and anything unrecognised is kept as-is rather
 * than dropped, so a new Notion type degrades to raw JSON instead of silence.
 */
export function notionPropertyValue(prop: unknown): unknown {
  const p = prop as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  switch (p.type) {
    case "title":
      return plain(p.title);
    case "rich_text":
      return plain(p.rich_text);
    case "number":
      return p.number ?? null;
    case "checkbox":
      return Boolean(p.checkbox);
    case "url":
    case "email":
    case "phone_number":
      return p[p.type as string] ?? null;
    case "select":
      return (p.select as { name?: string } | null)?.name ?? null;
    case "status":
      return (p.status as { name?: string } | null)?.name ?? null;
    case "multi_select":
      return ((p.multi_select as { name?: string }[] | null) ?? []).map((s) => s.name).join(", ");
    case "date": {
      const d = p.date as { start?: string; end?: string } | null;
      // The end is kept when there is one: a range collapsed to its start is a
      // silently wrong answer to "how long did this take".
      return d?.end ? `${d.start} → ${d.end}` : (d?.start ?? null);
    }
    case "people":
      return ((p.people as { name?: string }[] | null) ?? []).map((u) => u.name).join(", ");
    case "relation":
      return ((p.relation as { id?: string }[] | null) ?? []).map((r) => r.id).join(", ");
    case "files":
      return ((p.files as { name?: string }[] | null) ?? []).map((f) => f.name).join(", ");
    case "formula": {
      const f = p.formula as Record<string, unknown> | null;
      return f ? (f[(f.type as string) ?? ""] ?? null) : null;
    }
    case "rollup": {
      const r = p.rollup as Record<string, unknown> | null;
      return r ? (r[(r.type as string) ?? ""] ?? null) : null;
    }
    case "created_time":
    case "last_edited_time":
      return p[p.type as string] ?? null;
    case "unique_id": {
      const u = p.unique_id as { prefix?: string; number?: number } | null;
      return u ? `${u.prefix ? `${u.prefix}-` : ""}${u.number}` : null;
    }
    default:
      return p[(p.type as string) ?? ""] ?? null;
  }
}

/** `<database id>` for a stream id, or null if it is not a database stream. */
export function databaseOf(streamId: string): string | null {
  const m = /^database:([0-9a-fA-F-]+)$/.exec(streamId);
  return m ? m[1] : null;
}

type SearchPage = {
  results?: { id?: string; title?: unknown; object?: string }[];
  next_cursor?: string | null;
  has_more?: boolean;
};

export async function listNotionStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as NotionCfg;
  const streams: SaasStream[] = [];
  let cursor: string | undefined;
  do {
    const page = await notionFetch<SearchPage>(c, "/search", {
      filter: { value: "database", property: "object" },
      page_size: PAGE_SIZE,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const d of page.results ?? []) {
      if (!d.id) continue;
      streams.push({ id: `database:${d.id}`, label: plain(d.title) || d.id });
      if (streams.length >= MAX_DATABASES) return streams;
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);

  if (streams.length === 0) {
    // Notion returns an empty list rather than an error for an integration
    // nobody has shared anything with, so the likely cause is named here.
    throw new Error(
      "Notion: this integration can see no databases. Open each database in Notion and " +
        "add the integration under ••• → Connections.",
    );
  }
  return streams;
}

/** Every page carries `last_edited_time`, so every database follows. */
export function notionIncremental(streamId: string): IncrementalSpec | null {
  return databaseOf(streamId)
    ? { cursorField: "last_edited_time", primaryKey: "id", compare: "iso" }
    : null;
}

type QueryPage = {
  results?: {
    id?: string;
    created_time?: string;
    last_edited_time?: string;
    url?: string;
    archived?: boolean;
    properties?: Record<string, unknown>;
  }[];
  next_cursor?: string | null;
  has_more?: boolean;
};

export async function* fetchNotionRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const database = databaseOf(streamId);
  if (!database) throw new Error(`Notion: unknown stream "${streamId}"`);
  const c = cfg as NotionCfg;

  const at = since ? new Date(since) : null;
  let cursor: string | undefined;
  do {
    const page = await notionFetch<QueryPage>(c, `/databases/${database}/query`, {
      page_size: PAGE_SIZE,
      // Ascending, so a run that dies halfway has still moved the mark past
      // everything it committed.
      sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
      ...(at && !Number.isNaN(at.getTime())
        ? {
            // `on_or_after`, so the page on the boundary returns and is folded
            // away by its id rather than dropped.
            filter: {
              timestamp: "last_edited_time",
              last_edited_time: { on_or_after: at.toISOString() },
            },
          }
        : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const rows = page.results ?? [];
    if (rows.length === 0) return;
    for (const r of rows) {
      const props: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(r.properties ?? {})) {
        props[name] = notionPropertyValue(value);
      }
      yield flattenRecord({
        id: r.id ?? null,
        created_time: r.created_time ?? null,
        last_edited_time: r.last_edited_time ?? null,
        url: r.url ?? null,
        archived: Boolean(r.archived),
        ...props,
      });
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
}
