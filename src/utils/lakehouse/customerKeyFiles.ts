// Lakehouse files under customer keys: the decisions, with no I/O.
//
// A customer key held in AWS KMS can cover its members' lakehouse files: the
// object store encrypts each file under the customer's key (S3 SSE-KMS), so a
// customer who disables or revokes their key stops the store serving their
// files, and nothing else changes — queries, Spark and shares read the same
// files. The app's part is to say WHICH key each write carries: one DuckDB S3
// secret per schema, scoped to that schema's folder and carrying the
// customer's key (KMS_KEY_ID), measured in the app image (DuckDB 1.5.5):
// small and multipart writes alike land under the key, and a file outside the
// scope keeps the bucket's own encryption.
//
// What it cannot cover, and the page says so: a key the app holds (the store
// cannot use a key it does not have), a key in another provider (the store is
// S3), a key in another region than the bucket (S3 uses a key only in the
// bucket's own region), and a store that does not encrypt with KMS keys.
import type { CustomerKeyRow } from "@/utils/kms/keyHierarchy.server";

/** Whether the lakehouse store encrypts files under customer keys, and why. */
export type SseMode = { on: boolean; why: string };

/**
 * `LAKEHOUSE_SSE_KMS`: `auto` (the default) is on for AWS S3 — no endpoint,
 * or an amazonaws.com one (a VPC endpoint) — and off for any other store,
 * which may not encrypt with KMS keys at all; `on` for an S3-compatible store
 * that does (MinIO with KES); `off`. An unknown value is off, and named.
 */
export function sseKmsMode(
  raw: string | undefined,
  dataUrl: string | undefined,
  endpoint: string | undefined,
): SseMode {
  if (!dataUrl) return { on: false, why: "The lakehouse is not configured." };
  if (!/^s3a?:\/\//i.test(dataUrl)) {
    return {
      on: false,
      why: "The lakehouse's data path is not on S3 (LAKEHOUSE_DATA_URL), and only S3 encrypts files under a customer's KMS key here.",
    };
  }
  const value = (raw ?? "").trim().toLowerCase() || "auto";
  if (value === "off" || value === "false") {
    return { on: false, why: "Turned off for this deployment (LAKEHOUSE_SSE_KMS=off)." };
  }
  if (value === "on" || value === "true") {
    return {
      on: true,
      why: "The lakehouse store encrypts files under customer keys (LAKEHOUSE_SSE_KMS=on).",
    };
  }
  if (value !== "auto") {
    return {
      on: false,
      why: `LAKEHOUSE_SSE_KMS=${raw?.trim()} is not auto, on or off, so files are not encrypted under customer keys.`,
    };
  }
  if (isAwsEndpoint(endpoint)) {
    return {
      on: true,
      why: "The lakehouse store is AWS S3, which encrypts files under customer keys.",
    };
  }
  return {
    on: false,
    why: `The lakehouse store is ${endpointHost(endpoint)}, not AWS S3, and may not encrypt with KMS keys. Set LAKEHOUSE_SSE_KMS=on if it does (MinIO with KES, for one).`,
  };
}

function endpointHost(endpoint: string | undefined): string {
  return (endpoint ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/[/:].*$/, "")
    .toLowerCase();
}

/**
 * Whether an S3 endpoint is AWS's own: none (the regional default), or an
 * amazonaws.com host, a VPC endpoint among them.
 */
export function isAwsEndpoint(endpoint: string | undefined): boolean {
  const host = endpointHost(endpoint);
  return !host || host === "amazonaws.com" || host.endsWith(".amazonaws.com");
}

const KEY_ARN = /^arn:aws(?:-[a-z-]+)?:kms:([a-z0-9-]+):\d{12}:key\/[A-Za-z0-9-]+$/;

/** The region of an AWS KMS key's ARN, or null when the ref is not a key ARN. */
export function awsKmsKeyRegion(ref: string): string | null {
  return KEY_ARN.exec(ref.trim())?.[1] ?? null;
}

/** What a customer key does for its members' lakehouse files. */
export type FileKeyDecision = { kmsKeyId: string } | { kmsKeyId: null; why: string };

/** Why a decision does not cover lakehouse files; null when it does. */
export function whyNotCovered(d: FileKeyDecision): string | null {
  return d.kmsKeyId === null ? d.why : null;
}

export function fileKeyFor(
  key: Pick<CustomerKeyRow, "provider" | "key_ref" | "destroyed_at">,
  mode: SseMode,
  bucketRegion: string,
): FileKeyDecision {
  if (key.destroyed_at) return { kmsKeyId: null, why: "Destroyed." };
  if (key.provider === "app") {
    return {
      kmsKeyId: null,
      why: "Held by the app: the store cannot use a key the app holds, so its members' lakehouse files stay under the store's own encryption.",
    };
  }
  if (key.provider !== "aws") {
    const where =
      key.provider === "azure"
        ? "Azure Key Vault"
        : key.provider === "gcp"
          ? "Google Cloud KMS"
          : key.provider === "oci"
            ? "OCI Vault"
            : "Vault";
    return {
      kmsKeyId: null,
      why: `In ${where}: the lakehouse store is S3, which encrypts only under an AWS KMS key, so its members' lakehouse files stay under the store's own encryption.`,
    };
  }
  if (!mode.on) return { kmsKeyId: null, why: mode.why };
  const ref = (key.key_ref ?? "").trim();
  const region = awsKmsKeyRegion(ref);
  if (!region) {
    return {
      kmsKeyId: null,
      why: "Not a key's ARN (an alias or a bare key id): S3 records the key it resolves to, so give the key's own ARN (arn:aws:kms:<region>:<account>:key/<id>) for lakehouse files to be encrypted under it.",
    };
  }
  if (region !== bucketRegion) {
    return {
      kmsKeyId: null,
      why: `The key is in ${region} and the lakehouse bucket in ${bucketRegion}: S3 encrypts only under a key in the bucket's own region.`,
    };
  }
  return { kmsKeyId: ref };
}

/** Where a schema's files live: its catalog path, under the data path when relative. */
export function schemaPrefix(dataUrl: string, path: string, isRelative: boolean): string {
  const dir = path.endsWith("/") ? path : `${path}/`;
  if (!isRelative) return dir;
  return `${dataUrl.replace(/\/+$/, "")}/${dir.replace(/^\/+/, "")}`;
}

/** An s3:// URL's bucket and key. */
export function splitS3Url(url: string): { bucket: string; key: string } | null {
  const m = /^s3a?:\/\/([^/]+)\/?(.*)$/i.exec(url);
  return m ? { bucket: m[1], key: m[2] } : null;
}

/**
 * Where model artifacts live, beside the lake's data path: one folder per
 * model (`<model>/v<n>/…`) and one per experiment run (`experiments/<run>/…`).
 */
export const MODEL_ARTIFACT_ROOT = "ml-artifacts/";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The model or experiment run a stored artifact belongs to, from its key; null
 * for a key that is neither (nothing the app wrote), which a pass leaves alone.
 */
export function artifactFolderOf(key: string): { kind: "model" | "run"; id: string } | null {
  if (!key.startsWith(MODEL_ARTIFACT_ROOT)) return null;
  const parts = key.slice(MODEL_ARTIFACT_ROOT.length).split("/");
  if (parts[0] === "experiments") {
    return parts.length > 2 && UUID.test(parts[1]) && parts[2]
      ? { kind: "run", id: parts[1].toLowerCase() }
      : null;
  }
  return parts.length > 1 && UUID.test(parts[0]) && parts[1]
    ? { kind: "model", id: parts[0].toLowerCase() }
    : null;
}

/** How one stored file is encrypted, read from the store (HEAD). */
export type ObjectEncryption = { sse: string | null; kmsKeyId: string | null };

/**
 * What the re-encrypt pass does to one file: keep it, or copy it in place
 * under the key it should be under (null: the bucket's own encryption).
 *
 * A file under a DESTROYED customer key is never moved: destroying the key
 * made its members' credentials unreadable, and copying their files onto
 * another key would keep alive what the destroy meant to end. Those files stay
 * readable only while the customer's own KMS key allows. A file under a key
 * that is no customer key's (the bucket's own SSE-KMS default) is not ours to
 * change when it should be on the bucket's encryption anyway.
 */
export function reEncryptAction(
  current: ObjectEncryption,
  desired: string | null,
  liveRefs: ReadonlySet<string>,
  destroyedRefs: ReadonlySet<string>,
): "keep" | "keep-destroyed" | { copyTo: string | null } {
  const now = current.kmsKeyId;
  if (now && destroyedRefs.has(now) && !liveRefs.has(now)) return "keep-destroyed";
  if (desired) return now === desired ? "keep" : { copyTo: desired };
  if (now && liveRefs.has(now)) return { copyTo: null };
  return "keep";
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * A re-encrypt pass's counts in one line, from its audit row's detail (the
 * card's last pass, and the toast after "Re-encrypt lakehouse files").
 */
export function filesPassLine(d: Record<string, unknown>): string {
  if (typeof d.skipped === "string") return `Nothing ran: ${d.skipped}`;
  // R442: models and experiment runs beside the schemas, named when the pass
  // had any, so a pass from before reads as it always did.
  const where = [
    count(num(d.schemas), "schema"),
    num(d.models) > 0 ? count(num(d.models), "model") : null,
    num(d.experiment_runs) > 0 ? count(num(d.experiment_runs), "experiment run") : null,
  ].filter((w): w is string => w !== null);
  const places =
    where.length > 1 ? `${where.slice(0, -1).join(", ")} and ${where[where.length - 1]}` : where[0];
  const parts = [
    `${count(num(d.files), "file")} in ${places} checked`,
    num(d.files_reencrypted) > 0
      ? `${num(d.files_reencrypted)} re-encrypted under a customer key`
      : null,
    num(d.files_to_store_key) > 0
      ? `${num(d.files_to_store_key)} back on the store's own encryption`
      : null,
    num(d.files_already_right) > 0
      ? `${num(d.files_already_right)} already under the right key`
      : null,
    num(d.files_kept_under_destroyed) > 0
      ? `${num(d.files_kept_under_destroyed)} left under a destroyed customer key`
      : null,
    num(d.files_too_large) > 0
      ? `${num(d.files_too_large)} too large to copy in place (over 5 GB)`
      : null,
    num(d.schemas_conflicted) > 0
      ? `${count(num(d.schemas_conflicted), "schema")} left as is (its owner is in two customer keys)`
      : null,
    num(d.models_conflicted) > 0
      ? `${num(d.models_conflicted)} ${num(d.models_conflicted) === 1 ? "model or run" : "models or runs"} left as is (the owner is in two customer keys)`
      : null,
    num(d.files_not_owned) > 0
      ? `${count(num(d.files_not_owned), "file")} of no model or run on record left as is`
      : null,
    num(d.files_failed) > 0 ? `${num(d.files_failed)} failed` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * What a sandbox read's audit row says about the copy it staged (R442): under
 * the owner's customer key, named by the start of its key id; nothing when it
 * was under the store's own encryption. Found in the round: the row recorded
 * the key and the log line never showed it.
 */
export function stagedUnderKeyBit(d: Record<string, unknown>): string | null {
  const ref = d.staged_under_kms_key;
  if (typeof ref !== "string" || !ref.trim()) return null;
  const id = /:key\/([0-9a-f-]+)$/i.exec(ref.trim())?.[1] ?? ref.trim();
  return `staged under the customer's KMS key ${id.slice(0, 8)}…`;
}

/**
 * The later of two passes: the one the audit trail has, and one just run from
 * the page, whose audit row is written after its answer. By time, not by text:
 * Postgres and the browser write the same instant differently.
 */
export function laterPass<T extends { at: string }>(a: T | null, b: T | null): T | null {
  if (!a || !b) return a ?? b;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

/** A covered schema, as the error explainer needs it. */
export type CoveredPrefix = {
  bucket: string;
  /** The schema folder's key, ending in "/". */
  keyPrefix: string;
  schema: string;
  keyName: string;
  kmsKeyId: string;
};

/**
 * A store refusal on a file under a customer key, said in words: which
 * schema, which customer key, what to check. DuckDB reports these as a bare
 * HTTP status quoting the file's URL (s3:// on AWS, the endpoint's own URL in
 * path style), with S3's KMS error code only when the body is quoted. S3
 * answers a key the customer disabled or scheduled for deletion with 400
 * (KMS.DisabledException, KMS.KMSInvalidStateException) and a key the
 * storage identity may not use with 403 (AccessDenied), so both count; on a
 * covered schema's own file a 400 has no other likely cause, and the message
 * names both. Null for anything else.
 */
export function describeCustomerKeyFileError(
  message: string,
  covered: readonly CoveredPrefix[],
): string | null {
  const status = /\b(400|403)\b/.exec(message)?.[1];
  const code = /\b(KMS\.[A-Za-z]+Exception|AccessDenied)\b/.exec(message)?.[1];
  if (!status && !code && !/Forbidden/i.test(message)) return null;
  const hit = covered.find(
    (p) =>
      message.includes(`${p.bucket}/${p.keyPrefix}`) ||
      (message.includes(`${p.bucket}.`) && message.includes(`/${p.keyPrefix}`)),
  );
  if (!hit) return null;
  return (
    `The store refused a file of lakehouse schema "${hit.schema}" (${code ?? `HTTP ${status ?? 403}`}). ` +
    `Its files are encrypted under the customer key "${hit.keyName}" (${hit.kmsKeyId}): the customer ` +
    `may have disabled or revoked that key, or the lakehouse's storage identity may lack kms:Decrypt ` +
    `and kms:GenerateDataKey on it. Other schemas are unaffected.`
  );
}
