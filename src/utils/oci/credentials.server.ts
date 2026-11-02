// The app's own Oracle Cloud identity: the key it signs a request with when it
// calls OCI as itself (OCI Vault today). Never for a connection a user
// configures — those carry their own API keys (providers/adapters/oci).
//
// Three sources, chosen once; OCI_AUTH names one, otherwise the first that is
// configured, in this order:
//
//   api_key             OCI_CONFIG_FILE: the file `oci setup config` writes,
//                       its OCI_CONFIG_PROFILE (DEFAULT): a user, the API key's
//                       fingerprint, its key_file (pass_phrase if encrypted),
//                       the tenancy. The key is checked against the fingerprint.
//   resource_principal  OCI_RESOURCE_PRINCIPAL_VERSION=2.2: a session token
//                       (OCI_RESOURCE_PRINCIPAL_RPST) and its private key
//                       (…_PRIVATE_PEM), each the value or a file's path, as
//                       OCI Functions and Container Instances provide them.
//   instance_principal  the instance metadata service: the instance's
//                       certificate, its key and the intermediate certificate,
//                       exchanged at the region's identity service
//                       (auth.<region>.<realm domain>/v1/x509) for a session
//                       token bound to a key pair made here. OCI_METADATA_BASE_URL
//                       and OCI_FEDERATION_ENDPOINT move them.
//
// A chosen source that fails is the error: falling through to another would
// act as an identity the operator did not choose. OKE workload identity and
// session tokens from `oci session authenticate` are refused by name.
//
// The metadata service is a link-local address the SSRF guard refuses for
// every other caller: reached here at a fixed URL or one the operator set,
// directly, never through the proxy, never following a redirect. The
// federation call goes through the caller's fetch (the proxy and the SSRF
// guard) and is not held to KMS_REQUIRE_PRIVATE: it carries the instance's
// certificate, never key material.
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { Agent } from "undici";

import { ociKeyFingerprint, signOciRequest, type OciSigningKey } from "./signer";

export type OciAuthSource = "api_key" | "instance_principal" | "resource_principal";

export type OciCredential = {
  key: OciSigningKey;
  source: OciAuthSource;
  /** Who the app is, for the settings card: never a secret. */
  identity: string;
  /** Epoch ms when a session token expires; null for an API key. */
  expiresAt: number | null;
};

export class OciCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OciCredentialsError";
  }
}

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type OciCredentialDeps = {
  /** The identity service's federation call: the caller's guarded fetch. */
  tokenFetch?: Fetch;
  /** The instance metadata service: direct. */
  metadataFetch?: Fetch;
  readFile?: (path: string) => string;
  now?: () => number;
  /** The session key pair an instance principal's token is bound to. Tests replace it. */
  sessionKey?: () => { privateKey: KeyObject; publicKey: KeyObject };
};

type Deps = Required<OciCredentialDeps>;

/** Refresh this long before a session token expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** An API key does not expire; its file is read again this often, so a replaced key is used. */
const REREAD_MS = 15 * 60 * 1000;
const METADATA_TIMEOUT_MS = 2000;
const TOKEN_TIMEOUT_MS = 10_000;
const METADATA = "http://169.254.169.254/opc/v2";

const SOURCES: readonly OciAuthSource[] = ["api_key", "instance_principal", "resource_principal"];
const REFUSED: Record<string, string> = {
  oke_workload_identity:
    "OKE workload identity is not supported by this release; on OKE use the node pool's instance principal (OCI_AUTH=instance_principal) or an API key",
  security_token:
    "a session token from `oci session authenticate` expires within the hour and cannot be refreshed by a server; use an API key or a principal",
  instance_obo_user: "acting for a user through an instance is not supported; use an API key",
};

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

/** Which source the environment names. Throws, naming the variable, on one it cannot use. */
export function ociAuthSource(env: Env = process.env): OciAuthSource {
  const raw = v(env, "OCI_AUTH").toLowerCase().replace(/-/g, "_");
  if (raw) {
    if ((SOURCES as readonly string[]).includes(raw)) return raw as OciAuthSource;
    throw new OciCredentialsError(
      REFUSED[raw]
        ? `OCI_AUTH=${raw}: ${REFUSED[raw]}`
        : `OCI_AUTH must be api_key, instance_principal or resource_principal, not ${raw}`,
    );
  }
  if (v(env, "OCI_CONFIG_FILE")) return "api_key";
  if (v(env, "OCI_RESOURCE_PRINCIPAL_VERSION")) return "resource_principal";
  return "instance_principal";
}

/**
 * One profile of an OCI config file. Keys in DEFAULT apply to every profile
 * unless the profile sets them, as the CLI and the SDKs read the file.
 */
export function parseOciConfig(text: string, profile: string): Record<string, string> | null {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) continue;
    const head = /^\[([^\]]+)\]$/.exec(t);
    if (head) {
      current = sections.get(head[1].trim()) ?? {};
      sections.set(head[1].trim(), current);
      continue;
    }
    const eq = t.indexOf("=");
    if (eq > 0 && current) current[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  const own = sections.get(profile);
  if (!own) return null;
  return profile === "DEFAULT" ? { ...own } : { ...(sections.get("DEFAULT") ?? {}), ...own };
}

function readKey(pem: string, passphrase: string | undefined, what: string): KeyObject {
  // PKCS#8 says "ENCRYPTED PRIVATE KEY", PKCS#1 "Proc-Type: 4,ENCRYPTED". Read
  // from the PEM, not from OpenSSL's error, which for a missing pass phrase is
  // "interrupted or cancelled".
  const encrypted = /ENCRYPTED/.test(pem);
  if (encrypted && !passphrase) {
    throw new OciCredentialsError(`${what} is encrypted: give its pass phrase`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem", ...(passphrase ? { passphrase } : {}) });
  } catch (e) {
    throw new OciCredentialsError(
      encrypted
        ? `${what} could not be decrypted with the pass phrase given`
        : `${what} is not a PEM private key (${(e as Error).message})`,
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new OciCredentialsError(`${what} is not an RSA key; OCI signs with RSA`);
  }
  return key;
}

function fromApiKey(env: Env, deps: Deps): OciCredential {
  const path = v(env, "OCI_CONFIG_FILE");
  if (!path) {
    throw new OciCredentialsError(
      "OCI_AUTH=api_key needs OCI_CONFIG_FILE: the config file `oci setup config` writes, mounted into the container",
    );
  }
  const profile = v(env, "OCI_CONFIG_PROFILE") || "DEFAULT";
  let text: string;
  try {
    text = deps.readFile(path);
  } catch (e) {
    throw new OciCredentialsError(
      `OCI_CONFIG_FILE (${path}) could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
    );
  }
  const p = parseOciConfig(text, profile);
  if (!p) throw new OciCredentialsError(`OCI_CONFIG_FILE (${path}) has no [${profile}] profile`);
  const missing = ["user", "fingerprint", "key_file", "tenancy"].filter((k) => !p[k]);
  if (missing.length) {
    throw new OciCredentialsError(
      `The [${profile}] profile in ${path} has no ${missing.join(", ")}: an API key needs the user, its fingerprint, key_file and the tenancy`,
    );
  }
  if (
    !/^ocid1\.user\.[a-z0-9.-]+$/.test(p.user) ||
    !/^ocid1\.tenancy\.[a-z0-9.-]+$/.test(p.tenancy)
  ) {
    throw new OciCredentialsError(
      `The [${profile}] profile's user must be a user OCID and its tenancy a tenancy OCID`,
    );
  }
  const fingerprint = p.fingerprint.toLowerCase();
  if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){15}$/.test(fingerprint)) {
    throw new OciCredentialsError(
      `The [${profile}] profile's fingerprint is not an API key fingerprint (16 hex pairs separated by colons)`,
    );
  }
  const raw = p.key_file.startsWith("~") ? homedir() + p.key_file.slice(1) : p.key_file;
  const keyPath = isAbsolute(raw) ? raw : resolve(dirname(path), raw);
  let pem: string;
  try {
    pem = deps.readFile(keyPath);
  } catch (e) {
    throw new OciCredentialsError(
      `The [${profile}] profile's key_file (${keyPath}) could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
    );
  }
  const privateKey = readKey(pem, p.pass_phrase, `key_file ${keyPath}`);
  // OCI would refuse the signature with a bare NotAuthenticated: say which half is wrong.
  const actual = ociKeyFingerprint(privateKey);
  if (actual !== fingerprint) {
    throw new OciCredentialsError(
      `key_file ${keyPath} is the API key ${actual}, but the [${profile}] profile names ${fingerprint}: they must be the same key`,
    );
  }
  return {
    key: { keyId: `${p.tenancy}/${p.user}/${fingerprint}`, privateKey },
    source: "api_key",
    identity: `user ${p.user} (API key ${fingerprint})`,
    expiresAt: null,
  };
}

/** A JWT's claims, unverified: for its expiry and the card, never for a decision. */
function claims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function expiry(token: string, now: number): number {
  const exp = claims(token).exp;
  // A token whose expiry cannot be read is used for a short while, then fetched again.
  return typeof exp === "number" && exp > 0 ? exp * 1000 : now + REFRESH_MARGIN_MS * 2;
}

/** An environment value, or the file it names (an absolute path). Read on every refresh. */
function valueOrFile(env: Env, name: string, deps: Deps): string {
  const raw = v(env, name);
  if (!raw.startsWith("/")) return raw;
  try {
    return deps.readFile(raw).trim();
  } catch (e) {
    throw new OciCredentialsError(
      `${name} names ${raw}, which could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
    );
  }
}

function fromResourcePrincipal(env: Env, deps: Deps): OciCredential {
  const version = v(env, "OCI_RESOURCE_PRINCIPAL_VERSION");
  if (version !== "2.2") {
    throw new OciCredentialsError(
      `OCI_RESOURCE_PRINCIPAL_VERSION=${version || "(unset)"} is not supported: this release reads version 2.2, a session token and its private key`,
    );
  }
  const token = valueOrFile(env, "OCI_RESOURCE_PRINCIPAL_RPST", deps);
  const pem = valueOrFile(env, "OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM", deps);
  const missing = [
    !token && "OCI_RESOURCE_PRINCIPAL_RPST",
    !pem && "OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM",
  ].filter(Boolean);
  if (missing.length) {
    throw new OciCredentialsError(`A resource principal needs ${missing.join(" and ")}`);
  }
  const passphrase = valueOrFile(env, "OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PASSPHRASE", deps);
  const privateKey = readKey(pem, passphrase || undefined, "OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM");
  const c = claims(token);
  const who = [c.res_type, c.res_id ?? c.sub].filter((x) => typeof x === "string").join(" ");
  return {
    key: { keyId: `ST$${token}`, privateKey },
    source: "resource_principal",
    identity: `resource principal${who ? ` ${who}` : ""}`,
    expiresAt: expiry(token, deps.now()),
  };
}

/** OCI_METADATA_BASE_URL, else http://169.254.169.254/opc/v2. */
export function metadataBase(env: Env = process.env): string {
  const raw = v(env, "OCI_METADATA_BASE_URL");
  if (!raw) return METADATA;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OciCredentialsError(`OCI_METADATA_BASE_URL "${raw}" is not a URL`);
  }
  if (u.protocol !== "http:" || u.username || u.password || u.search || u.hash) {
    throw new OciCredentialsError(
      `OCI_METADATA_BASE_URL must be an http URL with no credentials or query, not ${raw}`,
    );
  }
  return u.toString().replace(/\/+$/, "");
}

/** OCI_FEDERATION_ENDPOINT: an https origin. */
function federationOverride(env: Env): string | null {
  const raw = v(env, "OCI_FEDERATION_ENDPOINT");
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OciCredentialsError(`OCI_FEDERATION_ENDPOINT "${raw}" is not a URL`);
  }
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname && u.pathname !== "/")
  ) {
    throw new OciCredentialsError(
      `OCI_FEDERATION_ENDPOINT must be an origin only (scheme, host, port): ${raw}`,
    );
  }
  return u.origin;
}

/** A PEM body as the identity service takes it: no header, footer or line breaks. */
const bare = (pem: string) => pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");

async function fromInstancePrincipal(env: Env, deps: Deps): Promise<OciCredential> {
  const base = metadataBase(env);
  const federation = federationOverride(env);
  async function imds(path: string): Promise<string> {
    let res: Response;
    try {
      res = await deps.metadataFetch(`${base}${path}`, {
        method: "GET",
        headers: { authorization: "Bearer Oracle" },
      });
    } catch (e) {
      throw new OciCredentialsError(
        `No OCI identity: OCI_CONFIG_FILE is not set, and the instance metadata service ` +
          `(${new URL(base).host}) did not answer (${(e as Error).message}). Run on an OCI ` +
          `instance in a dynamic group, set OCI_RESOURCE_PRINCIPAL_VERSION where OCI provides ` +
          `a resource principal, or point OCI_CONFIG_FILE at an API key's config.`,
      );
    }
    if (!res.ok) {
      throw new OciCredentialsError(
        `The instance metadata service answered ${path} with HTTP ${res.status}`,
      );
    }
    return res.text();
  }

  let origin = federation;
  if (!origin) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(await imds("/instance/")) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof OciCredentialsError) throw e;
      throw new OciCredentialsError("The instance metadata service's /instance/ is not JSON");
    }
    const info = (doc.regionInfo ?? {}) as Record<string, unknown>;
    const region = typeof info.regionIdentifier === "string" ? info.regionIdentifier : "";
    const domain = typeof info.realmDomainComponent === "string" ? info.realmDomainComponent : "";
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(region) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) {
      throw new OciCredentialsError(
        "The instance metadata gives no usable region and realm (regionInfo); set OCI_FEDERATION_ENDPOINT to the region's identity service, https://auth.<region>.<realm domain>",
      );
    }
    origin = `https://auth.${region}.${domain}`;
  }

  const certPem = await imds("/identity/cert.pem");
  const keyPem = await imds("/identity/key.pem");
  const intermediatePem = await imds("/identity/intermediate.pem");
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(certPem);
  } catch {
    throw new OciCredentialsError(
      "The instance's certificate from the metadata service is not a certificate",
    );
  }
  const tenancy = /opc-tenant:(ocid1\.tenancy\.[a-z0-9.-]+)/.exec(leaf.subject)?.[1];
  if (!tenancy) {
    throw new OciCredentialsError(
      "The instance's certificate names no tenancy (opc-tenant:…); it is not an OCI instance certificate",
    );
  }
  const instance = /opc-instance:(ocid1\.instance\.[a-z0-9.-]+)/.exec(leaf.subject)?.[1];
  const leafKey = readKey(keyPem, undefined, "The instance's private key");
  const fingerprint = createHash("sha256").update(leaf.raw).digest("hex").match(/../g)!.join(":");
  const session = deps.sessionKey();
  const body = JSON.stringify({
    certificate: bare(certPem),
    publicKey: bare(session.publicKey.export({ type: "spki", format: "pem" }).toString()),
    intermediateCertificates: [bare(intermediatePem)],
    fingerprintAlgorithm: "SHA256",
  });
  const url = `${origin}/v1/x509`;
  const headers = signOciRequest({
    method: "POST",
    url,
    body,
    key: { keyId: `${tenancy}/fed-x509-sha256/${fingerprint}`, privateKey: leafKey },
  });
  let res: Response;
  try {
    res = await deps.tokenFetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new OciCredentialsError(
      `The identity service ${new URL(origin).host} could not be reached for an instance principal token (${cause?.code ?? cause?.message ?? (e as Error).message})`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const token = typeof json.token === "string" ? json.token : "";
  if (!res.ok || !token) {
    const why =
      typeof json.message === "string" ? json.message : res.ok ? "no token" : `HTTP ${res.status}`;
    throw new OciCredentialsError(
      `The identity service refused the instance's certificate (${res.status}${typeof json.code === "string" ? ` ${json.code}` : ""}): ${why}`,
    );
  }
  return {
    key: { keyId: `ST$${token}`, privateKey: session.privateKey },
    source: "instance_principal",
    identity: `instance principal ${instance ?? `in ${tenancy}`}`,
    expiresAt: expiry(token, deps.now()),
  };
}

export type OciCredentialChain = {
  readonly source: OciAuthSource;
  /** Cached until five minutes before a token expires; concurrent callers share one fetch. */
  get(): Promise<OciCredential>;
};

export function createOciCredentialChain(
  args: { env?: Env } & OciCredentialDeps = {},
): OciCredentialChain {
  const env = args.env ?? process.env;
  const deps: Deps = {
    tokenFetch: args.tokenFetch ?? ((url, init) => fetch(url, init)),
    metadataFetch: args.metadataFetch ?? defaultMetadataFetch,
    readFile: args.readFile ?? ((p) => readFileSync(p, "utf8")),
    now: args.now ?? Date.now,
    sessionKey: args.sessionKey ?? (() => generateKeyPairSync("rsa", { modulusLength: 2048 })),
  };
  const source = ociAuthSource(env);
  let cached: { cred: OciCredential; until: number } | null = null;
  let inflight: Promise<OciCredential> | null = null;

  async function load(): Promise<OciCredential> {
    if (source === "api_key") return fromApiKey(env, deps);
    if (source === "resource_principal") return fromResourcePrincipal(env, deps);
    return fromInstancePrincipal(env, deps);
  }

  return {
    source,
    get() {
      if (cached && cached.until > deps.now()) return Promise.resolve(cached.cred);
      if (inflight) return inflight;
      inflight = load()
        .then((cred) => {
          const until =
            cred.expiresAt === null ? deps.now() + REREAD_MS : cred.expiresAt - REFRESH_MARGIN_MS;
          cached = { cred, until };
          return cred;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
