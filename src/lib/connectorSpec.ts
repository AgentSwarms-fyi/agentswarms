// A connector described as data (R528).
//
// Every app source so far was a hand-written module, and every one is the same
// five decisions: where the API lives, how it authenticates, which lists it
// has, where the records sit in a response, and how to ask for the next page
// (and, where it can, for what changed since last time). Writing them as code
// meant one migration, one review and one release per source. Written as a
// spec, a source is something a person can add for the API they use, and
// something one engine runs with the same guarded fetch, datasets, schedules
// and incremental sync as the built-in sources.
//
// What a spec may NOT do is the point of this file. It names one https host,
// and every request it makes stays on it: a path cannot leave it, a "next
// page" URL from the API cannot leave it, and the credential is sent only
// there. It cannot set Host, Cookie or Authorization headers of its own. It
// holds no secret: the credential is a separate field, picked from your
// secrets, and placed where `auth` says.
//
// Pure and client-safe: the Connect form checks a spec as it is typed, the
// server checks it again before every use, and the engine's paging decisions
// are made here so they can be tested without a network.

export const SPEC_VERSION = 1;

/** Where the credential goes. `{credential}` is the secret, `{username}` the plain field. */
export type ConnectorAuth =
  | { kind: "none" }
  | { kind: "bearer"; optional?: true }
  | { kind: "header"; name: string; prefix?: string; optional?: true }
  | { kind: "basic"; username?: string; password?: string; optional?: true }
  | { kind: "query"; param: string; optional?: true };

/**
 * How to ask for the next page. Every kind also stops at `max_pages`, and says
 * so rather than returning a dataset that is quietly short.
 */
export type ConnectorPagination =
  | { kind: "none" }
  /** ?page=1,2,3…; ends on an empty or short page. */
  | { kind: "page"; param: string; size_param?: string; size?: number; first?: number }
  /** ?offset=0,100,200…; ends on a short page. */
  | { kind: "offset"; param: string; limit_param: string; limit: number }
  /** A cursor the response names, sent back as `param`; ends when there is none. */
  | { kind: "cursor"; param: string; next_path: string; size_param?: string; size?: number }
  /** The full URL of the next page, in the response body. */
  | { kind: "next_url"; next_path: string }
  /** The `Link: <…>; rel="next"` response header. */
  | { kind: "link_header"; size_param?: string; size?: number };

/** How a stream asks for what changed since the last sync. */
export type ConnectorIncremental = {
  /** The query parameter that filters by "changed since". */
  param: string;
  /** How the API wants that value written. */
  format: "iso" | "unix" | "date";
  /** The record field (after flattening) that holds when it changed. */
  cursor_field: string;
  /** The record field that identifies it, so an edit replaces the old row. */
  primary_key: string;
};

export type ConnectorStream = {
  id: string;
  label: string;
  /** Path under base_url, starting with "/". */
  path: string;
  params?: Record<string, string>;
  /** Dotted path to the list in the response; empty when the response is the list. */
  records?: string;
  pagination?: ConnectorPagination;
  incremental?: ConnectorIncremental;
};

export type ConnectorSpec = {
  version: 1;
  name: string;
  /** The one host this connector talks to: https, no query. */
  base_url: string;
  auth: ConnectorAuth;
  headers?: Record<string, string>;
  streams: ConnectorStream[];
  /** Pages one stream may read in a sync; the default is 500. */
  max_pages?: number;
};

export const MAX_SPEC_BYTES = 50_000;
export const MAX_STREAMS = 50;
export const DEFAULT_MAX_PAGES = 500;
const MAX_PAGES_CEILING = 10_000;
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const PARAM = /^[A-Za-z0-9_.\-[\]]{1,80}$/;
const HEADER = /^[A-Za-z0-9-]{1,80}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** Headers a spec may not set: they decide where a request goes, or who it is from. */
const RESERVED_HEADERS = new Set([
  "host",
  "cookie",
  "authorization",
  "proxy-authorization",
  "content-length",
  "transfer-encoding",
  "connection",
]);

type Checked = { ok: true; spec: ConnectorSpec } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const intIn = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

/** A dotted path such as `data.items`; empty means the whole value. */
export function validRecordPath(p: string): boolean {
  return p === "" || p.split(".").every((s) => PATH_SEGMENT.test(s));
}

/** The origin a spec talks to, or null when base_url is not one https origin. */
export function specOrigin(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function checkPagination(raw: unknown, where: string, errors: string[]): ConnectorPagination {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (!isObj(raw)) {
    errors.push(`${where}: pagination must be an object`);
    return { kind: "none" };
  }
  const size = (k: string, hi = 1000) =>
    raw[k] === undefined
      ? undefined
      : (intIn(raw[k], 1, hi) ?? (errors.push(`${where}: ${k} must be 1 to ${hi}`), undefined));
  const param = (k: string, required: boolean) => {
    const v = str(raw[k]);
    if (!v) {
      if (required) errors.push(`${where}: pagination needs ${k}`);
      return undefined;
    }
    if (!PARAM.test(v)) errors.push(`${where}: ${k} "${v}" is not a parameter name`);
    return v;
  };
  const path = (k: string) => {
    const v = typeof raw[k] === "string" ? (raw[k] as string).trim() : "";
    if (!v || !validRecordPath(v))
      errors.push(`${where}: ${k} must be a dotted path such as meta.next`);
    return v;
  };
  switch (raw.kind) {
    case "none":
      return { kind: "none" };
    case "page": {
      const first =
        raw.first === undefined
          ? undefined
          : (intIn(raw.first, 0, 1) ?? (errors.push(`${where}: first must be 0 or 1`), undefined));
      return {
        kind: "page",
        param: param("param", true) ?? "page",
        ...(param("size_param", false) ? { size_param: param("size_param", false)! } : {}),
        ...(size("size") ? { size: size("size")! } : {}),
        ...(first !== undefined ? { first } : {}),
      };
    }
    case "offset": {
      const limit = intIn(raw.limit, 1, 1000);
      if (limit === null) errors.push(`${where}: offset pagination needs a limit of 1 to 1000`);
      return {
        kind: "offset",
        param: param("param", true) ?? "offset",
        limit_param: param("limit_param", true) ?? "limit",
        limit: limit ?? 100,
      };
    }
    case "cursor":
      return {
        kind: "cursor",
        param: param("param", true) ?? "cursor",
        next_path: path("next_path"),
        ...(param("size_param", false) ? { size_param: param("size_param", false)! } : {}),
        ...(size("size") ? { size: size("size")! } : {}),
      };
    case "next_url":
      return { kind: "next_url", next_path: path("next_path") };
    case "link_header":
      return {
        kind: "link_header",
        ...(param("size_param", false) ? { size_param: param("size_param", false)! } : {}),
        ...(size("size") ? { size: size("size")! } : {}),
      };
    default:
      errors.push(
        `${where}: pagination kind must be none, page, offset, cursor, next_url or link_header`,
      );
      return { kind: "none" };
  }
}

/**
 * A spec as the server will run it, or every reason it will not. Unknown keys
 * are dropped; nothing a spec says is used without passing through here.
 */
export function checkConnectorSpec(raw: unknown): Checked {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_SPEC_BYTES) {
      return { ok: false, errors: [`The connector is over ${MAX_SPEC_BYTES / 1000} KB.`] };
    }
    try {
      value = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: [`The connector is not JSON: ${(e as Error).message}`] };
    }
  }
  if (!isObj(value)) return { ok: false, errors: ["The connector must be a JSON object."] };
  const errors: string[] = [];
  if (value.version !== undefined && value.version !== SPEC_VERSION) {
    errors.push(`version must be ${SPEC_VERSION}`);
  }
  const name = str(value.name) ?? "";
  if (!name) errors.push("name is required");
  const baseUrl = str(value.base_url) ?? "";
  const origin = specOrigin(baseUrl);
  if (!origin)
    errors.push("base_url must be an https address with no query, e.g. https://api.example.com/v1");

  // Auth.
  let auth: ConnectorAuth = { kind: "none" };
  const a = isObj(value.auth) ? value.auth : { kind: "none" };
  switch (a.kind) {
    case "none":
      auth = { kind: "none" };
      break;
    case "bearer":
      auth = { kind: "bearer" };
      break;
    case "header": {
      const h = str(a.name);
      if (!h || !HEADER.test(h)) errors.push("auth.name must be a header name");
      else if (RESERVED_HEADERS.has(h.toLowerCase()) && h.toLowerCase() !== "authorization") {
        errors.push(`auth.name "${h}" is not allowed`);
      }
      auth = {
        kind: "header",
        name: h ?? "",
        ...(typeof a.prefix === "string" ? { prefix: a.prefix } : {}),
      };
      break;
    }
    case "basic":
      auth = {
        kind: "basic",
        username: typeof a.username === "string" ? a.username : "{username}",
        password: typeof a.password === "string" ? a.password : "{credential}",
      };
      break;
    case "query": {
      const p = str(a.param);
      if (!p || !PARAM.test(p)) errors.push("auth.param must be a parameter name");
      auth = { kind: "query", param: p ?? "" };
      break;
    }
    default:
      errors.push("auth.kind must be none, bearer, header, basic or query");
  }
  // A public API that also takes a key (a public repository, a rate limit
  // raised by signing in): sent when there is one, left off when not.
  if (a.optional === true && auth.kind !== "none") auth = { ...auth, optional: true };

  // Headers.
  const headers: Record<string, string> = {};
  if (value.headers !== undefined) {
    if (!isObj(value.headers)) errors.push("headers must be an object of name: value");
    else {
      for (const [k, v] of Object.entries(value.headers)) {
        if (!HEADER.test(k)) errors.push(`header "${k}" is not a header name`);
        else if (RESERVED_HEADERS.has(k.toLowerCase())) errors.push(`header "${k}" is not allowed`);
        else if (typeof v !== "string" || /[\r\n]/.test(v))
          errors.push(`header "${k}" must be one line of text`);
        else if (/\{credential\}/.test(v))
          errors.push(`header "${k}": put the credential in auth, not in a header`);
        else headers[k] = v;
      }
    }
  }

  // Streams.
  const streams: ConnectorStream[] = [];
  const rawStreams = Array.isArray(value.streams) ? value.streams : [];
  if (rawStreams.length === 0) errors.push("streams must list at least one stream");
  if (rawStreams.length > MAX_STREAMS) errors.push(`at most ${MAX_STREAMS} streams`);
  const seen = new Set<string>();
  rawStreams.slice(0, MAX_STREAMS).forEach((s, i) => {
    const where = `streams[${i}]`;
    if (!isObj(s)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const id = str(s.id) ?? "";
    if (!ID.test(id))
      errors.push(`${where}: id must be lower case letters, digits and _ (e.g. open_issues)`);
    else if (seen.has(id)) errors.push(`${where}: id "${id}" is used twice`);
    seen.add(id);
    const path = str(s.path) ?? "";
    if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]|\.\.|:\/\//.test(path)) {
      errors.push(
        `${where}: path must start with / and stay on the host, e.g. /v1/orders (parameters go in params)`,
      );
    }
    const params: Record<string, string> = {};
    if (s.params !== undefined) {
      if (!isObj(s.params)) errors.push(`${where}: params must be an object`);
      else {
        for (const [k, v] of Object.entries(s.params)) {
          if (!PARAM.test(k)) errors.push(`${where}: parameter "${k}" is not a parameter name`);
          else if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
            errors.push(`${where}: parameter "${k}" must be text or a number`);
          } else if (/\{credential\}/.test(String(v))) {
            errors.push(`${where}: put the credential in auth, not in a parameter`);
          } else params[k] = String(v);
        }
      }
    }
    const records = typeof s.records === "string" ? s.records.trim() : "";
    if (!validRecordPath(records))
      errors.push(`${where}: records must be a dotted path such as data.items`);
    const pagination = checkPagination(s.pagination, where, errors);
    let incremental: ConnectorIncremental | undefined;
    if (s.incremental !== undefined && s.incremental !== null) {
      const inc = isObj(s.incremental) ? s.incremental : {};
      const p = str(inc.param);
      const cursor = str(inc.cursor_field);
      const key = str(inc.primary_key);
      const format =
        inc.format === "unix" || inc.format === "date"
          ? inc.format
          : inc.format === "iso" || inc.format === undefined
            ? "iso"
            : null;
      if (!p || !PARAM.test(p)) errors.push(`${where}: incremental.param must be a parameter name`);
      if (!cursor)
        errors.push(
          `${where}: incremental.cursor_field names the field that holds when a record changed`,
        );
      if (!key)
        errors.push(`${where}: incremental.primary_key names the field that identifies a record`);
      if (!format) errors.push(`${where}: incremental.format must be iso, unix or date`);
      incremental = {
        param: p ?? "",
        format: format ?? "iso",
        cursor_field: cursor ?? "",
        primary_key: key ?? "",
      };
    }
    streams.push({
      id,
      label: str(s.label) ?? id,
      path,
      ...(Object.keys(params).length ? { params } : {}),
      ...(records ? { records } : {}),
      pagination,
      ...(incremental ? { incremental } : {}),
    });
  });

  let maxPages: number | undefined;
  if (value.max_pages !== undefined) {
    maxPages = intIn(value.max_pages, 1, MAX_PAGES_CEILING) ?? undefined;
    if (maxPages === undefined) errors.push(`max_pages must be 1 to ${MAX_PAGES_CEILING}`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      version: 1,
      name,
      base_url: baseUrl.replace(/\/+$/, ""),
      auth,
      ...(Object.keys(headers).length ? { headers } : {}),
      streams,
      ...(maxPages ? { max_pages: maxPages } : {}),
    },
  };
}

// ── Running a spec: the decisions, without the network ──────────────────────

/** The value at a dotted path, or undefined. */
export function valueAt(body: unknown, path: string | undefined): unknown {
  if (!path) return body;
  let cur: unknown = body;
  for (const seg of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** The records in one response, or an error that says where it looked. */
export function recordsIn(
  body: unknown,
  path: string | undefined,
): { ok: true; records: Record<string, unknown>[] } | { ok: false; error: string } {
  const v = valueAt(body, path);
  // Some APIs answer an empty list with null ("data": null).
  if (v === null && path) return { ok: true, records: [] };
  if (!Array.isArray(v)) {
    const keys = isObj(body) ? Object.keys(body).slice(0, 12).join(", ") : typeof body;
    return {
      ok: false,
      error: path
        ? `There is no list at "${path}" in the response (it has: ${keys}).`
        : `The response is not a list (it has: ${keys}). Set records to the path of the list.`,
    };
  }
  return {
    ok: true,
    records: v.map((r) => (isObj(r) ? r : { value: r })),
  };
}

/** The `rel="next"` URL of a Link header, or null. */
export function linkNext(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (m && /rel\s*=\s*"?next"?/i.test(m[2])) return m[1];
  }
  return null;
}

/** A "changed since" value in the format the API asks for. */
export function sinceParam(since: string, format: ConnectorIncremental["format"]): string | null {
  if (format === "unix" && /^\d+(\.\d+)?$/.test(since)) return String(Math.floor(Number(since)));
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  if (format === "unix") return String(Math.floor(t / 1000));
  if (format === "date") return new Date(t).toISOString().slice(0, 10);
  return new Date(t).toISOString();
}

/** The parameters of a stream's first page. */
export function firstPageParams(stream: ConnectorStream, since?: string): Record<string, string> {
  const p: Record<string, string> = { ...(stream.params ?? {}) };
  const pg = stream.pagination ?? { kind: "none" };
  if (pg.kind === "page") {
    p[pg.param] = String(pg.first ?? 1);
    if (pg.size_param && pg.size) p[pg.size_param] = String(pg.size);
  } else if (pg.kind === "offset") {
    p[pg.param] = "0";
    p[pg.limit_param] = String(pg.limit);
  } else if ((pg.kind === "cursor" || pg.kind === "link_header") && pg.size_param && pg.size) {
    p[pg.size_param] = String(pg.size);
  }
  if (since && stream.incremental) {
    const v = sinceParam(since, stream.incremental.format);
    if (v !== null) p[stream.incremental.param] = v;
  }
  return p;
}

export type PageResult = {
  /** The page just read, as the engine asked for it. */
  url: string;
  body: unknown;
  /** The Link header, for link_header paging. */
  link?: string | null;
  /** How many records the page held. */
  count: number;
};

/**
 * The next page's URL, or null when the stream has ended. A URL the API hands
 * back (next_url, Link) must be on the spec's own origin: the credential goes
 * with it.
 */
export function nextPageUrl(
  stream: ConnectorStream,
  origin: string,
  page: PageResult,
): { url: string } | { end: true } | { error: string } {
  const pg = stream.pagination ?? { kind: "none" };
  const current = new URL(page.url);
  const sameHost = (raw: string): { url: string } | { error: string } => {
    try {
      const u = new URL(raw, current);
      if (u.origin !== origin) {
        return {
          error: `The API's next page is on ${u.origin}, not ${origin}; it was not followed.`,
        };
      }
      return { url: u.toString() };
    } catch {
      return { error: `The API's next page "${raw.slice(0, 80)}" is not an address.` };
    }
  };
  switch (pg.kind) {
    case "none":
      return { end: true };
    case "page": {
      if (page.count === 0 || (pg.size && page.count < pg.size)) return { end: true };
      const n = Number(current.searchParams.get(pg.param) ?? pg.first ?? 1);
      current.searchParams.set(pg.param, String(n + 1));
      return { url: current.toString() };
    }
    case "offset": {
      if (page.count < pg.limit) return { end: true };
      const n = Number(current.searchParams.get(pg.param) ?? 0);
      current.searchParams.set(pg.param, String(n + pg.limit));
      return { url: current.toString() };
    }
    case "cursor": {
      const next = valueAt(page.body, pg.next_path);
      if (next === null || next === undefined || next === "" || next === false)
        return { end: true };
      if (page.count === 0) return { end: true };
      current.searchParams.set(pg.param, String(next));
      return { url: current.toString() };
    }
    case "next_url": {
      const next = valueAt(page.body, pg.next_path);
      if (typeof next !== "string" || !next) return { end: true };
      return sameHost(next);
    }
    case "link_header": {
      const next = linkNext(page.link);
      return next ? sameHost(next) : { end: true };
    }
  }
}

/** The request URL for a stream's first page. */
export function firstPageUrl(spec: ConnectorSpec, stream: ConnectorStream, since?: string): string {
  const u = new URL(spec.base_url + stream.path);
  for (const [k, v] of Object.entries(firstPageParams(stream, since))) u.searchParams.set(k, v);
  return u.toString();
}

/** Fill `{credential}` and `{username}` in an auth value. */
const fill = (template: string, credential: string, username: string) =>
  template.replace(/\{credential\}/g, credential).replace(/\{username\}/g, username);

/**
 * Where the credential goes on a request: headers to add and query
 * parameters to set. Base64 is left to the caller (it differs between the
 * browser and Node).
 */
export function authFor(
  auth: ConnectorAuth,
  credential: string,
  username: string,
): { headers: Record<string, string>; params: Record<string, string>; basic?: [string, string] } {
  switch (auth.kind) {
    case "none":
      return { headers: {}, params: {} };
    case "bearer":
      return { headers: { Authorization: `Bearer ${credential}` }, params: {} };
    case "header":
      return { headers: { [auth.name]: `${auth.prefix ?? ""}${credential}` }, params: {} };
    case "query":
      return { headers: {}, params: { [auth.param]: credential } };
    case "basic":
      return {
        headers: {},
        params: {},
        basic: [
          fill(auth.username ?? "{username}", credential, username),
          fill(auth.password ?? "{credential}", credential, username),
        ],
      };
  }
}

/** Whether text in the Connect form is a spec that will run. */
export function specReady(value: string): boolean {
  return !!value.trim() && checkConnectorSpec(value).ok;
}

/** Whether a spec's auth needs a credential at all. */
export const needsCredential = (auth: ConnectorAuth) =>
  auth.kind !== "none" && !("optional" in auth && auth.optional);

/** The starter a person edits: one stream, the common shape, every field named. */
export const STARTER_SPEC: ConnectorSpec = {
  version: 1,
  name: "My API",
  base_url: "https://api.example.com/v1",
  auth: { kind: "bearer" },
  streams: [
    {
      id: "orders",
      label: "Orders",
      path: "/orders",
      records: "data",
      pagination: { kind: "page", param: "page", size_param: "per_page", size: 100 },
      incremental: {
        param: "updated_since",
        format: "iso",
        cursor_field: "updated_at",
        primary_key: "id",
      },
    },
  ],
};
