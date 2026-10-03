// The lakehouse, for a sandbox that holds no lakehouse credential.
//
// A sandbox (an ETL run or node preview, an ML training or prediction) used
// to be handed the catalog's connection string and the object store's key,
// and its generated code attached DuckLake with them. Whatever the server
// checked beforehand, code in the sandbox could then reach every table's
// metadata and files. Now the sandbox holds neither. It asks the app, over
// its own session channel, for what its run DECLARED, and nothing else:
//
//   read    the server runs the declared SELECT as the run's owner through
//           governSelect (the SQL editor's schema check and the owners'
//           policies), writes the rows as Parquet under the session's staging
//           prefix, and returns a presigned GET and DELETE for that one file;
//   stage   presigned PUTs under the session's staging prefix, for one
//           declared target;
//   commit  the server loads staged Parquet into the declared targets, and
//           the run's cursors with them, in one transaction.
//
// A presigned URL carries its method and key inside the signature, so a URL
// to put one staging file cannot read it, write another, or list anything.
// Staging lives beside the lake, never inside its data path:
// s3://<bucket>/_sandbox_staging/<session-id>/.
import { randomUUID } from "node:crypto";

import type { DuckDBConnection } from "@duckdb/node-api";

import { auditEvent } from "@/utils/audit.server";
import {
  accessibleSchemas,
  assertSchemasAllowed,
  classifyStatement,
  governSelect,
  isWriteConflict,
  lakehouseConnection,
  redactLakehouseSecrets,
  stripSqlComments,
  type SchemaRow,
} from "@/utils/lakehouse/core.server";
import { loadPolicies } from "@/utils/lakehouse/policies.server";
import {
  presignS3,
  s3DeleteObject,
  s3DeletePrefix,
  s3ListKeys,
  type S3Target,
} from "@/utils/lakehouse/presign.server";
import { lakeTarget } from "@/utils/ml/experimentArtifacts.server";

export const STAGING_ROOT = "_sandbox_staging/";

/**
 * Where the engine reads and writes a staging key. The lake's own bucket in
 * production; a test passes a local directory so the real engine can run.
 */
export type StagingIo = {
  url: (key: string) => string;
  remove?: (key: string) => Promise<void>;
  list?: (prefix: string) => Promise<string[]>;
};
/** How long a presigned URL lives. A read is fetched at once; a stage is put within a tick. */
const URL_TTL_SECONDS = 3600;
/** Parts one stage may hand out. A sandbox frame fits in one; Spark writes several. */
export const MAX_STAGE_PARTS = 256;

export type LakeRead = {
  label: string;
  sql: string;
  /**
   * Read a random sample of this many rows when the source has more.
   *
   * ML trains on a sample of a large table, and which rows it got has to be
   * the same on a re-run, so this is DuckDB's repeatable reservoir sample
   * rather than a LIMIT. The app counts and decides: the sandbox is told what
   * it got, and cannot ask for the whole table instead.
   */
  sampleTo?: number;
  /**
   * Refuse rather than read, when the source has more rows than this. A
   * forecast's series and a prediction's batch are bounded by a limit the
   * operator sets, and neither has a meaningful sample.
   */
  refuseOver?: { rows: number; message: string };
};
export type LakeWriteMode = "append" | "replace" | "upsert";
export type LakeWrite = {
  label: string;
  schema: string;
  table: string;
  mode: LakeWriteMode;
  primaryKey: string[];
};
/** What one sandbox session may do in the lake, fixed when its environment is resolved. */
export type LakeManifest = {
  reads: Record<string, LakeRead>;
  writes: Record<string, LakeWrite>;
  /** Exactly-once: the pipeline whose cursors commit with its loads, and the nodes that have one. */
  cursors?: { pipelineId: string; nodes: string[] };
  /**
   * The model artifacts this run may write and read, as bucket-relative keys.
   *
   * A trainer writes one blob and reads none; an assemble step reads its
   * workers' and writes the whole; a prediction reads the version it was
   * asked for. Naming them here is what keeps a sandbox from reaching another
   * model's artifact with a URL it made up.
   */
  artifacts?: { put?: string; get?: string[] };
  /** A preview reads at most this many rows from each source. */
  rowLimit?: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sq(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
function qi(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

function storage(): { target: S3Target; bucket: string } {
  const t = lakeTarget();
  if (!t) {
    throw new Error(
      "The lakehouse is not configured on this deployment, or its data path is not an s3:// URL.",
    );
  }
  return { target: t.target, bucket: t.bucket };
}

export function stagingPrefix(sessionId: string): string {
  if (!UUID_RE.test(sessionId)) throw new Error("Not a session id");
  return `${STAGING_ROOT}${sessionId.toLowerCase()}/`;
}

/** The manifest a session stored, or null when it has none. Shape-checked, never trusted blindly. */
export function lakeManifestOf(inputs: unknown): LakeManifest | null {
  const raw = (inputs as { __lake?: unknown } | null)?.__lake;
  if (!raw || typeof raw !== "object") return null;
  const m = raw as LakeManifest;
  if (!m.reads || typeof m.reads !== "object" || !m.writes || typeof m.writes !== "object") {
    return null;
  }
  return m;
}

function ioTimeoutMs(): number {
  const n = Number(process.env.LAKEHOUSE_SANDBOX_IO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

async function withTimeout<T>(c: DuckDBConnection, work: () => Promise<T>): Promise<T> {
  const timer = setTimeout(() => {
    try {
      c.interrupt();
    } catch {
      /* already finished */
    }
  }, ioTimeoutMs());
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one declared read as the run's owner and hand back the rows as one
 * staged Parquet file.
 */
export async function lakeRead(args: {
  userId: string;
  sessionId: string;
  manifest: LakeManifest;
  id: string;
  via: string;
  io?: StagingIo;
}): Promise<{
  rows: number;
  /** Rows the source held before any sampling — what the sandbox reports. */
  total: number;
  sampled: boolean;
  files: { get: string; delete: string }[];
}> {
  const spec = Object.hasOwn(args.manifest.reads, args.id) ? args.manifest.reads[args.id] : null;
  if (!spec) throw new Error(`This run declared no lakehouse read "${args.id}"`);
  const body = stripSqlComments(spec.sql).replace(/;\s*$/, "");
  // A read is a query: DESCRIBE, SHOW and SUMMARIZE classify as reads but
  // cannot be wrapped in COPY, and nothing else may run here at all.
  if (classifyStatement(body).kind !== "select" || !/^(SELECT|WITH|FROM|\()/i.test(body)) {
    throw new Error(`Lakehouse source "${spec.label}": only a SELECT can be read into a pipeline`);
  }
  const { target, bucket } = storage();
  const url = args.io?.url ?? ((key: string) => `s3://${bucket}/${key}`);
  const allowed = await accessibleSchemas(args.userId);
  const c = await lakehouseConnection();
  try {
    const governed = await governSelect(c, args.userId, body, allowed);
    const sql = stripSqlComments(governed.sql).replace(/;\s*$/, "");
    // A read that is bounded, or sampled, is counted first: both decisions are
    // the app's, over the governed statement, so a reader sees them applied to
    // the rows a policy left them rather than to the table.
    let total = -1;
    const needsCount = Boolean(spec.refuseOver || (spec.sampleTo && spec.sampleTo > 0));
    if (needsCount) {
      total = await withTimeout(c, async () =>
        Number((await (await c.run(`SELECT count(*) FROM (${sql}) AS _n`)).getRows())[0]?.[0] ?? 0),
      );
      if (spec.refuseOver && total > spec.refuseOver.rows) {
        throw new Error(spec.refuseOver.message.replace("%d", String(total)));
      }
    }
    const sampled = Boolean(spec.sampleTo && spec.sampleTo > 0 && total > spec.sampleTo);
    const limit = args.manifest.rowLimit;
    const shaped = sampled
      ? `SELECT * FROM (${sql}) AS _q USING SAMPLE reservoir(${Math.floor(spec.sampleTo!)} ROWS) REPEATABLE (42)`
      : limit && limit > 0
        ? `SELECT * FROM (${sql}) AS _q LIMIT ${Math.floor(limit)}`
        : sql;
    const key = `${stagingPrefix(args.sessionId)}in/${randomUUID()}.parquet`;
    const rows = await withTimeout(c, async () => {
      const res = await c.run(
        `COPY (${shaped}) TO ${sq(url(key))} (FORMAT parquet, COMPRESSION zstd)`,
      );
      return Number((await res.getRows())[0]?.[0] ?? 0);
    });
    auditEvent({
      userId: args.userId,
      action: "lakehouse.sandbox_read",
      resourceType: "lakehouse",
      resourceName: spec.label,
      detail: {
        via: args.via,
        rows,
        policies_applied: governed.policyTables.length ? governed.policyTables : undefined,
      },
    });
    return {
      rows,
      total: total < 0 ? rows : total,
      sampled,
      files: [
        {
          get: presignS3({
            target,
            key,
            method: "GET",
            expiresSeconds: URL_TTL_SECONDS,
            which: "app",
          }),
          delete: presignS3({
            target,
            key,
            method: "DELETE",
            expiresSeconds: URL_TTL_SECONDS,
            which: "app",
          }),
        },
      ],
    };
  } catch (e) {
    throw new Error(redactLakehouseSecrets((e as Error).message));
  } finally {
    c.closeSync();
  }
}

/** Where one load's files live. The batch is the sandbox's, so it is checked. */
function batchPrefix(sessionId: string, batch: string): string {
  if (!UUID_RE.test(batch)) throw new Error("Not a staging batch");
  return `${stagingPrefix(sessionId)}out/${batch.toLowerCase()}/`;
}

function stagedKeys(sessionId: string, batch: string, parts: number): string[] {
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_STAGE_PARTS) {
    throw new Error(`A load is 1 to ${MAX_STAGE_PARTS} staged parts`);
  }
  const base = batchPrefix(sessionId, batch);
  return Array.from({ length: parts }, (_, k) => `${base}${k}.parquet`);
}

/**
 * The files of a load the SANDBOX did not name one by one.
 *
 * Spark's executors write a directory of part files whose names and number
 * are the cluster's business, so that load says "the batch" and the app lists
 * it. The prefix is still the app's: the session is the token's and the batch
 * must be a UUID, so a listing cannot reach another run's staging.
 */
async function listedKeys(
  target: S3Target,
  sessionId: string,
  batch: string,
  io?: StagingIo,
): Promise<string[]> {
  const prefix = batchPrefix(sessionId, batch);
  const keys = io?.list
    ? await io.list(prefix)
    : (await s3ListKeys(target, prefix)).map((k) => k.key);
  // Spark writes _SUCCESS and, on some stores, hidden checksum files beside
  // the parts; only the Parquet is data.
  return keys.filter((k) => k.endsWith(".parquet") && !k.slice(prefix.length).startsWith("."));
}

/** A model artifact's key, as this run declared it, from the URI it asked for. */
function artifactKey(bucket: string, uri: string): string {
  const m = /^s3a?:\/\/([^/]+)\/(.+)$/.exec(uri);
  return m && m[1] === bucket ? m[2]! : uri.replace(/^\/+/, "");
}

/**
 * A URL for one model artifact this run declared, and nothing else.
 *
 * Asked for when it is needed rather than handed out with the environment: a
 * training job can run for hours, and a URL minted at the start would have
 * expired by the time there is a model to write.
 */
export function lakeArtifact(args: { manifest: LakeManifest; which: "put" | "get"; uri: string }): {
  url: string;
} {
  const { target, bucket } = storage();
  const a = args.manifest.artifacts;
  if (!a) throw new Error("This run declared no model artifacts");
  const key = artifactKey(bucket, args.uri);
  const allowed = args.which === "put" ? (a.put ? [a.put] : []) : (a.get ?? []);
  if (!allowed.includes(key)) {
    throw new Error(`This run may not ${args.which} the artifact "${key}"`);
  }
  return {
    url: presignS3({
      target,
      key,
      method: args.which === "put" ? "PUT" : "GET",
      expiresSeconds: URL_TTL_SECONDS,
      which: "app",
    }),
  };
}

/** Presigned PUTs for one declared target's next load. */
export function lakeStage(args: {
  sessionId: string;
  manifest: LakeManifest;
  id: string;
  parts: number;
}): { batch: string; puts: string[] } {
  if (!Object.hasOwn(args.manifest.writes, args.id)) {
    throw new Error(`This run declared no lakehouse target "${args.id}"`);
  }
  const { target } = storage();
  const batch = randomUUID();
  return {
    batch,
    puts: stagedKeys(args.sessionId, batch, args.parts).map((key) =>
      presignS3({ target, key, method: "PUT", expiresSeconds: URL_TTL_SECONDS, which: "app" }),
    ),
  };
}

/**
 * Why `userId` may not write this table now, or null. Asked again at commit
 * time, because a grant can be revoked, or a policy set, while a run is live.
 * The same rules as the SQL editor's writes: an accessible schema, never a
 * mount, never a table under another owner's policy, never a table a Sheets
 * workbook holds.
 */
async function writeRefusal(
  userId: string,
  allowed: SchemaRow[],
  w: LakeWrite,
): Promise<string | null> {
  try {
    assertSchemasAllowed([w.schema], allowed);
  } catch (e) {
    return `Target "${w.label}": ${(e as Error).message}`;
  }
  const row = allowed.find((s) => s.name.toLowerCase() === w.schema.toLowerCase());
  if (row?.lake_source_id || row?.iceberg_catalog_id) {
    return `Target "${w.label}": "${w.schema}" is a read-only mount`;
  }
  if (row && row.user_id !== userId) {
    const policies = await loadPolicies(
      [row.user_id],
      [{ schema: w.schema.toLowerCase(), table: w.table.toLowerCase() }],
    );
    if (policies.size) {
      return `Target "${w.label}": ${w.schema}.${w.table} has a security policy set by its owner, so it is read-only for anyone else — a pipeline cannot write it.`;
    }
  }
  const { sheetOwnedRefusal } = await import("@/utils/sheets/owned.server");
  return sheetOwnedRefusal([{ schema: w.schema, table: w.table }]);
}

function loadStatements(w: LakeWrite, src: string, rows: number): string[] {
  const fq = `${qi(w.schema)}.${qi(w.table)}`;
  if (w.mode === "replace") return [`CREATE OR REPLACE TABLE ${fq} AS SELECT * FROM ${src}`];
  // An empty batch loads nothing and must not shape the table.
  if (!rows) return [];
  const create = `CREATE TABLE IF NOT EXISTS ${fq} AS SELECT * FROM ${src} WHERE false`;
  const insert = `INSERT INTO ${fq} BY NAME SELECT * FROM ${src}`;
  if (w.mode === "append") return [create, insert];
  if (!w.primaryKey.length) throw new Error(`Target "${w.label}": an upsert needs a primary key`);
  const keys = w.primaryKey.map(qi).join(", ");
  // The incoming keys are QUALIFIED. Bare, a key column the rows lack binds
  // to the target's own column instead, the subquery turns correlated, and
  // the DELETE matches every row (found building the gateway: a merge whose
  // frame had lost its key emptied the table). Qualified, it fails to bind.
  const incoming = w.primaryKey.map((k) => `_in.${qi(k)}`).join(", ");
  return [
    create,
    `DELETE FROM ${fq} WHERE (${keys}) IN (SELECT ${incoming} FROM ${src} AS _in)`,
    insert,
  ];
}

const CURSOR_TABLE = '"_agentswarms"."etl_cursors"';

/**
 * Load staged batches into their declared targets, and the run's cursors
 * with them, in one transaction. A write conflict is retried on a fresh
 * connection: the staged files are still there, and nothing has committed.
 */
export async function lakeCommit(args: {
  userId: string;
  sessionId: string;
  manifest: LakeManifest;
  loads: { id: string; batch: string; parts?: number; prefix?: boolean }[];
  cursors?: Record<string, string>;
  via: string;
  io?: StagingIo;
}): Promise<{ loads: { id: string; rows: number }[] }> {
  const { target, bucket } = storage();
  const url = args.io?.url ?? ((key: string) => `s3://${bucket}/${key}`);
  const plan: { id: string; w: LakeWrite; keys: string[]; src: string }[] = [];
  for (const l of args.loads) {
    const w = Object.hasOwn(args.manifest.writes, l.id) ? args.manifest.writes[l.id] : null;
    if (!w) throw new Error(`This run declared no lakehouse target "${l.id}"`);
    const keys = l.prefix
      ? await listedKeys(target, args.sessionId, l.batch, args.io)
      : stagedKeys(args.sessionId, l.batch, l.parts ?? 0);
    // A cluster that wrote no part files has nothing to load; the empty-batch
    // rule is the same one the staged-parts path follows.
    if (!keys.length) continue;
    plan.push({
      id: l.id,
      w,
      keys,
      src: `read_parquet([${keys.map((k) => sq(url(k))).join(", ")}])`,
    });
  }
  const cursorEntries = Object.entries(args.cursors ?? {}).filter(([, v]) => v != null);
  if (cursorEntries.length) {
    const c = args.manifest.cursors;
    if (!c) throw new Error("This run commits no cursors");
    for (const [node] of cursorEntries) {
      if (!c.nodes.includes(node)) throw new Error(`This run declared no cursor for "${node}"`);
    }
  }

  // Nothing to load and no position to move: no transaction, no audit event.
  if (!plan.length && !cursorEntries.length) return { loads: [] };

  const allowed = await accessibleSchemas(args.userId);
  for (const p of plan) {
    const why = await writeRefusal(args.userId, allowed, p.w);
    if (why) throw new Error(why);
  }

  let done: { id: string; rows: number }[] = [];
  for (let attempt = 0; ; attempt++) {
    const c = await lakehouseConnection();
    try {
      done = await withTimeout(c, async () => {
        const counted: { id: string; rows: number }[] = [];
        for (const p of plan) {
          const r = await (await c.run(`SELECT count(*) FROM ${p.src}`)).getRows();
          const rows = Number(r[0]?.[0] ?? 0);
          if (p.w.mode === "upsert" && rows) {
            const cols = (await (await c.run(`DESCRIBE SELECT * FROM ${p.src}`)).getRows()).map(
              (row) => String(row[0]).toLowerCase(),
            );
            const missing = p.w.primaryKey.filter((k) => !cols.includes(k.toLowerCase()));
            if (missing.length) {
              throw new Error(
                `Target "${p.w.label}": the rows to merge have no ${missing.map((m) => `"${m}"`).join(", ")} column, which its primary key needs — nothing was loaded`,
              );
            }
          }
          counted.push({ id: p.id, rows });
        }
        await c.run("BEGIN TRANSACTION");
        try {
          for (const [i, p] of plan.entries()) {
            for (const s of loadStatements(p.w, p.src, counted[i]!.rows)) await c.run(s);
          }
          if (cursorEntries.length && args.manifest.cursors) {
            await c.run('CREATE SCHEMA IF NOT EXISTS "_agentswarms"');
            await c.run(
              `CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (pipeline_id VARCHAR, node_id VARCHAR, cursor VARCHAR, updated_at TIMESTAMP)`,
            );
            const pid = args.manifest.cursors.pipelineId;
            for (const [node, value] of cursorEntries) {
              await c.run(
                `DELETE FROM ${CURSOR_TABLE} WHERE pipeline_id = ${sq(pid)} AND node_id = ${sq(node)}`,
              );
              await c.run(
                `INSERT INTO ${CURSOR_TABLE} VALUES (${sq(pid)}, ${sq(node)}, ${sq(String(value))}, now())`,
              );
            }
          }
          await c.run("COMMIT");
        } catch (e) {
          await c.run("ROLLBACK").catch(() => undefined);
          throw e;
        }
        return counted;
      });
      break;
    } catch (e) {
      const msg = redactLakehouseSecrets((e as Error).message);
      if (isWriteConflict(msg) && attempt < 4) continue;
      throw new Error(msg);
    } finally {
      c.closeSync();
    }
  }

  // The rows are committed; the staged copies have served their purpose. A
  // failed delete leaves rubbish for the sweep, never damage — but it is said
  // out loud, because a cleanup that fails quietly is a bucket that grows by
  // every run and nothing to read about why (R230: it did, and the catch hid
  // the reason).
  for (const p of plan) {
    for (const k of p.keys) {
      try {
        await (args.io?.remove ? args.io.remove(k) : s3DeleteObject(target, k));
      } catch (e) {
        console.warn(
          `[lakehouse] staged file ${k} was loaded but not deleted: ${(e as Error).message}; the session sweep will take it`,
        );
      }
    }
  }
  auditEvent({
    userId: args.userId,
    action: "lakehouse.sandbox_commit",
    resourceType: "lakehouse",
    resourceName: plan.map((p) => `${p.w.schema}.${p.w.table}`).join(", "),
    detail: {
      via: args.via,
      loads: done.map((d) => ({ id: d.id, rows: d.rows })),
      cursors: cursorEntries.length || undefined,
    },
  });
  return { loads: done };
}

/** The cursors that committed with this pipeline's last exactly-once load. */
export async function lakeCursors(manifest: LakeManifest): Promise<Record<string, string>> {
  if (!manifest.cursors) throw new Error("This run commits no cursors");
  const c = await lakehouseConnection();
  try {
    await c.run('CREATE SCHEMA IF NOT EXISTS "_agentswarms"');
    await c.run(
      `CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (pipeline_id VARCHAR, node_id VARCHAR, cursor VARCHAR, updated_at TIMESTAMP)`,
    );
    const rows = await (
      await c.run(
        `SELECT node_id, cursor FROM ${CURSOR_TABLE} WHERE pipeline_id = ${sq(manifest.cursors.pipelineId)}`,
      )
    ).getRows();
    const out: Record<string, string> = {};
    for (const [node, cur] of rows) {
      if (node != null && cur != null && manifest.cursors.nodes.includes(String(node))) {
        out[String(node)] = String(cur);
      }
    }
    return out;
  } finally {
    c.closeSync();
  }
}

/** Delete a session's staging, when it ends. */
export async function dropSessionStaging(sessionId: string): Promise<number> {
  const t = lakeTarget();
  if (!t) return 0;
  return s3DeletePrefix(t.target, stagingPrefix(sessionId));
}

/**
 * Delete staging no live session owns and nothing has touched for an hour:
 * what a crashed sandbox, or a delete that failed, left behind.
 */
export async function sweepSandboxStaging(liveSessionIds: Set<string>): Promise<number> {
  const t = lakeTarget();
  if (!t) return 0;
  const cutoff = Date.now() - 60 * 60_000;
  let n = 0;
  for (const obj of await s3ListKeys(t.target, STAGING_ROOT)) {
    const sid = obj.key.slice(STAGING_ROOT.length).split("/")[0] ?? "";
    if (liveSessionIds.has(sid.toLowerCase())) continue;
    if (obj.lastModified.getTime() > cutoff) continue;
    await s3DeleteObject(t.target, obj.key);
    n++;
  }
  return n;
}
