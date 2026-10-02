// Short-lived object-store credentials limited to named prefixes.
//
// The Spark cluster is the one place that still needs storage credentials of
// its own: executors write and read files directly, so there is no app in the
// middle the way there is for a sandbox (sandboxLake.server). What it can get
// instead of the lake's own keys is a credential that expires and that the
// store itself will only honour for the files one run needs.
//
// This is STS AssumeRole with a session policy — the same call on AWS and on
// MinIO. The store enforces the policy, so a cluster holding the credential
// cannot widen it, and nothing on the cluster has to be trusted to respect a
// prefix. Verified against this deployment's MinIO: a session scoped to one
// prefix read inside it and was refused outside it.
//
// Not every object store has STS (R2 and GCS's S3 endpoint do not), so a
// deployment without it keeps the engine's credentials and says so once per
// process. `LAKEHOUSE_STS_REQUIRED=true` turns that into a refusal instead.
import { createHash } from "node:crypto";

import { signS3Request } from "@/utils/catalog/objectStore.server";
import { type S3Target } from "@/utils/lakehouse/presign.server";

export type ScopedCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO 8601, as the store reported it. */
  expiresAt: string;
};

/** What a scoped credential may touch. Prefixes are keys, no leading slash. */
export type Scope = {
  /** Read these prefixes. */
  read?: string[];
  /** Read, write and delete under these prefixes. */
  write?: string[];
};

const READ_ACTIONS = ["s3:GetObject"];
// Hadoop's S3A writes through multipart uploads and removes its own markers
// and failed parts, so a write scope that cannot abort or delete leaves the
// job failing at the end rather than at the start.
const WRITE_ACTIONS = [
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:AbortMultipartUpload",
  "s3:ListMultipartUploadParts",
];

export function stsRequired(): boolean {
  return (process.env.LAKEHOUSE_STS_REQUIRED ?? "").trim().toLowerCase() === "true";
}

function durationSeconds(): number {
  const n = Number(process.env.LAKEHOUSE_STS_DURATION_SECONDS);
  // The floor the stores accept is 900s; a run that outlives its credential
  // fails mid-flight, so the default is generous.
  return Number.isFinite(n) && n >= 900 ? Math.floor(n) : 12 * 3600;
}

/**
 * A prefix as it may appear in a policy: no leading slash, no "..", ends in
 * "/" so that `prefix*` cannot match a sibling whose name merely starts the
 * same way ("main/analytics/orders" vs "main/analytics/orders_private").
 */
export function normalisePrefix(raw: string): string {
  const key = raw.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (!key || key.split("/").includes("..")) {
    throw new Error(`"${raw}" is not a prefix a scoped credential can name`);
  }
  return key.endsWith("/") ? key : `${key}/`;
}

/** The session policy for one scope, as the store's STS expects it. */
export function scopePolicy(bucket: string, scope: Scope): string {
  const arn = (p: string) => `arn:aws:s3:::${bucket}/${normalisePrefix(p)}*`;
  const statements: unknown[] = [];
  const read = scope.read ?? [];
  const write = scope.write ?? [];
  if (!read.length && !write.length) throw new Error("A scoped credential must name a prefix");
  if (read.length) {
    statements.push({ Effect: "Allow", Action: READ_ACTIONS, Resource: read.map(arn) });
  }
  if (write.length) {
    statements.push({ Effect: "Allow", Action: WRITE_ACTIONS, Resource: write.map(arn) });
  }
  // S3A lists a prefix before it reads or writes it. The listing is bounded to
  // the same prefixes, so the credential cannot enumerate the bucket.
  statements.push({
    Effect: "Allow",
    Action: ["s3:ListBucket"],
    Resource: [`arn:aws:s3:::${bucket}`],
    Condition: {
      StringLike: { "s3:prefix": [...read, ...write].map((p) => `${normalisePrefix(p)}*`) },
    },
  });
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function tagValue(xml: string, tag: string): string | null {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
}

/** Where STS lives for this target: the store's own endpoint, or AWS's. */
function stsEndpoint(t: S3Target): { origin: string; host: string } {
  const configured = process.env.LAKEHOUSE_STS_ENDPOINT?.trim();
  const raw = configured || t.endpoint;
  if (raw) {
    const bare = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const scheme =
      configured?.startsWith("http://") || (!configured && !t.useSsl) ? "http" : "https";
    return { origin: `${scheme}://${bare}`, host: bare };
  }
  const host = `sts.${t.region}.amazonaws.com`;
  return { origin: `https://${host}`, host };
}

let warned = false;

/**
 * Credentials the store will honour only for `scope`, or null when this
 * deployment's store has no STS. Never throws for an unsupported store unless
 * LAKEHOUSE_STS_REQUIRED says to.
 *
 * `label` names the run in the store's own audit trail.
 */
export async function assumeScopedCredentials(args: {
  target: S3Target;
  scope: Scope;
  label: string;
}): Promise<ScopedCredentials | null> {
  const { target } = args;
  const policy = scopePolicy(target.bucket, args.scope);
  const { origin, host } = stsEndpoint(target);
  const roleArn = process.env.LAKEHOUSE_STS_ROLE_ARN?.trim();
  const body = formEncode({
    Action: "AssumeRole",
    Version: "2011-06-15",
    DurationSeconds: String(durationSeconds()),
    Policy: policy,
    // AWS requires a role to assume; MinIO derives the session from the
    // calling key and ignores these, so sending them is right for both.
    ...(roleArn ? { RoleArn: roleArn } : {}),
    RoleSessionName: args.label.replace(/[^\w=,.@-]/g, "-").slice(0, 64) || "agentswarms",
  });
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const headers: Record<string, string> = {
    host,
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    "x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
    "x-amz-date": amzDate,
  };
  const { authorization } = signS3Request({
    method: "POST",
    canonicalUri: "/",
    query: {},
    headers,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    service: "sts",
  });
  const { host: _host, ...send } = headers;
  void _host;

  let res: Response;
  try {
    res = await fetch(`${origin}/`, {
      method: "POST",
      headers: { ...send, Authorization: authorization },
      body,
    });
  } catch (e) {
    return unavailable(`the store's STS endpoint could not be reached: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const code = tagValue(text, "Code") ?? String(res.status);
    return unavailable(`the store refused AssumeRole (${code})`);
  }
  const accessKeyId = tagValue(text, "AccessKeyId");
  const secretAccessKey = tagValue(text, "SecretAccessKey");
  const sessionToken = tagValue(text, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    return unavailable("the store's AssumeRole answer carried no session credentials");
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresAt: tagValue(text, "Expiration") ?? "",
  };
}

function unavailable(why: string): null {
  if (stsRequired()) {
    throw new Error(
      `Scoped object-store credentials are required on this deployment (LAKEHOUSE_STS_REQUIRED), but ${why}.`,
    );
  }
  if (!warned) {
    warned = true;
    console.warn(
      `[lakehouse] scoped credentials for the Spark cluster are not available: ${why}. ` +
        `The cluster receives the lakehouse's own credentials instead. ` +
        `See docs/SANDBOX_LAKEHOUSE_ACCESS.md.`,
    );
  }
  return null;
}

/** For tests: the one-warning-per-process latch. */
export function resetStsWarning(): void {
  warned = false;
}
