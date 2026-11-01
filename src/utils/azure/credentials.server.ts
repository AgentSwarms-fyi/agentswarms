// The app's own Microsoft Entra ID identity: the access token it presents when
// it calls Azure as itself (Azure Key Vault today). Never for a connection a
// user configures — those carry their own credentials.
//
// The sources, in the order DefaultAzureCredential tries them. The FIRST
// source whose variables are present is the source; if it fails, that is the
// error. Falling through to another identity would act as one the operator did
// not choose.
//
//   1. client secret       AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET
//   2. client certificate  AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_CERTIFICATE_PATH
//                          (a PEM holding the private key and the certificate)
//   3. workload identity   AZURE_FEDERATED_TOKEN_FILE + AZURE_CLIENT_ID + AZURE_TENANT_ID —
//                          AKS workload identity, or any federated credential
//   4. managed identity    App Service / Container Apps (IDENTITY_ENDPOINT +
//                          IDENTITY_HEADER), else the instance metadata service;
//                          AZURE_CLIENT_ID picks a user-assigned identity
//
// 1–3 exchange a credential at Microsoft Entra ID (AZURE_AUTHORITY_HOST,
// default https://login.microsoftonline.com) through the caller's fetch: the
// proxy and the SSRF guard. Entra ID has no private endpoint, so that call is
// not held to KMS_REQUIRE_PRIVATE; it carries the app's credential, never key
// material. 4 is a link-local or loopback endpoint the SSRF guard refuses for
// every other caller: reached here only at a fixed URL, or one the operator
// set, through a direct connection that never uses the proxy and never follows
// a redirect — the same client the AWS chain uses for its metadata endpoints.
import { createHash, createPrivateKey, createSign, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { Agent } from "undici";

import { SsrfRefusedError } from "@/utils/ssrfGuard.server";

export type AzureCredentialSource =
  "client-secret" | "client-certificate" | "workload-identity" | "managed-identity";

export type AzureAccessToken = {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  source: AzureCredentialSource;
  /** Who the app is, for the settings card: never a secret. */
  identity: string;
};

export class AzureCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureCredentialsError";
  }
}

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type AzureCredentialDeps = {
  /** Entra ID: the caller's guarded fetch. */
  tokenFetch?: Fetch;
  /** Managed identity endpoints: direct, no proxy. Tests replace it. */
  metadataFetch?: Fetch;
  readFile?: (path: string) => string;
  now?: () => number;
};

/** Refresh this long before a token expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const METADATA_TIMEOUT_MS = 2000;
const TOKEN_TIMEOUT_MS = 10_000;
const IMDS = "http://169.254.169.254";

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

// A tenant is a GUID or a domain; it goes into a URL path.
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/;
const CLIENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireAll(env: Env, source: string, names: string[]): void {
  const missing = names.filter((n) => !v(env, n));
  if (missing.length) {
    throw new AzureCredentialsError(
      `${source} needs ${names.join(", ")}; ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set`,
    );
  }
  const tenant = v(env, "AZURE_TENANT_ID");
  if (names.includes("AZURE_TENANT_ID") && !TENANT.test(tenant)) {
    throw new AzureCredentialsError(`AZURE_TENANT_ID "${tenant}" is not a tenant id or domain`);
  }
  const client = v(env, "AZURE_CLIENT_ID");
  if (names.includes("AZURE_CLIENT_ID") && !CLIENT_ID.test(client)) {
    throw new AzureCredentialsError(
      `AZURE_CLIENT_ID "${client}" is not an application (client) id`,
    );
  }
}

/** Which source the environment selects, without calling anything. */
export function azureCredentialSource(env: Env = process.env): AzureCredentialSource {
  if (v(env, "AZURE_CLIENT_SECRET")) {
    requireAll(env, "A client secret", [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
    ]);
    return "client-secret";
  }
  if (v(env, "AZURE_CLIENT_CERTIFICATE_PATH")) {
    requireAll(env, "A client certificate", [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_CERTIFICATE_PATH",
    ]);
    return "client-certificate";
  }
  if (v(env, "AZURE_FEDERATED_TOKEN_FILE")) {
    requireAll(env, "Workload identity", [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_FEDERATED_TOKEN_FILE",
    ]);
    return "workload-identity";
  }
  const client = v(env, "AZURE_CLIENT_ID");
  if (client && !CLIENT_ID.test(client)) {
    throw new AzureCredentialsError(
      `AZURE_CLIENT_ID "${client}" is not an application (client) id`,
    );
  }
  return "managed-identity";
}

/** The Entra ID authority, checked: https only, an origin. */
export function authorityHost(env: Env = process.env): string {
  const raw = v(env, "AZURE_AUTHORITY_HOST") || "https://login.microsoftonline.com";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AzureCredentialsError(`AZURE_AUTHORITY_HOST "${raw}" is not a URL`);
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) {
    throw new AzureCredentialsError(`AZURE_AUTHORITY_HOST must be an https origin, not ${raw}`);
  }
  return u.origin;
}

// The rule the SDKs and the AWS chain share for a plain-http identity
// endpoint: the loopback and the link-local metadata addresses only.
function localIdentityHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    h === "::1" ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * The managed identity endpoint the environment names. App Service and
 * Container Apps set IDENTITY_ENDPOINT (loopback); the instance metadata
 * service is the default, and AZURE_POD_IDENTITY_AUTHORITY_HOST moves it — the
 * SDKs' own variable, also how an emulator is reached.
 */
export function managedIdentityEndpoint(env: Env = process.env): {
  kind: "app-service" | "imds";
  url: string;
} {
  const endpoint = v(env, "IDENTITY_ENDPOINT");
  if (endpoint) {
    if (!v(env, "IDENTITY_HEADER")) {
      throw new AzureCredentialsError("IDENTITY_ENDPOINT is set without IDENTITY_HEADER");
    }
    return { kind: "app-service", url: checkedLocalUrl(endpoint, "IDENTITY_ENDPOINT", false) };
  }
  const host = v(env, "AZURE_POD_IDENTITY_AUTHORITY_HOST");
  const base = host ? checkedLocalUrl(host, "AZURE_POD_IDENTITY_AUTHORITY_HOST", true) : IMDS;
  return { kind: "imds", url: `${base.replace(/\/+$/, "")}/metadata/identity/oauth2/token` };
}

function checkedLocalUrl(raw: string, name: string, originOnly: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AzureCredentialsError(`${name} "${raw}" is not a URL`);
  }
  if (u.username || u.password || u.hash || (originOnly && (u.search || u.pathname !== "/"))) {
    throw new AzureCredentialsError(
      `${name} must be ${originOnly ? "an origin" : "a URL"}: ${raw}`,
    );
  }
  if (u.protocol === "https:") return originOnly ? u.origin : u.toString();
  // Plain http: IDENTITY_ENDPOINT, which the platform sets, only to the
  // loopback or a link-local address. AZURE_POD_IDENTITY_AUTHORITY_HOST is
  // the operator moving the metadata service on purpose (an emulator, a pod
  // identity proxy); the SDKs accept any URL there, as the AWS chain does
  // AWS_EC2_METADATA_SERVICE_ENDPOINT.
  if (u.protocol === "http:" && (localIdentityHost(u.hostname) || originOnly)) {
    return originOnly ? u.origin : u.toString();
  }
  throw new AzureCredentialsError(
    `${name} must be https, or http to the loopback or a link-local address, not ${u.protocol}//${u.host}`,
  );
}

function expiryOf(body: Record<string, unknown>, now: number, source: string): number {
  // Entra ID gives expires_in (seconds from now); the managed identity
  // endpoints give expires_on (epoch seconds), sometimes as a string.
  const on = Number(body.expires_on);
  if (Number.isFinite(on) && on > 0) return on * 1000;
  const inS = Number(body.expires_in);
  if (Number.isFinite(inS) && inS > 0) return now + inS * 1000;
  throw new AzureCredentialsError(`${source} returned no expiry`);
}

function tokenFrom(body: Record<string, unknown>, source: string): string {
  const t = body.access_token;
  if (typeof t !== "string" || !t)
    throw new AzureCredentialsError(`${source} returned no access token`);
  return t;
}

/** Entra ID's error, in its own words: "AADSTS7000215: Invalid client secret provided…". */
function entraError(body: Record<string, unknown>, status: number): string {
  const code = typeof body.error === "string" ? body.error : `HTTP ${status}`;
  const desc =
    typeof body.error_description === "string" ? body.error_description.split(/\r?\n/)[0] : "";
  return desc ? `${code}: ${desc}` : code;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The client assertion for a certificate credential: a JWT signed with the
 * certificate's key, naming the certificate by its SHA-1 thumbprint (x5t), the
 * form Microsoft's identity platform documents.
 */
export function certificateAssertion(args: {
  pem: string;
  password?: string;
  clientId: string;
  audience: string;
  now: number;
}): { assertion: string; thumbprint: string } {
  const certBlock = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(args.pem);
  if (!certBlock) {
    throw new AzureCredentialsError(
      "AZURE_CLIENT_CERTIFICATE_PATH holds no PEM certificate (a PEM with the private key and the certificate is needed; convert a .pfx with openssl first)",
    );
  }
  let key;
  try {
    key = createPrivateKey({ key: args.pem, format: "pem", passphrase: args.password });
  } catch (e) {
    throw new AzureCredentialsError(
      `AZURE_CLIENT_CERTIFICATE_PATH: the private key could not be read (${(e as Error).message})`,
    );
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certBlock[0]);
  } catch (e) {
    throw new AzureCredentialsError(
      `AZURE_CLIENT_CERTIFICATE_PATH: the certificate could not be read (${(e as Error).message})`,
    );
  }
  // A key and certificate that do not belong together would be refused by
  // Entra ID as an unknown key (AADSTS700027); say so here, plainly.
  if (!cert.checkPrivateKey(key)) {
    throw new AzureCredentialsError(
      "AZURE_CLIENT_CERTIFICATE_PATH: the private key does not belong to the certificate",
    );
  }
  const thumbprint = createHash("sha1").update(cert.raw).digest();
  const header = { alg: "RS256", typ: "JWT", x5t: b64url(thumbprint) };
  const iat = Math.floor(args.now / 1000);
  const claims = {
    aud: args.audience,
    iss: args.clientId,
    sub: args.clientId,
    jti: randomUUID(),
    nbf: iat,
    iat,
    exp: iat + 600,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign("RSA-SHA256").update(input).sign(key);
  return { assertion: `${input}.${b64url(sig)}`, thumbprint: thumbprint.toString("hex") };
}

async function fromEntra(
  env: Env,
  source: Exclude<AzureCredentialSource, "managed-identity">,
  scope: string,
  deps: Required<AzureCredentialDeps>,
): Promise<AzureAccessToken> {
  const tenant = v(env, "AZURE_TENANT_ID");
  const clientId = v(env, "AZURE_CLIENT_ID");
  const url = `${authorityHost(env)}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const form: Record<string, string> = {
    grant_type: "client_credentials",
    client_id: clientId,
    scope,
  };
  let identity: string;
  if (source === "client-secret") {
    form.client_secret = v(env, "AZURE_CLIENT_SECRET");
    identity = `service principal ${clientId} in tenant ${tenant} (AZURE_CLIENT_SECRET)`;
  } else if (source === "client-certificate") {
    const path = v(env, "AZURE_CLIENT_CERTIFICATE_PATH");
    let pem: string;
    try {
      pem = deps.readFile(path); // read every time: a renewed certificate is picked up
    } catch (e) {
      throw new AzureCredentialsError(
        `Could not read AZURE_CLIENT_CERTIFICATE_PATH (${path}): ${(e as Error).message}`,
      );
    }
    const { assertion, thumbprint } = certificateAssertion({
      pem,
      password: v(env, "AZURE_CLIENT_CERTIFICATE_PASSWORD") || undefined,
      clientId,
      audience: url,
      now: deps.now(),
    });
    form.client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    form.client_assertion = assertion;
    identity = `service principal ${clientId} in tenant ${tenant} (certificate ${thumbprint.slice(0, 8)}…)`;
  } else {
    const path = v(env, "AZURE_FEDERATED_TOKEN_FILE");
    let token: string;
    try {
      // Read on every exchange: the kubelet rotates the projected token.
      token = deps.readFile(path).trim();
    } catch (e) {
      throw new AzureCredentialsError(
        `Could not read AZURE_FEDERATED_TOKEN_FILE (${path}): ${(e as Error).message}`,
      );
    }
    if (!token) throw new AzureCredentialsError(`AZURE_FEDERATED_TOKEN_FILE (${path}) is empty`);
    form.client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    form.client_assertion = token;
    identity = `workload identity ${clientId} in tenant ${tenant}`;
  }
  let res: Response;
  try {
    res = await deps.tokenFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof SsrfRefusedError) throw e;
    throw new AzureCredentialsError(
      `Microsoft Entra ID at ${new URL(url).host} could not be reached: ${(e as Error).message}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AzureCredentialsError(
      `Microsoft Entra ID refused a token for ${identity}: ${entraError(body, res.status)}`,
    );
  }
  const what = "Microsoft Entra ID";
  return {
    token: tokenFrom(body, what),
    expiresAt: expiryOf(body, deps.now(), what),
    source,
    identity,
  };
}

async function fromManagedIdentity(
  env: Env,
  scope: string,
  deps: Required<AzureCredentialDeps>,
): Promise<AzureAccessToken> {
  const { kind, url } = managedIdentityEndpoint(env);
  // The managed identity endpoints take a resource, not a scope.
  const resource = scope.replace(/\/\.default$/, "");
  const clientId = v(env, "AZURE_CLIENT_ID");
  const q = new URLSearchParams(
    kind === "app-service"
      ? { "api-version": "2019-08-01", resource }
      : { "api-version": "2018-02-01", resource },
  );
  if (clientId) q.set("client_id", clientId);
  const headers: Record<string, string> =
    kind === "app-service"
      ? { "x-identity-header": v(env, "IDENTITY_HEADER") }
      : { metadata: "true" };
  if (/[\r\n]/.test(headers["x-identity-header"] ?? "")) {
    throw new AzureCredentialsError("IDENTITY_HEADER contains a line break");
  }
  const target = `${url}${url.includes("?") ? "&" : "?"}${q.toString()}`;
  const where =
    kind === "app-service" ? "The App Service identity endpoint" : "The instance metadata service";
  let res: Response;
  try {
    res = await deps.metadataFetch(target, { method: "GET", headers });
  } catch (e) {
    throw new AzureCredentialsError(
      `No Azure credentials: no AZURE_CLIENT_SECRET, certificate or federated token is set, and ` +
        `${where.toLowerCase()} (${new URL(url).host}) did not answer (${(e as Error).message}). ` +
        `Run with a managed identity or workload identity, or set the AZURE_* variables.`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AzureCredentialsError(
      `${where} gave no token for ${clientId ? `the user-assigned identity ${clientId}` : "the managed identity"}: ${entraError(body, res.status)}`,
    );
  }
  return {
    token: tokenFrom(body, where),
    expiresAt: expiryOf(body, deps.now(), where),
    source: "managed-identity",
    identity: clientId
      ? `user-assigned managed identity ${clientId}`
      : `managed identity (${kind === "app-service" ? "App Service" : "instance metadata"})`,
  };
}

export type AzureCredentialChain = {
  readonly source: AzureCredentialSource;
  /** Cached until five minutes before it expires; concurrent callers share one fetch. */
  get(): Promise<AzureAccessToken>;
};

/** A token source for one Entra ID scope, e.g. https://vault.azure.net/.default. */
export function createAzureCredentialChain(
  args: { scope: string; env?: Env } & AzureCredentialDeps,
): AzureCredentialChain {
  const env = args.env ?? process.env;
  const deps: Required<AzureCredentialDeps> = {
    tokenFetch: args.tokenFetch ?? ((url, init) => fetch(url, init)),
    metadataFetch: args.metadataFetch ?? defaultMetadataFetch,
    readFile: args.readFile ?? ((p) => readFileSync(p, "utf8")),
    now: args.now ?? Date.now,
  };
  const source = azureCredentialSource(env);
  let cached: AzureAccessToken | null = null;
  let inflight: Promise<AzureAccessToken> | null = null;

  const load = () =>
    source === "managed-identity"
      ? fromManagedIdentity(env, args.scope, deps)
      : fromEntra(env, source, args.scope, deps);

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
