// The engine behind "Any REST API" (R528): one connector that runs any spec
// checked by @/lib/connectorSpec, the way the built-in connectors run their
// own code. Same guarded fetch (proxy, retries, private addresses refused),
// same flattening, same datasets, schedules and incremental sync.
//
// The spec is checked again here, on every use, from the stored text: what
// the Connect form checked is not trusted. Every request stays on the spec's
// one host, including a "next page" the API names; the credential is placed
// only where `auth` says and never shown back, not even in a preview's URL.
import {
  authFor,
  checkConnectorSpec,
  firstPageUrl,
  needsCredential,
  nextPageUrl,
  recordsIn,
  specOrigin,
  DEFAULT_MAX_PAGES,
  type ConnectorSpec,
  type ConnectorStream,
} from "@/lib/connectorSpec";
import { connectorFetch } from "@/utils/http/connectorFetch.server";
import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";

type RestCfg = Extract<SaasConfig, { provider: "rest_api" }>;

/** The spec a connection holds, checked; an error naming every problem when it is not usable. */
export function specOf(cfg: SaasConfig): ConnectorSpec {
  const c = cfg as RestCfg;
  const checked = checkConnectorSpec(c.spec ?? "");
  if (!checked.ok) {
    throw new Error(`The connector has problems: ${checked.errors.slice(0, 6).join("; ")}`);
  }
  return checked.spec;
}

function streamOf(spec: ConnectorSpec, streamId: string): ConnectorStream {
  const s = spec.streams.find((x) => x.id === streamId);
  if (!s) throw new Error(`${spec.name}: there is no stream "${streamId}" in the connector`);
  return s;
}

/** One request, on the spec's host, with the credential where auth puts it. */
async function getPage(
  spec: ConnectorSpec,
  cfg: RestCfg,
  url: string,
): Promise<{ body: unknown; link: string | null }> {
  const origin = specOrigin(spec.base_url);
  const u = new URL(url);
  if (!origin || u.origin !== origin) {
    throw new Error(`${spec.name}: ${u.origin} is not the connector's host; nothing was sent.`);
  }
  const credential = (cfg.credential ?? "").trim();
  if (needsCredential(spec.auth) && !credential) {
    throw new Error(
      `${spec.name}: this API needs a key or token. Pick one in the credential field.`,
    );
  }
  // Optional auth with no credential: the request goes without it.
  const a = credential
    ? authFor(spec.auth, credential, (cfg.username ?? "").trim())
    : { headers: {}, params: {} as Record<string, string>, basic: undefined };
  for (const [k, v] of Object.entries(a.params)) u.searchParams.set(k, v);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(spec.headers ?? {}),
    ...a.headers,
  };
  if (a.basic) {
    headers.Authorization = `Basic ${Buffer.from(`${a.basic[0]}:${a.basic[1]}`).toString("base64")}`;
  }
  const res = await connectorFetch(u.toString(), {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error(
      `${spec.name}: the API refused the credential (401). Check the key and where auth sends it.`,
    );
  }
  if (res.status === 403) {
    throw new Error(`${spec.name}: the credential cannot read ${u.pathname} (403).`);
  }
  if (res.status === 404) {
    throw new Error(
      `${spec.name}: ${u.pathname} was not found (404). Check base_url and the stream's path.`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${spec.name}: HTTP ${res.status}${text ? ` — ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
    );
  }
  const text = await res.text();
  try {
    return { body: JSON.parse(text) as unknown, link: res.headers.get("link") };
  } catch {
    throw new Error(`${spec.name}: ${u.pathname} did not answer with JSON.`);
  }
}

/**
 * Pages of one stream, as records. Stops at the end the pagination names, at
 * a page asked for twice (an API that keeps handing back the same cursor), or
 * at max_pages, and says which.
 */
async function* pages(
  spec: ConnectorSpec,
  cfg: RestCfg,
  stream: ConnectorStream,
  since: string | undefined,
  maxPages: number,
): AsyncGenerator<Record<string, unknown>[]> {
  const origin = specOrigin(spec.base_url)!;
  let url: string | null = firstPageUrl(spec, stream, since);
  const asked = new Set<string>();
  for (let n = 0; url; n++) {
    if (n >= maxPages) {
      throw new Error(
        `${spec.name}: ${stream.id} has more than ${maxPages} pages, which is as far as one sync reads. ` +
          (stream.incremental
            ? "Sync more often so each run reads less."
            : "Raise max_pages, or follow it incrementally."),
      );
    }
    if (asked.has(url)) {
      throw new Error(
        `${spec.name}: the API returned the same next page twice; the sync stopped there.`,
      );
    }
    asked.add(url);
    const { body, link } = await getPage(spec, cfg, url);
    const found = recordsIn(body, stream.records);
    if (!found.ok) throw new Error(`${spec.name}: ${stream.id}: ${found.error}`);
    yield found.records;
    const next = nextPageUrl(stream, origin, { url, body, link, count: found.records.length });
    if ("error" in next) throw new Error(`${spec.name}: ${next.error}`);
    url = "url" in next ? next.url : null;
  }
}

/** The streams the connector names, after one real request proves it answers. */
export async function listRestStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const spec = specOf(cfg);
  const first = spec.streams[0];
  for await (const _page of pages(spec, cfg as RestCfg, first, undefined, 1)) break;
  return spec.streams.map((s) => ({ id: s.id, label: s.label }));
}

export async function* fetchRestRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const spec = specOf(cfg);
  const stream = streamOf(spec, streamId);
  const max = spec.max_pages ?? DEFAULT_MAX_PAGES;
  for await (const page of pages(spec, cfg as RestCfg, stream, since, max)) {
    for (const r of page) yield flattenRecord(r);
  }
}

/** How a stream follows changes, from its own declaration; null when it is re-read. */
export function restIncremental(streamId: string, cfg?: SaasConfig): IncrementalSpec | null {
  if (!cfg) return null;
  let spec: ConnectorSpec;
  try {
    spec = specOf(cfg);
  } catch {
    return null;
  }
  const inc = spec.streams.find((s) => s.id === streamId)?.incremental;
  if (!inc) return null;
  return {
    cursorField: inc.cursor_field,
    primaryKey: inc.primary_key,
    compare: inc.format === "unix" ? "number" : "iso",
  };
}

/** The address a stream starts from, as a person may see it: no credential in it. */
export function shownUrl(cfg: SaasConfig, streamId: string): string {
  const spec = specOf(cfg);
  const u = new URL(firstPageUrl(spec, streamOf(spec, streamId)));
  return u.toString();
}
