// The app's own AWS identity: the credentials it signs with when it calls AWS
// as itself (AWS KMS today). Never for a connection a user configures — those
// carry their own keys.
//
// The chain, in the order the AWS SDKs use. The FIRST source whose variables
// are present is the source; if it fails, that is the error. Falling through
// to another identity would sign as a role the operator did not choose.
//
//   1. env              AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN)
//   2. web identity     AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN — EKS IRSA,
//                       or any OIDC federation — exchanged at STS
//                       (AssumeRoleWithWebIdentity, an unsigned call)
//   3. container        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (ECS task role)
//                       or AWS_CONTAINER_CREDENTIALS_FULL_URI (EKS Pod Identity)
//   4. instance profile EC2 instance metadata, IMDSv2 only, unless
//                       AWS_EC2_METADATA_DISABLED=true
//
// The metadata endpoints (3 and 4) are link-local addresses the SSRF guard
// refuses for every other caller, and rightly. They are reached here only at
// fixed URLs, or ones the operator set in the environment, through a direct
// connection that never uses the proxy and never follows a redirect. STS is
// an ordinary AWS endpoint and goes the way the KMS calls go (the caller's
// fetch: proxy, SSRF guard, private-path rule).
import { readFileSync } from "node:fs";

import { Agent } from "undici";

import { SsrfRefusedError } from "@/utils/ssrfGuard.server";

import type { AwsCredentials } from "./sigv4";

export type AwsCredentialSource = "env" | "web-identity" | "container" | "instance-metadata";

export type ResolvedAwsCredentials = AwsCredentials & {
  source: AwsCredentialSource;
  /** Epoch ms, or null for keys that do not expire. */
  expiresAt: number | null;
  /** Who the app is, for the settings card: never a secret. */
  identity: string;
};

export class AwsCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsCredentialsError";
  }
}

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type AwsCredentialDeps = {
  /** STS: the caller's guarded fetch. */
  stsFetch?: Fetch;
  /** Metadata endpoints: direct, no proxy. Tests replace it. */
  metadataFetch?: Fetch;
  readFile?: (path: string) => string;
  now?: () => number;
};

/** Refresh this long before credentials expire. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const METADATA_TIMEOUT_MS = 1000;
const STS_TIMEOUT_MS = 10_000;

const ECS_HOST = "169.254.170.2";
const IMDS_V4 = "http://169.254.169.254";
const IMDS_V6 = "http://[fd00:ec2::254]";

// One direct agent for the metadata endpoints: no proxy can be put in front of
// it by the environment (NODE_USE_ENV_PROXY, a global dispatcher).
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

/** Which source the environment selects, without calling anything. */
export function awsCredentialSource(env: Env = process.env): AwsCredentialSource {
  const keyId = v(env, "AWS_ACCESS_KEY_ID");
  const secret = v(env, "AWS_SECRET_ACCESS_KEY");
  if (keyId || secret) {
    if (!keyId || !secret) {
      throw new AwsCredentialsError(
        `${keyId ? "AWS_ACCESS_KEY_ID" : "AWS_SECRET_ACCESS_KEY"} is set without ` +
          `${keyId ? "AWS_SECRET_ACCESS_KEY" : "AWS_ACCESS_KEY_ID"}; set both, or neither to use a role`,
      );
    }
    return "env";
  }
  const tokenFile = v(env, "AWS_WEB_IDENTITY_TOKEN_FILE");
  const roleArn = v(env, "AWS_ROLE_ARN");
  if (tokenFile || roleArn) {
    if (!tokenFile || !roleArn) {
      throw new AwsCredentialsError(
        `${tokenFile ? "AWS_WEB_IDENTITY_TOKEN_FILE" : "AWS_ROLE_ARN"} is set without ` +
          `${tokenFile ? "AWS_ROLE_ARN" : "AWS_WEB_IDENTITY_TOKEN_FILE"}; web identity needs both`,
      );
    }
    return "web-identity";
  }
  if (
    v(env, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
    v(env, "AWS_CONTAINER_CREDENTIALS_FULL_URI")
  ) {
    return "container";
  }
  return "instance-metadata";
}

/** An access key id shown without most of it: AKIA…WXYZ. */
function maskKeyId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…";
}

function expiry(raw: unknown, source: string): number {
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) throw new AwsCredentialsError(`${source} returned no valid Expiration`);
  return t;
}

function need(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || !value) {
    throw new AwsCredentialsError(`${source} returned no ${field}`);
  }
  return value;
}

// ── 2. Web identity ──────────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** One element's text from STS's fixed-shape XML answer. */
export function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  if (!m) return null;
  return m[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]);
}

/** The STS endpoint: the operator's override, else the regional one. */
export function stsEndpoint(region: string, env: Env = process.env): string {
  const override = v(env, "AWS_ENDPOINT_URL_STS") || v(env, "AWS_ENDPOINT_URL");
  if (override) return override.replace(/\/+$/, "") + "/";
  const domain = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://sts.${region}.${domain}/`;
}

const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

async function fromWebIdentity(
  env: Env,
  region: string,
  deps: Required<AwsCredentialDeps>,
): Promise<ResolvedAwsCredentials> {
  const roleArn = v(env, "AWS_ROLE_ARN");
  const tokenFile = v(env, "AWS_WEB_IDENTITY_TOKEN_FILE");
  const sessionName = v(env, "AWS_ROLE_SESSION_NAME") || "agentswarms-kms";
  if (!SESSION_NAME.test(sessionName)) {
    throw new AwsCredentialsError(
      `AWS_ROLE_SESSION_NAME "${sessionName}" is not a session name (2–64 of letters, digits and +=,.@_-)`,
    );
  }
  let token: string;
  try {
    // Read on every exchange: the kubelet rotates the projected token.
    token = deps.readFile(tokenFile).trim();
  } catch (e) {
    throw new AwsCredentialsError(
      `Could not read AWS_WEB_IDENTITY_TOKEN_FILE (${tokenFile}): ${(e as Error).message}`,
    );
  }
  if (!token) throw new AwsCredentialsError(`AWS_WEB_IDENTITY_TOKEN_FILE (${tokenFile}) is empty`);
  const url = stsEndpoint(region, env);
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    WebIdentityToken: token,
  }).toString();
  let res: Response;
  try {
    res = await deps.stsFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body,
      signal: AbortSignal.timeout(STS_TIMEOUT_MS),
    });
  } catch (e) {
    // A refusal (the SSRF guard, the private-path rule) sent nothing: it reads alone.
    if (e instanceof SsrfRefusedError) throw e;
    throw new AwsCredentialsError(`STS at ${url} could not be reached: ${(e as Error).message}`);
  }
  const xml = await res.text().catch(() => "");
  if (!res.ok) {
    const code = xmlText(xml, "Code") ?? `HTTP ${res.status}`;
    const message = xmlText(xml, "Message") ?? "no detail";
    throw new AwsCredentialsError(
      `STS refused AssumeRoleWithWebIdentity for ${roleArn}: ${code}: ${message}`,
    );
  }
  const source = "STS AssumeRoleWithWebIdentity";
  return {
    accessKeyId: need(xmlText(xml, "AccessKeyId"), "AccessKeyId", source),
    secretAccessKey: need(xmlText(xml, "SecretAccessKey"), "SecretAccessKey", source),
    sessionToken: need(xmlText(xml, "SessionToken"), "SessionToken", source),
    expiresAt: expiry(xmlText(xml, "Expiration"), source),
    source: "web-identity",
    identity: `role ${roleArn} (web identity)`,
  };
}

// ── 3. Container credentials ─────────────────────────────────────────────────

// The SDKs' rule for an http FULL_URI: only the loopback and the ECS / EKS
// Pod Identity agent addresses. Anything else must be https.
function containerHostAllowed(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    h === "::1" ||
    h === ECS_HOST ||
    h === "169.254.170.23" ||
    h === "fd00:ec2::23"
  );
}

/** The container credentials URL the environment names, checked. */
export function containerCredentialsUrl(env: Env = process.env): string {
  const rel = v(env, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI");
  if (rel) {
    if (!rel.startsWith("/")) {
      throw new AwsCredentialsError("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must start with /");
    }
    return `http://${ECS_HOST}${rel}`;
  }
  const full = v(env, "AWS_CONTAINER_CREDENTIALS_FULL_URI");
  let u: URL;
  try {
    u = new URL(full);
  } catch {
    throw new AwsCredentialsError(`AWS_CONTAINER_CREDENTIALS_FULL_URI "${full}" is not a URL`);
  }
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && containerHostAllowed(u.hostname)) return u.toString();
  throw new AwsCredentialsError(
    `AWS_CONTAINER_CREDENTIALS_FULL_URI must be https, or http to the loopback or the ECS / EKS ` +
      `Pod Identity agent address, not ${u.protocol}//${u.host}`,
  );
}

async function fromContainer(
  env: Env,
  deps: Required<AwsCredentialDeps>,
): Promise<ResolvedAwsCredentials> {
  const url = containerCredentialsUrl(env);
  const headers: Record<string, string> = { accept: "application/json" };
  const tokenFile = v(env, "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE");
  let auth = v(env, "AWS_CONTAINER_AUTHORIZATION_TOKEN");
  if (tokenFile) {
    try {
      auth = deps.readFile(tokenFile).trim(); // rotated by the agent: read every time
    } catch (e) {
      throw new AwsCredentialsError(
        `Could not read AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE (${tokenFile}): ${(e as Error).message}`,
      );
    }
  }
  if (auth) {
    if (/[\r\n]/.test(auth)) {
      throw new AwsCredentialsError("The container authorization token contains a line break");
    }
    headers.authorization = auth;
  }
  let res: Response;
  try {
    res = await deps.metadataFetch(url, { method: "GET", headers });
  } catch (e) {
    throw new AwsCredentialsError(
      `The container credentials endpoint ${new URL(url).host} did not answer: ${(e as Error).message}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const why = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    throw new AwsCredentialsError(`The container credentials endpoint refused: ${why}`);
  }
  const source = "The container credentials endpoint";
  const roleArn = typeof body.RoleArn === "string" ? body.RoleArn : null;
  return {
    accessKeyId: need(body.AccessKeyId, "AccessKeyId", source),
    secretAccessKey: need(body.SecretAccessKey, "SecretAccessKey", source),
    sessionToken: need(body.Token, "Token", source),
    expiresAt: expiry(body.Expiration, source),
    source: "container",
    identity: roleArn ? `role ${roleArn} (container credentials)` : "container credentials",
  };
}

// ── 4. Instance metadata (IMDSv2) ────────────────────────────────────────────

export function imdsEndpoint(env: Env = process.env): string {
  const set = v(env, "AWS_EC2_METADATA_SERVICE_ENDPOINT");
  if (set) return set.replace(/\/+$/, "");
  return v(env, "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE").toLowerCase() === "ipv6"
    ? IMDS_V6
    : IMDS_V4;
}

const ROLE_NAME = /^[\w+=,.@-]{1,128}$/;

async function fromInstanceMetadata(
  env: Env,
  deps: Required<AwsCredentialDeps>,
): Promise<ResolvedAwsCredentials> {
  const noCredentials =
    "No AWS credentials: no AWS_ACCESS_KEY_ID, web identity or container credentials are set";
  if (v(env, "AWS_EC2_METADATA_DISABLED").toLowerCase() === "true") {
    throw new AwsCredentialsError(
      `${noCredentials}, and AWS_EC2_METADATA_DISABLED rules out an instance profile.`,
    );
  }
  const base = imdsEndpoint(env);
  // IMDSv2 only: a session token first. No fall-back to v1, whose plain GETs
  // are what an SSRF against the instance reaches.
  let token: string;
  try {
    const res = await deps.metadataFetch(`${base}/latest/api/token`, {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    token = (await res.text()).trim();
    if (!token) throw new Error("an empty token");
  } catch (e) {
    throw new AwsCredentialsError(
      `${noCredentials}, and the instance metadata service (${base}) gave no IMDSv2 token ` +
        `(${(e as Error).message}). Run with a role (IRSA, an ECS task role, an instance profile) ` +
        `or set the AWS_* variables.`,
    );
  }
  const headers = { "x-aws-ec2-metadata-token": token };
  const list = await deps.metadataFetch(`${base}/latest/meta-data/iam/security-credentials/`, {
    method: "GET",
    headers,
  });
  const role = list.ok ? (await list.text()).split("\n")[0]?.trim() : "";
  if (!role || !ROLE_NAME.test(role)) {
    throw new AwsCredentialsError(
      `The instance metadata service answered, but this instance has no instance profile role (HTTP ${list.status})`,
    );
  }
  const res = await deps.metadataFetch(
    `${base}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
    { method: "GET", headers },
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const source = `The instance profile role ${role}`;
  if (!res.ok || (typeof body.Code === "string" && body.Code !== "Success")) {
    throw new AwsCredentialsError(
      `${source} returned no credentials: ${typeof body.Code === "string" ? body.Code : `HTTP ${res.status}`}`,
    );
  }
  return {
    accessKeyId: need(body.AccessKeyId, "AccessKeyId", source),
    secretAccessKey: need(body.SecretAccessKey, "SecretAccessKey", source),
    sessionToken: need(body.Token, "Token", source),
    expiresAt: expiry(body.Expiration, source),
    source: "instance-metadata",
    identity: `instance profile role ${role}`,
  };
}

// ── The chain ────────────────────────────────────────────────────────────────

export type AwsCredentialChain = {
  readonly source: AwsCredentialSource;
  /** Cached until five minutes before they expire; concurrent callers share one fetch. */
  get(): Promise<ResolvedAwsCredentials>;
};

export function createAwsCredentialChain(
  args: { region: string; env?: Env } & AwsCredentialDeps,
): AwsCredentialChain {
  const env = args.env ?? process.env;
  const deps: Required<AwsCredentialDeps> = {
    stsFetch: args.stsFetch ?? ((url, init) => fetch(url, init)),
    metadataFetch: args.metadataFetch ?? defaultMetadataFetch,
    readFile: args.readFile ?? ((p) => readFileSync(p, "utf8")),
    now: args.now ?? Date.now,
  };
  const source = awsCredentialSource(env);
  let cached: ResolvedAwsCredentials | null = null;
  let inflight: Promise<ResolvedAwsCredentials> | null = null;

  function load(): Promise<ResolvedAwsCredentials> {
    switch (source) {
      case "env": {
        const accessKeyId = v(env, "AWS_ACCESS_KEY_ID");
        const sessionToken = v(env, "AWS_SESSION_TOKEN") || undefined;
        return Promise.resolve({
          accessKeyId,
          secretAccessKey: v(env, "AWS_SECRET_ACCESS_KEY"),
          ...(sessionToken ? { sessionToken } : {}),
          expiresAt: null,
          source,
          identity: `access key ${maskKeyId(accessKeyId)} (AWS_ACCESS_KEY_ID)`,
        });
      }
      case "web-identity":
        return fromWebIdentity(env, args.region, deps);
      case "container":
        return fromContainer(env, deps);
      case "instance-metadata":
        return fromInstanceMetadata(env, deps);
    }
  }

  return {
    source,
    get() {
      if (
        cached &&
        (cached.expiresAt === null || cached.expiresAt - REFRESH_MARGIN_MS > deps.now())
      ) {
        return Promise.resolve(cached);
      }
      if (inflight) return inflight;
      inflight = load()
        .then((c) => (cached = c))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
