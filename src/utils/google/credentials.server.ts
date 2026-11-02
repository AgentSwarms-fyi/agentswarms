// The app's own Google Cloud identity: the access token it presents when it
// calls Google Cloud as itself (Cloud KMS today). Never for a connection a
// user configures — those carry their own service account keys
// (google/serviceAccount.server).
//
// Application Default Credentials as Google's libraries find them, without
// gcloud's well-known file in the home directory (a server reads what it is
// pointed at):
//
//   1. GOOGLE_APPLICATION_CREDENTIALS, a JSON file of one of these types:
//        service_account     a key: a JWT signed with it, exchanged at its token_uri
//        authorized_user     `gcloud auth application-default login`: a refresh token
//        external_account    workload identity federation: another identity
//                            provider's token, read from a file (AKS, EKS, a CI's
//                            OIDC token) or a URL, exchanged at Google's STS, and
//                            usually then for a service account's
//        impersonated_service_account
//                            a service_account or authorized_user credential
//                            acting as another service account
//   2. the metadata server   Compute Engine, GKE workload identity, Cloud Run,
//                            Cloud Functions; GCE_METADATA_HOST moves it
//
// If the file is set it is the source, and if it fails that is the error:
// falling through to the metadata server would act as an identity the operator
// did not choose. The token calls (oauth2, sts, iamcredentials) go through the
// caller's fetch — the proxy and the SSRF guard — and are not held to
// KMS_REQUIRE_PRIVATE: they carry the app's credential, never key material
// (over Private Service Connect the caller names the endpoint's own oauth2
// host). The metadata server is a link-local address the SSRF guard refuses
// for every other caller: reached here at a fixed URL or one the operator set,
// directly, never through the proxy, never following a redirect.
import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import { Agent } from "undici";

import { SsrfRefusedError } from "@/utils/ssrfGuard.server";

export type GoogleCredentialSource =
  "service-account" | "authorized-user" | "external-account" | "impersonated" | "metadata";

export type GoogleAccessToken = {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  source: GoogleCredentialSource;
  /** Who the app is, for the settings card: never a secret. */
  identity: string;
  /** A user credential's quota project, sent as x-goog-user-project. */
  quotaProject?: string;
};

export class GoogleCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleCredentialsError";
  }
}

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type GoogleCredentialDeps = {
  /** oauth2, sts, iamcredentials: the caller's guarded fetch. */
  tokenFetch?: Fetch;
  /** The metadata server, and a link-local credential_source URL: direct. */
  metadataFetch?: Fetch;
  readFile?: (path: string) => string;
  now?: () => number;
};

/** Refresh this long before a token expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const METADATA_TIMEOUT_MS = 2000;
const TOKEN_TIMEOUT_MS = 10_000;
const METADATA = "http://169.254.169.254";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

let directAgent: Agent | null = null;
function direct(): Agent {
  return (directAgent ??= new Agent({ connect: { timeout: METADATA_TIMEOUT_MS } }));
}

const defaultMetadataFetch: Fetch = (url, init) =>
  fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS * 2),
    dispatcher: direct(),
  } as RequestInit);

const v = (env: Env, name: string) => (env[name] ?? "").trim();
const str = (o: Record<string, unknown>, k: string) =>
  typeof o[k] === "string" ? (o[k] as string).trim() : "";

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The loopback and link-local addresses: the only hosts a credential_source
// URL is fetched from directly rather than through the guarded fetch.
function localHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    h === "::1" ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h === "metadata.google.internal"
  );
}

/** An http(s) URL from the credential file: no user info, no fragment. */
function checkedUrl(raw: string, what: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GoogleCredentialsError(`${what} "${raw}" is not a URL`);
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.hash) {
    throw new GoogleCredentialsError(`${what} must be an http(s) URL, not ${raw}`);
  }
  return u.toString();
}

type CredentialFile = { path: string; json: Record<string, unknown>; type: string };

function readCredentialFile(env: Env, readFile: (p: string) => string): CredentialFile | null {
  const path = v(env, "GOOGLE_APPLICATION_CREDENTIALS");
  if (!path) return null;
  let text: string;
  try {
    text = readFile(path);
  } catch (e) {
    throw new GoogleCredentialsError(
      `Could not read GOOGLE_APPLICATION_CREDENTIALS (${path}): ${(e as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GoogleCredentialsError(`GOOGLE_APPLICATION_CREDENTIALS (${path}) is not JSON`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new GoogleCredentialsError(
      `GOOGLE_APPLICATION_CREDENTIALS (${path}) is not a credential`,
    );
  }
  const type = str(json as Record<string, unknown>, "type");
  return { path, json: json as Record<string, unknown>, type };
}

const SOURCES: Record<string, GoogleCredentialSource> = {
  service_account: "service-account",
  authorized_user: "authorized-user",
  external_account: "external-account",
  impersonated_service_account: "impersonated",
};

function sourceOf(file: CredentialFile): GoogleCredentialSource {
  const source = SOURCES[file.type];
  if (!source) {
    throw new GoogleCredentialsError(
      `GOOGLE_APPLICATION_CREDENTIALS (${file.path}) is a "${file.type || "untyped"}" credential; ` +
        `use a service_account key, an authorized_user, an external_account (workload identity ` +
        `federation) or an impersonated_service_account file`,
    );
  }
  return source;
}

/** Which source the environment selects, reading the credential file but calling nothing. */
export function googleCredentialSource(
  env: Env = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): GoogleCredentialSource {
  const file = readCredentialFile(env, readFile);
  return file ? sourceOf(file) : "metadata";
}

/** Google's OAuth and STS errors ("invalid_grant: Invalid JWT Signature."), or an API error's. */
function googleError(body: Record<string, unknown>, status: number): string {
  if (body.error && typeof body.error === "object") {
    const e = body.error as Record<string, unknown>;
    const what = str(e, "status") || `HTTP ${status}`;
    return str(e, "message") ? `${what}: ${str(e, "message")}` : what;
  }
  const code = str(body, "error") || `HTTP ${status}`;
  const desc = str(body, "error_description");
  return desc ? `${code}: ${desc}` : code;
}

/**
 * The assertion a service account key signs to ask for a token: RS256 over
 * {iss, scope, aud, iat, exp}, the key's id in the header. The audience is the
 * key's token_uri even when the request goes to a Private Service Connect name.
 */
export function serviceAccountAssertion(args: {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  scope: string;
  audience: string;
  now: number;
}): string {
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(args.privateKey);
  } catch (e) {
    throw new GoogleCredentialsError(
      `The service account's private_key could not be read: ${(e as Error).message}`,
    );
  }
  const iat = Math.floor(args.now / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(args.privateKeyId ? { kid: args.privateKeyId } : {}),
  };
  const claims = {
    iss: args.clientEmail,
    scope: args.scope,
    aud: args.audience,
    iat,
    exp: iat + 3600,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign("RSA-SHA256").update(input).sign(key);
  return `${input}.${b64url(sig)}`;
}

type Deps = Required<GoogleCredentialDeps>;

async function post(
  deps: Deps,
  url: string,
  init: { headers: Record<string, string>; body: string },
  who: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await deps.tokenFetch(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof SsrfRefusedError) throw e;
    throw new GoogleCredentialsError(
      `${who} at ${new URL(url).host} could not be reached: ${(e as Error).message}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new GoogleCredentialsError(`${who} refused: ${googleError(body, res.status)}`);
  return body;
}

function form(fields: Record<string, string>) {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

/** {access_token, expires_in}: oauth2, sts and the metadata server answer alike. */
function oauthToken(body: Record<string, unknown>, now: number, who: string) {
  const token = str(body, "access_token");
  if (!token) throw new GoogleCredentialsError(`${who} returned no access token`);
  const inS = Number(body.expires_in);
  if (!Number.isFinite(inS) || inS <= 0)
    throw new GoogleCredentialsError(`${who} returned no expiry`);
  return { token, expiresAt: now + inS * 1000 };
}

function required(file: CredentialFile, names: string[], what: string): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const val = str(file.json, n);
    if (val) out[n] = val;
    else missing.push(n);
  }
  if (missing.length) {
    throw new GoogleCredentialsError(
      `GOOGLE_APPLICATION_CREDENTIALS (${file.path}) is ${what} without ${missing.join(", ")}`,
    );
  }
  return out;
}

async function fromServiceAccount(
  json: Record<string, unknown>,
  file: CredentialFile,
  scope: string,
  tokenUrl: string | undefined,
  deps: Deps,
): Promise<{ token: string; expiresAt: number; identity: string }> {
  const sa = required({ ...file, json }, ["client_email", "private_key"], "a service account key");
  const tokenUri = checkedUrl(str(json, "token_uri") || DEFAULT_TOKEN_URI, "The key's token_uri");
  const assertion = serviceAccountAssertion({
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
    privateKeyId: str(json, "private_key_id") || undefined,
    scope,
    audience: tokenUri,
    now: deps.now(),
  });
  const keyId = str(json, "private_key_id");
  const identity = `service account ${sa.client_email}${keyId ? ` (key ${keyId.slice(0, 8)}…)` : ""}`;
  const body = await post(
    deps,
    tokenUrl ?? tokenUri,
    form({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    `Google's token endpoint, for ${identity},`,
  );
  return { ...oauthToken(body, deps.now(), "Google's token endpoint"), identity };
}

async function fromAuthorizedUser(
  json: Record<string, unknown>,
  file: CredentialFile,
  tokenUrl: string | undefined,
  deps: Deps,
): Promise<{ token: string; expiresAt: number; identity: string; quotaProject?: string }> {
  const u = required(
    { ...file, json },
    ["client_id", "client_secret", "refresh_token"],
    "an authorized_user credential",
  );
  const tokenUri = checkedUrl(str(json, "token_uri") || DEFAULT_TOKEN_URI, "The token_uri");
  const identity = `user credentials (gcloud auth application-default login, client ${u.client_id.split(".")[0].slice(0, 12)}…)`;
  const body = await post(
    deps,
    tokenUrl ?? tokenUri,
    form({
      grant_type: "refresh_token",
      client_id: u.client_id,
      client_secret: u.client_secret,
      refresh_token: u.refresh_token,
    }),
    `Google's token endpoint, for ${identity},`,
  );
  const quotaProject = str(json, "quota_project_id");
  return {
    ...oauthToken(body, deps.now(), "Google's token endpoint"),
    identity,
    ...(quotaProject ? { quotaProject } : {}),
  };
}

/** The other identity provider's token, from the file or the URL credential_source names. */
async function subjectToken(file: CredentialFile, deps: Deps): Promise<string> {
  const src = file.json.credential_source;
  if (!src || typeof src !== "object") {
    throw new GoogleCredentialsError(
      `GOOGLE_APPLICATION_CREDENTIALS (${file.path}) is an external_account without a credential_source`,
    );
  }
  const s = src as Record<string, unknown>;
  if (s.environment_id || s.executable) {
    throw new GoogleCredentialsError(
      `GOOGLE_APPLICATION_CREDENTIALS (${file.path}) takes its token from ` +
        `${s.environment_id ? "AWS" : "an executable"}; this build reads a file or a URL ` +
        `(credential_source.file or .url): on AWS, use the EC2 or EKS identity's OIDC token file`,
    );
  }
  const format = (s.format ?? {}) as Record<string, unknown>;
  const asJson = str(format, "type") === "json";
  const field = str(format, "subject_token_field_name");
  if (asJson && !field) {
    throw new GoogleCredentialsError(
      `credential_source.format is json without subject_token_field_name (${file.path})`,
    );
  }
  let raw: string;
  let where: string;
  if (str(s, "file")) {
    where = str(s, "file");
    try {
      raw = deps.readFile(where); // read every time: the platform rotates it
    } catch (e) {
      throw new GoogleCredentialsError(
        `Could not read the workload identity token file ${where}: ${(e as Error).message}`,
      );
    }
  } else if (str(s, "url")) {
    const url = checkedUrl(str(s, "url"), "credential_source.url");
    where = url;
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries((s.headers ?? {}) as Record<string, unknown>)) {
      if (typeof val !== "string" || /[\r\n]/.test(val) || /[\r\n:]/.test(k)) {
        throw new GoogleCredentialsError(`credential_source.headers.${k} is not a header value`);
      }
      headers[k] = val;
    }
    const get = localHost(new URL(url).hostname) ? deps.metadataFetch : deps.tokenFetch;
    let res: Response;
    try {
      res = await get(url, { method: "GET", headers });
    } catch (e) {
      if (e instanceof SsrfRefusedError) throw e;
      throw new GoogleCredentialsError(
        `The workload identity token URL ${new URL(url).host} could not be reached: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new GoogleCredentialsError(
        `The workload identity token URL ${new URL(url).host} answered HTTP ${res.status}`,
      );
    }
    raw = await res.text();
  } else {
    throw new GoogleCredentialsError(
      `credential_source in ${file.path} names neither a file nor a url`,
    );
  }
  let token = raw.trim();
  if (asJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      throw new GoogleCredentialsError(`The workload identity token from ${where} is not JSON`);
    }
    const t = (parsed as Record<string, unknown>)?.[field];
    token = typeof t === "string" ? t.trim() : "";
  }
  if (!token)
    throw new GoogleCredentialsError(`The workload identity token from ${where} is empty`);
  return token;
}

/** A service account's email from its impersonation URL (…/serviceAccounts/<email>:generateAccessToken). */
function impersonatedEmail(url: string): string {
  const m = /\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(new URL(url).pathname);
  return m ? decodeURIComponent(m[1]) : "a service account";
}

/** iamcredentials generateAccessToken: {accessToken, expireTime}. */
async function impersonate(
  url: string,
  sourceToken: string,
  scope: string,
  lifetimeS: number,
  deps: Deps,
): Promise<{ token: string; expiresAt: number }> {
  const body = await post(
    deps,
    url,
    {
      headers: { "content-type": "application/json", authorization: `Bearer ${sourceToken}` },
      body: JSON.stringify({ scope: [scope], lifetime: `${lifetimeS}s` }),
    },
    `Impersonating ${impersonatedEmail(url)}`,
  );
  const token = str(body, "accessToken");
  const exp = Date.parse(str(body, "expireTime"));
  if (!token || !Number.isFinite(exp)) {
    throw new GoogleCredentialsError(
      `Impersonating ${impersonatedEmail(url)} returned no access token or expiry`,
    );
  }
  return { token, expiresAt: exp };
}

async function fromExternalAccount(
  file: CredentialFile,
  scope: string,
  deps: Deps,
): Promise<{ token: string; expiresAt: number; identity: string }> {
  const ext = required(file, ["audience", "subject_token_type"], "an external_account");
  const tokenUrl = checkedUrl(
    str(file.json, "token_url") || "https://sts.googleapis.com/v1/token",
    "token_url",
  );
  const impersonationUrl = str(file.json, "service_account_impersonation_url");
  const subject = await subjectToken(file, deps);
  const fields: Record<string, string> = {
    grant_type: TOKEN_EXCHANGE,
    audience: ext.audience,
    // Impersonation needs a cloud-platform token to call iamcredentials;
    // without it, the federated token is the one that calls the API.
    scope: impersonationUrl ? CLOUD_PLATFORM : scope,
    requested_token_type: ACCESS_TOKEN_TYPE,
    subject_token: subject,
    subject_token_type: ext.subject_token_type,
  };
  const userProject = str(file.json, "workforce_pool_user_project");
  if (userProject) fields.options = JSON.stringify({ userProject });
  const pool = /\/(?:workloadIdentityPools|workforcePools)\/([^/]+)/.exec(ext.audience)?.[1];
  const federated = `workload identity federation${pool ? ` (pool ${pool})` : ""}`;
  const sts = oauthToken(
    await post(deps, tokenUrl, form(fields), `Google's Security Token Service, for ${federated},`),
    deps.now(),
    "Google's Security Token Service",
  );
  if (!impersonationUrl) return { ...sts, identity: federated };
  const url = checkedUrl(impersonationUrl, "service_account_impersonation_url");
  const lifetime = Number(
    ((file.json.service_account_impersonation ?? {}) as Record<string, unknown>)
      .token_lifetime_seconds,
  );
  const t = await impersonate(
    url,
    sts.token,
    scope,
    Number.isFinite(lifetime) && lifetime >= 600 && lifetime <= 43200 ? lifetime : 3600,
    deps,
  );
  return { ...t, identity: `service account ${impersonatedEmail(url)}, through ${federated}` };
}

async function fromImpersonated(
  file: CredentialFile,
  scope: string,
  tokenUrl: string | undefined,
  deps: Deps,
): Promise<{ token: string; expiresAt: number; identity: string }> {
  const { service_account_impersonation_url: raw } = required(
    file,
    ["service_account_impersonation_url"],
    "an impersonated_service_account",
  );
  const url = checkedUrl(raw, "service_account_impersonation_url");
  const src = file.json.source_credentials;
  if (!src || typeof src !== "object") {
    throw new GoogleCredentialsError(
      `GOOGLE_APPLICATION_CREDENTIALS (${file.path}) is an impersonated_service_account without source_credentials`,
    );
  }
  const json = src as Record<string, unknown>;
  const type = str(json, "type");
  const source =
    type === "service_account"
      ? await fromServiceAccount(json, file, CLOUD_PLATFORM, tokenUrl, deps)
      : type === "authorized_user"
        ? await fromAuthorizedUser(json, file, tokenUrl, deps)
        : null;
  if (!source) {
    throw new GoogleCredentialsError(
      `The source_credentials in ${file.path} are "${type || "untyped"}"; use a service_account key or an authorized_user`,
    );
  }
  const t = await impersonate(url, source.token, scope, 3600, deps);
  return { ...t, identity: `service account ${impersonatedEmail(url)}, as ${source.identity}` };
}

/** The metadata server's origin: GCE_METADATA_HOST (host[:port]), else 169.254.169.254. */
export function metadataOrigin(env: Env = process.env): string {
  const host = v(env, "GCE_METADATA_HOST");
  if (!host) return METADATA;
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:]+\](?::\d{1,5})?$/.test(host)) {
    throw new GoogleCredentialsError(`GCE_METADATA_HOST must be host[:port], not ${host}`);
  }
  return `http://${host}`;
}

async function fromMetadata(
  env: Env,
  scope: string,
  deps: Deps,
): Promise<{ token: string; expiresAt: number; identity: string }> {
  const base = `${metadataOrigin(env)}/computeMetadata/v1/instance/service-accounts/default`;
  const headers = { "metadata-flavor": "Google" };
  let res: Response;
  try {
    res = await deps.metadataFetch(`${base}/token?scopes=${encodeURIComponent(scope)}`, {
      method: "GET",
      headers,
    });
  } catch (e) {
    throw new GoogleCredentialsError(
      `No Google credentials: GOOGLE_APPLICATION_CREDENTIALS is not set, and the metadata server ` +
        `(${new URL(base).host}) did not answer (${(e as Error).message}). Run on Compute Engine, ` +
        `GKE with workload identity or Cloud Run with a service account, or point ` +
        `GOOGLE_APPLICATION_CREDENTIALS at a credential file.`,
    );
  }
  // A metadata server says so in a header; anything else at that address is not one.
  if (res.headers.get("metadata-flavor") !== "Google") {
    throw new GoogleCredentialsError(
      `${new URL(base).host} answered, but not as Google's metadata server (no Metadata-Flavor: Google)`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GoogleCredentialsError(
      `The metadata server gave no token: ${googleError(body, res.status)}`,
    );
  }
  const t = oauthToken(body, deps.now(), "The metadata server");
  let email = "";
  try {
    const r = await deps.metadataFetch(`${base}/email`, { method: "GET", headers });
    if (r.ok) email = (await r.text()).trim();
  } catch {
    /* the name is for the card; the token is what matters */
  }
  return {
    ...t,
    identity: email
      ? `service account ${email} (metadata server)`
      : "the instance's service account (metadata server)",
  };
}

export type GoogleCredentialChain = {
  readonly source: GoogleCredentialSource;
  /** Cached until five minutes before it expires; concurrent callers share one fetch. */
  get(): Promise<GoogleAccessToken>;
};

/**
 * A token source for one OAuth scope, e.g. https://www.googleapis.com/auth/cloudkms.
 * `tokenUrl` replaces the oauth2 endpoint a service account key or user
 * credential is exchanged at (a Private Service Connect name); the JWT's
 * audience stays the key's own token_uri.
 */
export function createGoogleCredentialChain(
  args: { scope: string; env?: Env; tokenUrl?: string } & GoogleCredentialDeps,
): GoogleCredentialChain {
  const env = args.env ?? process.env;
  const deps: Deps = {
    tokenFetch: args.tokenFetch ?? ((url, init) => fetch(url, init)),
    metadataFetch: args.metadataFetch ?? defaultMetadataFetch,
    readFile: args.readFile ?? ((p) => readFileSync(p, "utf8")),
    now: args.now ?? Date.now,
  };
  const source = googleCredentialSource(env, deps.readFile);
  let cached: GoogleAccessToken | null = null;
  let inflight: Promise<GoogleAccessToken> | null = null;

  async function load(): Promise<GoogleAccessToken> {
    if (source === "metadata") {
      return { ...(await fromMetadata(env, args.scope, deps)), source };
    }
    // Read again on every refresh: a replaced key file is picked up.
    const file = readCredentialFile(env, deps.readFile)!;
    const t =
      source === "service-account"
        ? await fromServiceAccount(file.json, file, args.scope, args.tokenUrl, deps)
        : source === "authorized-user"
          ? await fromAuthorizedUser(file.json, file, args.tokenUrl, deps)
          : source === "external-account"
            ? await fromExternalAccount(file, args.scope, deps)
            : await fromImpersonated(file, args.scope, args.tokenUrl, deps);
    return { ...t, source };
  }

  return {
    source,
    get() {
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > deps.now()) {
        return Promise.resolve(cached);
      }
      if (inflight) return inflight;
      inflight = load()
        .then((t) => (cached = t))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
