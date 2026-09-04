// The pure half of backup/restore: what is stateful, how to reach it, and a
// dependency-free S3 client. No side effects here, so every judgement the
// scripts make can be tested without a bucket or a database.
//
// WHY THIS EXISTS. The deployment docs said Postgres was "the single stateful
// component" and that "Supabase holds all durable state". Both were true of
// the hosted product and false of a self-hosted install, which has FOUR things
// that cannot be regenerated:
//
//   1. the Supabase database      -- users, agents, knowledge, audit trail
//   2. the lakehouse CATALOG      -- a separate Postgres (DuckLake metadata:
//                                    which Parquet files make up which table,
//                                    every snapshot)
//   3. the lakehouse DATA         -- zstd Parquet in your S3-compatible bucket
//   4. the secrets in .env        -- without PROVIDER_CREDS_SECRET a restored
//                                    database cannot decrypt a single stored
//                                    credential; without PROVENANCE_SIGNING_SECRET
//                                    no passport ever issued can be verified
//
// A backup that captures (1) and forgets (2) restores a lakehouse whose tables
// are all present and all unreadable: the catalog knows the files, the files
// are gone, or the files are there and nothing knows they exist.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

/** Parse a .env file into a map without executing anything. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export function loadEnv(path = ".env") {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Env keys whose loss makes a restored database useless or unverifiable.
 * Names only -- a backup manifest must never contain the values.
 */
export const UNRECOVERABLE_SECRETS = [
  ["PROVIDER_CREDS_SECRET", "decrypts every stored provider key, warehouse password and secret"],
  ["PROVIDER_CREDS_SECRET_OLD", "the previous key, if a rotation is in progress"],
  ["PROVENANCE_SIGNING_SECRET", "verifies every Answer Passport ever downloaded"],
  ["SUPABASE_SERVICE_ROLE_KEY", "the server's own database credential"],
  ["INTERNAL_RUN_SECRET", "authenticates scheduled runs"],
  ["NOTEBOOK_RUNTIME_SECRET", "authenticates the notebook gateway"],
  ["LAKEHOUSE_CATALOG_URL", "how the app reaches the lakehouse catalog (contains its password)"],
  ["LAKEHOUSE_S3_KEY_ID", "reads and writes the lake bucket"],
  ["LAKEHOUSE_S3_SECRET", "reads and writes the lake bucket"],
];

/** Which of the unrecoverable secrets are actually set in this deployment. */
export function secretsManifest(env) {
  return UNRECOVERABLE_SECRETS.map(([name, why]) => ({
    name,
    why,
    set: Boolean(env[name] && env[name].length > 0),
  }));
}

/** `s3://bucket/prefix` -> { bucket, prefix }. Prefix has no leading/trailing slash. */
export function parseS3Url(url) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url ?? "");
  if (!m) return null;
  return { bucket: m[1], prefix: m[2].replace(/^\/+|\/+$/g, "") };
}

/** The lake's S3 config from the app's own LAKEHOUSE_* variables, or null. */
export function lakeS3Config(env) {
  const target = parseS3Url(env.LAKEHOUSE_DATA_URL);
  if (!target || !env.LAKEHOUSE_S3_KEY_ID || !env.LAKEHOUSE_S3_SECRET) return null;
  const endpoint = env.LAKEHOUSE_S3_ENDPOINT || "";
  const useSsl = String(env.LAKEHOUSE_S3_USE_SSL ?? "true").toLowerCase() !== "false";
  return {
    ...target,
    endpoint,
    region: env.LAKEHOUSE_S3_REGION || "us-east-1",
    pathStyle: (env.LAKEHOUSE_S3_URL_STYLE || (endpoint ? "path" : "vhost")) === "path",
    useSsl,
    keyId: env.LAKEHOUSE_S3_KEY_ID,
    secret: env.LAKEHOUSE_S3_SECRET,
  };
}

/** Postgres connection pieces from the catalog URL, for pg_dump/pg_restore. */
export function parsePostgresUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

/** The same URL with a different database -- for restoring beside the live catalog. */
export function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * How to run pg_dump / psql / pg_restore against the catalog named in
 * LAKEHOUSE_CATALOG_URL. Decided from the URL's HOST, never from what happens
 * to be running: on the first machine this ran on, the compose service
 * `lakehouse-catalog` was an idle, empty twin of the standalone container the
 * app actually used, and "the compose service is up, exec into it" dumped 0
 * tables and exited 0. Order:
 *
 *   1. a Docker container whose name is the host  -> docker exec -i <host>
 *   2. the compose service, if the host is one of its network aliases
 *   3. local client binaries against the URL      -> pg_dump --dbname=<url>
 *
 * `probes` are injected so the choice is testable without Docker.
 */
export function resolveCatalogRunner(host, probes) {
  if (host && probes.containerExists(host)) {
    return {
      kind: "container",
      bin: "docker",
      prefix: ["exec", "-i", host],
      via: `docker exec ${host}`,
    };
  }
  if (host && probes.composeAliases().includes(host)) {
    return {
      kind: "compose",
      bin: "docker",
      prefix: ["compose", "exec", "-T", "lakehouse-catalog"],
      via: "docker compose exec lakehouse-catalog",
    };
  }
  return { kind: "local", bin: null, prefix: [], via: "local pg client" };
}

/**
 * Read a `pg_restore -l` table of contents and refuse anything that is not a
 * DuckLake catalog. A wrong or empty Postgres answering pg_dump is the
 * silent failure mode of catalog backups; the schema alone is ~70 tables and
 * always includes ducklake_snapshot.
 */
export function checkCatalogDump(toc, what) {
  const objects = String(toc ?? "")
    .split("\n")
    .filter((l) => /^\d+;/.test(l)).length;
  if (!String(toc ?? "").includes("ducklake_snapshot")) {
    throw new Error(
      `dump of ${what} has ${objects} objects and no ducklake_snapshot table -- this is not the catalog the app uses`,
    );
  }
  return { objects };
}

// ── Minimal S3 SigV4 client (list / get / put) ──────────────────────────────

const sha256 = (d) => createHash("sha256").update(d).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();

function awsEncode(s, keepSlash) {
  const enc = (x) =>
    encodeURIComponent(x).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return keepSlash ? s.split("/").map(enc).join("/") : enc(s);
}

export function s3Target(cfg) {
  const scheme = cfg.useSsl ? "https" : "http";
  if (cfg.endpoint) {
    const host = cfg.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return cfg.pathStyle
      ? { origin: `${scheme}://${host}`, host, basePath: `/${cfg.bucket}` }
      : {
          origin: `${scheme}://${cfg.bucket}.${host}`,
          host: `${cfg.bucket}.${host}`,
          basePath: "",
        };
  }
  const host = `s3.${cfg.region}.amazonaws.com`;
  return cfg.pathStyle
    ? { origin: `https://${host}`, host, basePath: `/${cfg.bucket}` }
    : { origin: `https://${cfg.bucket}.${host}`, host: `${cfg.bucket}.${host}`, basePath: "" };
}

/** SigV4 pieces for one request. Exported so the canonicalisation is testable. */
export function signS3({ method, cfg, key, query = {}, payloadHash, amzDate, extraHeaders = {} }) {
  const { host, basePath } = s3Target(cfg);
  const canonicalUri = awsEncode(`${basePath}/${key}`.replace(/\/{2,}/g, "/"), true) || "/";
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(query[k])}`)
    .join("&");
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((k) => `${k}:${String(headers[k]).trim()}\n`).join("");
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signed.join(";"),
    payloadHash,
  ].join("\n");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${cfg.secret}`, date);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
  return { canonicalUri, canonicalQuery, headers, authorization };
}

function amzNow() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

async function s3Request(method, cfg, key, query, body, extraHeaders = {}) {
  const payloadHash = body ? sha256(body) : sha256("");
  const amzDate = amzNow();
  const { canonicalUri, canonicalQuery, headers, authorization } = signS3({
    method,
    cfg,
    key,
    query,
    payloadHash,
    amzDate,
    extraHeaders,
  });
  const { origin } = s3Target(cfg);
  const url = `${origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const { host: _h, ...send } = headers;
  const res = await fetch(url, {
    method,
    headers: { ...send, Authorization: authorization },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 ${method} ${key || "(list)"} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}

const tag = (xml, name) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? null;
const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Every object under the prefix: { key, size }. */
export async function s3List(cfg) {
  const out = [];
  let token;
  for (;;) {
    const query = { "list-type": "2", "max-keys": "1000" };
    if (cfg.prefix) query.prefix = `${cfg.prefix}/`;
    if (token) query["continuation-token"] = token;
    const xml = await (await s3Request("GET", cfg, "", query)).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = tag(m[1], "Key");
      if (!key || key.endsWith("/")) continue;
      out.push({ key: unescapeXml(key), size: Number(tag(m[1], "Size") ?? 0) });
    }
    if (tag(xml, "IsTruncated") !== "true") break;
    token = tag(xml, "NextContinuationToken");
    if (!token) break;
  }
  return out;
}

export async function s3Get(cfg, key) {
  return Buffer.from(await (await s3Request("GET", cfg, key, {})).arrayBuffer());
}

export async function s3Put(cfg, key, body) {
  await s3Request("PUT", cfg, key, {}, body, { "content-length": String(body.length) });
}

/** Used only by the restore drill to remove its own scratch prefix. */
export async function s3Delete(cfg, key) {
  await s3Request("DELETE", cfg, key, {});
}
