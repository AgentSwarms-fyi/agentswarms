// Lakehouse files under customer keys (R440): the engine's scoped secrets, the
// re-encrypt pass, the store's check, and a refusal said in words. The
// decisions are customerKeyFiles.ts's; this file reads what they need.
//
// WRITES. Every lakehouse write goes through the app's one DuckDB engine per
// worker (a sandbox holds no lakehouse credential), so one S3 secret per
// covered schema on that engine, scoped to the schema's folder and carrying
// the customer's KMS key, is what puts the schema's new files under the key.
// Share snapshots of a covered schema's tables get one too. Secrets are
// per engine and the app runs one engine per worker, so each worker syncs
// them against the assignments at most every SYNC_MS, and at once on the
// worker that made a change.
//
// OLDER FILES. Files written before an assignment, or under the key a user
// has since left, are copied in place under the key they should be under: the
// bytes stay in the store and the catalog's paths do not change. An
// assignment starts that pass by itself, after every worker has synced.
import { randomUUID } from "node:crypto";

import type { DuckDBConnection } from "@duckdb/node-api";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { KeyStoreMissingError, type CustomerKeyRow } from "@/utils/kms/keyHierarchy.server";
import { KMS_AUDIT_ACTOR } from "@/utils/kms/keyring.server";
import {
  groupMembers,
  listCustomerKeyMembers,
  listCustomerKeys,
} from "@/utils/kms/keyStore.server";
import { expectedCustomerKeys } from "@/utils/providers/keyRotation.server";
import {
  S3_COPY_MAX_BYTES,
  s3CopyInPlace,
  s3DeleteObject,
  s3HeadObject,
  s3ListKeys,
  s3PutObjectUnderKey,
  type S3Target,
} from "./presign.server";
import { lakehouseConfig, lakehouseS3SecretParts, type LakehouseConfig } from "./core.server";
import {
  describeCustomerKeyFileError,
  fileKeyFor,
  reEncryptAction,
  schemaPrefix,
  splitS3Url,
  sseKmsMode,
  whyNotCovered,
  type CoveredPrefix,
  type FileKeyDecision,
  type SseMode,
} from "./customerKeyFiles";

function sq(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** The store's mode for this deployment. */
export function lakehouseSseMode(): SseMode {
  const cfg = lakehouseConfig();
  return sseKmsMode(process.env.LAKEHOUSE_SSE_KMS, cfg?.dataUrl, cfg?.s3.endpoint);
}

/** The region the lakehouse bucket is in, as the store's credential says. */
function bucketRegion(cfg: LakehouseConfig | null): string {
  return cfg?.s3.region?.trim() || "us-east-1";
}

function targetFor(cfg: LakehouseConfig, bucket: string): S3Target {
  return {
    endpoint: cfg.s3.endpoint,
    region: bucketRegion(cfg),
    useSsl: cfg.s3.useSsl,
    urlStyle: cfg.s3.urlStyle === "path" ? "path" : "vhost",
    bucket,
    accessKeyId: cfg.s3.keyId,
    secretAccessKey: cfg.s3.secret,
  };
}

/** One folder of files and the key its new files are written under. */
export type FolderPlan = {
  bucket: string;
  /** The folder's key prefix in the bucket, ending in "/". */
  keyPrefix: string;
  /** The customer's KMS key; null: the store's own encryption. */
  kmsKeyId: string | null;
};

export type SchemaPlan = FolderPlan & {
  schemaId: string;
  name: string;
  ownerId: string;
  customerKeyId: string | null;
  customerKeyName: string | null;
  /** Why a schema under a customer key is not encrypted under it. */
  why: string | null;
  /** Its owner's groups name two customer keys: left as it is until one is chosen. */
  conflict: boolean;
  /** The catalog's own id for the schema; null when the catalog has no such schema (yet). */
  catalogId: string | null;
};

export type SharePlan = FolderPlan & { shareTableId: string; schemaId: string };

export type FilePlan = {
  mode: SseMode;
  bucketRegion: string;
  keys: Array<{ id: string; name: string; decision: FileKeyDecision }>;
  schemas: SchemaPlan[];
  shares: SharePlan[];
  /** KMS keys of live customer keys: files under one belong to whoever it covers. */
  liveRefs: Set<string>;
  /** KMS keys of destroyed customer keys: their files are never moved. */
  destroyedRefs: Set<string>;
};

type CatalogSchema = { id: string; path: string; relative: boolean };

/** DuckLake's own id and folder per schema, read from the catalog. */
async function catalogSchemaPaths(
  c: Pick<DuckDBConnection, "run">,
): Promise<Map<string, CatalogSchema>> {
  const rows = await (
    await c.run(
      `SELECT schema_name, path, path_is_relative, schema_id FROM __ducklake_metadata_lake.ducklake_schema WHERE end_snapshot IS NULL`,
    )
  ).getRows();
  const out = new Map<string, CatalogSchema>();
  for (const r of rows) {
    if (r[1] == null) continue;
    out.set(String(r[0]).toLowerCase(), {
      id: String(r[3]),
      path: String(r[1]),
      relative: r[2] !== false,
    });
  }
  return out;
}

/**
 * Which key each schema's files are written under, and why. A read that fails
 * throws: answering "no schemas" would drop every secret, and a covered
 * schema would be written under the store's own encryption without a word.
 *
 * With no connection the catalog is not read: what each key covers and how
 * many schemas, for the card, without waiting on the lakehouse (R440's round:
 * the card sat on "Checking..." while a catalog came up). Folders are then the
 * default ones, which is what a schema the app created has.
 */
export async function customerKeyFilePlan(
  c: Pick<DuckDBConnection, "run"> | null,
): Promise<FilePlan> {
  const cfg = lakehouseConfig();
  const mode = lakehouseSseMode();
  const region = bucketRegion(cfg);
  const plan: FilePlan = {
    mode,
    bucketRegion: region,
    keys: [],
    schemas: [],
    shares: [],
    liveRefs: new Set(),
    destroyedRefs: new Set(),
  };
  if (!cfg) return plan;
  let keys: CustomerKeyRow[] = [];
  let expected = new Map<string, { customerKeyId: string } | { conflict: string[] }>();
  try {
    const [rows, members] = await Promise.all([listCustomerKeys(), listCustomerKeyMembers()]);
    keys = rows;
    const groupIds = [...new Set(members.map((m) => m.group_id).filter((g): g is string => !!g))];
    expected = expectedCustomerKeys(members, await groupMembers(groupIds));
  } catch (e) {
    // Before migration 20261105000000 there are no customer keys to cover anyone.
    if (!(e instanceof KeyStoreMissingError)) throw e;
  }
  const byId = new Map(keys.map((k) => [k.id, k]));
  for (const k of keys) {
    plan.keys.push({ id: k.id, name: k.name, decision: fileKeyFor(k, mode, region) });
    if (k.provider === "aws" && k.key_ref) {
      (k.destroyed_at ? plan.destroyedRefs : plan.liveRefs).add(k.key_ref.trim());
    }
  }
  const decisions = new Map(plan.keys.map((k) => [k.id, k.decision]));

  const { data: rows, error } = await supabaseAdmin
    .from("lakehouse_schemas")
    .select("id, name, user_id, lake_source_id, iceberg_catalog_id");
  if (error) throw new Error(`Could not read the lakehouse schemas: ${error.message}`);
  const paths = c ? await catalogSchemaPaths(c) : new Map<string, CatalogSchema>();
  const lake = splitS3Url(cfg.dataUrl);
  if (!lake) return plan;
  for (const s of rows ?? []) {
    // A mount reads someone else's files; the app writes none of them.
    if (s.lake_source_id || s.iceberg_catalog_id) continue;
    const inCatalog = paths.get(s.name.toLowerCase());
    const where = inCatalog ?? { path: `${s.name}/`, relative: true };
    const url = splitS3Url(schemaPrefix(cfg.dataUrl, where.path, where.relative));
    if (!url) continue;
    const exp = expected.get(s.user_id);
    const customerKeyId = exp && "customerKeyId" in exp ? exp.customerKeyId : null;
    const decision = customerKeyId ? decisions.get(customerKeyId) : undefined;
    plan.schemas.push({
      schemaId: s.id,
      name: s.name,
      ownerId: s.user_id,
      bucket: url.bucket,
      keyPrefix: url.key,
      customerKeyId,
      customerKeyName: customerKeyId ? (byId.get(customerKeyId)?.name ?? null) : null,
      kmsKeyId: decision?.kmsKeyId ?? null,
      why: decision ? whyNotCovered(decision) : null,
      conflict: !!exp && "conflict" in exp,
      catalogId: inCatalog?.id ?? null,
    });
  }

  // Share snapshots are copies of a schema's tables, beside the lake.
  const shareUrl = (process.env.SHARE_DATA_URL?.trim() || `s3://${lake.bucket}/shares`).replace(
    /\/+$/,
    "",
  );
  const shareRoot = splitS3Url(shareUrl);
  const bySchema = new Map(plan.schemas.map((s) => [s.name.toLowerCase(), s]));
  if (shareRoot) {
    const { data: shareRows, error: shareError } = await supabaseAdmin
      .from("lakehouse_share_tables")
      .select("id, schema_name");
    if (shareError) throw new Error(`Could not read the shared tables: ${shareError.message}`);
    for (const t of shareRows ?? []) {
      const schema = bySchema.get(t.schema_name.toLowerCase());
      if (!schema) continue;
      plan.shares.push({
        shareTableId: t.id,
        schemaId: schema.schemaId,
        bucket: shareRoot.bucket,
        keyPrefix: `${shareRoot.key ? `${shareRoot.key.replace(/\/+$/, "")}/` : ""}${t.id}/`,
        kmsKeyId: schema.kmsKeyId,
      });
    }
  }
  return plan;
}

// ── The engine's secrets ─────────────────────────────────────────────────────

let lastSync = 0;
let lastPlan: FilePlan | null = null;
const SYNC_MS = 15_000;
/**
 * Catalog schema ids whose small writes THIS worker's attachment has been told
 * not to inline. DuckLake reads its options when it attaches and keeps them:
 * an option another worker sets reaches this one's catalog view (with a
 * Postgres catalog, ducklake_options() reads the stored rows) but not its
 * writes, measured in R440's round (a worker attached before the option
 * still inlined a row, until it set the option itself). So each worker sets
 * it once on its own attachment, whatever the view says.
 */
const inliningOffHere = new Set<string>();

/** The next sync on this worker happens at once: after an assignment, or a new schema. */
export function forgetCustomerKeyFiles(): void {
  lastSync = 0;
}

/** A new engine attaches the catalog afresh: its options come with it, and are set again. */
export function forgetEngineAttachment(): void {
  inliningOffHere.clear();
  lastSync = 0;
}

const secretName = (kind: "s" | "t", id: string) => `lake_ck_${kind}_${id.replace(/-/g, "")}`;

/**
 * Create the scoped secret of every covered folder, drop the ones no longer
 * covered, and stop DuckLake inlining small writes of a covered schema into
 * the catalog (they would sit in the catalog's Postgres, under no customer
 * key). A plan that cannot be read changes nothing.
 */
export async function ensureCustomerKeySecrets(
  c: Pick<DuckDBConnection, "run">,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSync < SYNC_MS) return;
  lastSync = now;
  const cfg = lakehouseConfig();
  if (!cfg) return;
  const plan = await customerKeyFilePlan(c);
  lastPlan = plan;
  const want = new Map<string, string>();
  if (plan.mode.on) {
    const base = lakehouseS3SecretParts(cfg);
    const add = (name: string, f: FolderPlan) => {
      if (!f.kmsKeyId) return;
      want.set(
        name,
        `CREATE OR REPLACE SECRET ${name} (${[
          ...base,
          `KMS_KEY_ID ${sq(f.kmsKeyId)}`,
          `SCOPE ${sq(`s3://${f.bucket}/${f.keyPrefix}`)}`,
        ].join(", ")});`,
      );
    };
    for (const s of plan.schemas) add(secretName("s", s.schemaId), s);
    for (const t of plan.shares) add(secretName("t", t.shareTableId), t);
  }
  for (const sql of want.values()) await c.run(sql);
  const have = await (
    await c.run(`SELECT name FROM duckdb_secrets() WHERE name LIKE 'lake_ck_%'`)
  ).getRows();
  for (const [name] of have) {
    if (!want.has(String(name))) await c.run(`DROP SECRET IF EXISTS ${String(name)};`);
  }
  if (!plan.mode.on) return;
  // A schema the catalog does not have yet (its row comes first) has no
  // writes to keep out of the catalog; the sync after it is created sets it.
  for (const s of plan.schemas) {
    if (!s.kmsKeyId || !s.catalogId || inliningOffHere.has(s.catalogId)) continue;
    try {
      await c.run(`CALL lake.set_option('data_inlining_row_limit', 0, schema => ${sq(s.name)});`);
      inliningOffHere.add(s.catalogId);
    } catch (e) {
      console.warn(
        `[lakehouse] schema "${s.name}": inlining not turned off:`,
        (e as Error).message,
      );
    }
  }
}

/** The covered folders this worker last synced, as the error explainer needs them. */
function coveredPrefixes(plan: FilePlan | null): CoveredPrefix[] {
  if (!plan) return [];
  return plan.schemas
    .filter((s) => s.kmsKeyId)
    .map((s) => ({
      bucket: s.bucket,
      keyPrefix: s.keyPrefix,
      schema: s.name,
      keyName: s.customerKeyName ?? "",
      kmsKeyId: s.kmsKeyId as string,
    }));
}

/** A statement's error, when the store refused a customer's key: said in words. */
export function customerKeyFileError(message: string): string | null {
  return describeCustomerKeyFileError(message, coveredPrefixes(lastPlan));
}

// ── The re-encrypt pass ──────────────────────────────────────────────────────

export type FilesPassResult = {
  ok: true;
  /** Why nothing ran (the store does not encrypt under customer keys). */
  skipped: string | null;
  schemas: number;
  files: number;
  /** Copied in place under the customer's key. */
  reEncrypted: number;
  /** Copied back to the store's own encryption: their owner left a customer key. */
  toStoreKey: number;
  alreadyRight: number;
  /** Under a destroyed customer key: never moved. */
  keptUnderDestroyed: number;
  /** Larger than one copy request takes (5 GB). */
  tooLarge: number;
  /** Schemas left alone: their owner's groups name two customer keys. */
  conflicted: number;
  failed: number;
  errors: string[];
};

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/**
 * Put every file of the given owners' schemas (all, when none are given),
 * and their shares' snapshots, under the key it should be under. Rows the
 * catalog still holds inline are written out first, so they land under the
 * key too.
 */
export async function reEncryptLakehouseFiles(
  opts: { owners?: string[] } = {},
): Promise<FilesPassResult> {
  const result: FilesPassResult = {
    ok: true,
    skipped: null,
    schemas: 0,
    files: 0,
    reEncrypted: 0,
    toStoreKey: 0,
    alreadyRight: 0,
    keptUnderDestroyed: 0,
    tooLarge: 0,
    conflicted: 0,
    failed: 0,
    errors: [],
  };
  const cfg = lakehouseConfig();
  const mode = lakehouseSseMode();
  if (!cfg || !mode.on) {
    result.skipped = mode.why;
    return result;
  }
  const { lakehouseConnection } = await import("./core.server");
  const c = await lakehouseConnection();
  let plan: FilePlan;
  try {
    // The secrets first: a row flushed out of the catalog is written now.
    await ensureCustomerKeySecrets(c, true);
    plan = lastPlan as FilePlan;
    const owners = opts.owners ? new Set(opts.owners) : null;
    const schemas = plan.schemas.filter((s) => !owners || owners.has(s.ownerId));
    result.conflicted = schemas.filter((s) => s.conflict).length;
    const targets = schemas.filter((s) => !s.conflict);
    result.schemas = targets.length;
    for (const s of targets.filter((t) => t.kmsKeyId)) {
      await c
        .run(`CALL ducklake_flush_inlined_data('lake', schema_name => ${sq(s.name)})`)
        .catch(() => undefined); // nothing inlined
    }
    const ids = new Set(targets.map((s) => s.schemaId));
    const folders: FolderPlan[] = [...targets, ...plan.shares.filter((t) => ids.has(t.schemaId))];
    for (const f of folders) {
      const target = targetFor(cfg, f.bucket);
      let listed: { key: string }[];
      try {
        listed = await s3ListKeys(target, f.keyPrefix);
      } catch (e) {
        result.failed++;
        result.errors.push(`${f.keyPrefix}: ${(e as Error).message}`);
        continue;
      }
      await pool(listed, 8, async ({ key }) => {
        result.files++;
        try {
          const head = await s3HeadObject(target, key);
          if (!head) return; // deleted while the pass ran
          const action = reEncryptAction(
            { sse: head.sse, kmsKeyId: head.kmsKeyId },
            f.kmsKeyId,
            plan.liveRefs,
            plan.destroyedRefs,
          );
          if (action === "keep-destroyed") {
            result.keptUnderDestroyed++;
            return;
          }
          if (action === "keep") {
            result.alreadyRight++;
            return;
          }
          if (head.size > S3_COPY_MAX_BYTES) {
            result.tooLarge++;
            return;
          }
          await s3CopyInPlace(target, key, {
            kmsKeyId: action.copyTo,
            contentType: head.contentType,
          });
          if (action.copyTo) result.reEncrypted++;
          else result.toStoreKey++;
        } catch (e) {
          result.failed++;
          if (result.errors.length < 5) result.errors.push(`${key}: ${(e as Error).message}`);
        }
      });
    }
  } finally {
    c.closeSync();
  }
  return result;
}

/** The pass's counts, as the audit trail records them. */
export function filesPassDetail(r: FilesPassResult): Record<string, unknown> {
  return {
    schemas: r.schemas,
    files: r.files,
    files_reencrypted: r.reEncrypted,
    files_to_store_key: r.toStoreKey,
    files_already_right: r.alreadyRight,
    files_kept_under_destroyed: r.keptUnderDestroyed,
    files_too_large: r.tooLarge,
    schemas_conflicted: r.conflicted,
    files_failed: r.failed,
    ...(r.errors.length ? { errors: r.errors } : {}),
    ...(r.skipped ? { skipped: r.skipped } : {}),
  };
}

/**
 * After an assignment moved these owners: once every worker has synced its
 * secrets (so no worker still writes under the old key), put their files
 * under the key they should be under. Nothing to do, and nothing read beyond
 * the plan, while no live customer key is in AWS KMS.
 */
export function reEncryptFilesAfterMove(
  owners: string[],
  why: string,
  actor: { userId: string | null; email: string | null } = { userId: null, email: null },
): void {
  const ids = [...new Set(owners)];
  if (!ids.length) return;
  forgetCustomerKeyFiles();
  if (!lakehouseSseMode().on) return;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const keys = await listCustomerKeys().catch(() => [] as CustomerKeyRow[]);
        if (!keys.some((k) => k.provider === "aws" && !k.destroyed_at)) return;
        const r = await reEncryptLakehouseFiles({ owners: ids });
        auditEvent({
          userId: actor.userId,
          actorEmail: actor.email ?? KMS_AUDIT_ACTOR,
          action: "security.lakehouse_files.reencrypt",
          resourceType: "security",
          resourceName: why,
          detail: { trigger: why, users: ids.length, ...filesPassDetail(r) },
        });
        if (r.failed)
          console.warn(`[kms] lakehouse files after ${why}: ${r.failed} failed`, r.errors);
      } catch (e) {
        console.warn(`[kms] lakehouse files after ${why}:`, (e as Error).message);
      }
    })();
  }, SYNC_MS + 5_000);
  timer.unref?.();
}

// ── The store's check ────────────────────────────────────────────────────────

export type StoreCheck =
  { covered: false; why: string } | { covered: true; ok: boolean; detail: string };

/**
 * Ask the lakehouse store to write one small file under this customer key,
 * read back how it stored it, and delete it: what "Check" adds for a key that
 * covers lakehouse files. Beside the lake's data path, never inside it.
 */
export async function checkStoreUnderKey(row: CustomerKeyRow): Promise<StoreCheck> {
  const cfg = lakehouseConfig();
  const decision = fileKeyFor(row, lakehouseSseMode(), bucketRegion(cfg));
  if (decision.kmsKeyId === null) return { covered: false, why: decision.why };
  // Unreachable while the mode reads the same config; kept for the type.
  if (!cfg) return { covered: false, why: "The lakehouse is not configured." };
  const lake = splitS3Url(cfg.dataUrl);
  if (!lake) return { covered: false, why: "The lakehouse's data path is not on S3." };
  const target = targetFor(cfg, lake.bucket);
  const key = `_customer_key_check/${row.id}/${randomUUID()}.txt`;
  const put = await s3PutObjectUnderKey(
    target,
    key,
    Buffer.from("AgentSwarms: a customer key's check of the lakehouse store\n"),
    decision.kmsKeyId,
  );
  if (put.error) {
    return {
      covered: true,
      ok: false,
      detail: `The lakehouse store refused to write a test file under this key: ${put.error}.`,
    };
  }
  try {
    const head = await s3HeadObject(target, key);
    if (head?.sse === "aws:kms" && head.kmsKeyId === decision.kmsKeyId) {
      return {
        covered: true,
        ok: true,
        detail:
          "The lakehouse store wrote a test file under this key (aws:kms) and it was deleted.",
      };
    }
    return {
      covered: true,
      ok: false,
      detail: `The lakehouse store took the test file but stored it under ${head?.kmsKeyId ?? head?.sse ?? "no key it named"}, not this key: it does not encrypt under customer keys.`,
    };
  } finally {
    await s3DeleteObject(target, key).catch(() => undefined);
  }
}

/** What the card says about lakehouse files, per key and for the deployment. */
export async function customerKeyFilesView(): Promise<{
  mode: SseMode;
  perKey: Map<string, { kmsKeyId: string | null; why: string | null; schemas: number }>;
  conflictedSchemas: number;
  error?: string;
}> {
  const mode = lakehouseSseMode();
  const perKey = new Map<
    string,
    { kmsKeyId: string | null; why: string | null; schemas: number }
  >();
  const cfg = lakehouseConfig();
  if (!cfg) return { mode, perKey, conflictedSchemas: 0 };
  try {
    // No engine: the card must not wait on the lakehouse to show the keys.
    const plan = await customerKeyFilePlan(null);
    for (const k of plan.keys) {
      perKey.set(k.id, {
        kmsKeyId: k.decision.kmsKeyId,
        why: whyNotCovered(k.decision),
        schemas: plan.schemas.filter((s) => s.customerKeyId === k.id).length,
      });
    }
    return { mode, perKey, conflictedSchemas: plan.schemas.filter((s) => s.conflict).length };
  } catch (e) {
    return { mode, perKey, conflictedSchemas: 0, error: (e as Error).message };
  }
}

/** Test seam: the plan this worker last synced. */
export function __lastFilePlanForTests(): FilePlan | null {
  return lastPlan;
}
