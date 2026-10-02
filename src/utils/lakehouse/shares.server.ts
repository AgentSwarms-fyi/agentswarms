// Sharing lakehouse tables outside the platform: the recipient's side of the
// Delta Sharing protocol. A token is bound to one share; what it can read is
// the share's tables, each served as a materialised, governed snapshot.
//
// Why a snapshot and not the lakehouse's own Parquet: DuckLake keeps deleted
// rows in the data files and marks them in delete files, so the raw files
// carry rows the table no longer has; and a presigned URL bypasses every
// policy, since nothing runs between the recipient and S3. So each read
// serves files written from a governed SELECT — the table's policy (rows,
// masks, tag rules) plus the share's own rule applied by the same rewrite
// every in-platform reader goes through, deletes already applied by the
// engine — under a prefix beside the lake's data path, keyed by the table's
// current file set and the policy, so an unchanged table is written once.
import { createHash } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DeltaSharingError,
  NDJSON_CONTENT_TYPE,
  deltaErrorBody,
  fileAction,
  hashShareToken,
  looksLikeShareToken,
  metaDataAction,
  ndjson,
  parseSharePath,
  protocolAction,
  readQueryBody,
  type ShareColumn,
  type SharePath,
} from "@/lib/deltaSharing";
import { auditEvent } from "@/utils/audit.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";
import { lakehouseConfig, lakehouseConnection, redactLakehouseSecrets } from "./core.server";
import { applyTablePolicies, loadPolicies, type TablePolicy } from "./policies.server";
import { presignS3Get, s3DeleteObject, s3ObjectSize, type S3Target } from "./presign.server";

// --- Rows ------------------------------------------------------------------------

export type ShareRow = { id: string; user_id: string; name: string; description: string | null };

export type ShareTableRow = {
  id: string;
  share_id: string;
  schema_name: string;
  table_name: string;
  shared_as: string;
  row_filter: string | null;
  masked_columns: string[];
  mask_style: "null" | "hash";
};

export type ShareSnapshotRow = {
  id: string;
  share_table_id: string;
  fingerprint: string;
  policy_hash: string;
  snapshot_id: string;
  prefix: string;
  files: { key: string; size: number; rows: number }[];
  columns: ShareColumn[];
  row_count: number;
  created_at: string;
};

export type ShareActor = {
  tokenId: string;
  label: string;
  recipientEmail: string | null;
  share: ShareRow;
};

const SHARE_TABLE_COLUMNS =
  "id, share_id, schema_name, table_name, shared_as, row_filter, masked_columns, mask_style";
const SNAPSHOT_COLUMNS =
  "id, share_table_id, fingerprint, policy_hash, snapshot_id, prefix, files, columns, row_count, created_at";

// --- Responses --------------------------------------------------------------------

export const shareJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

export const shareFail = (status: number, errorCode: string, message: string) =>
  shareJson(deltaErrorBody(errorCode, message), status);

export const shareNdjson = (actions: unknown[], headers: Record<string, string> = {}) =>
  new Response(ndjson(actions), {
    status: 200,
    headers: { "Content-Type": NDJSON_CONTENT_TYPE, ...headers },
  });

/** Run a handler; a DeltaSharingError becomes its body, anything else a redacted 500. */
export async function shareHandler(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DeltaSharingError) return shareFail(e.status, e.errorCode, e.message);
    const message = redactLakehouseSecrets((e as Error).message || "Internal error");
    console.error("[delta-sharing]", message);
    return shareFail(500, "INTERNAL_ERROR", message);
  }
}

export function sharePathOf(request: Request): SharePath {
  return parseSharePath(new URL(request.url).pathname);
}

const notFound = (what: string) =>
  new DeltaSharingError(404, "RESOURCE_DOES_NOT_EXIST", `${what} does not exist`);

// --- Authentication ---------------------------------------------------------------

export type ShareAuth = { ok: true; actor: ShareActor } | { ok: false; response: Response };

/**
 * Authenticate `Authorization: Bearer dss_...`. A token names one share;
 * revoked and expired tokens are refused, unknown ones rate limited so a
 * token cannot be guessed at speed, and every accepted call is counted so
 * the owner can see the share being used.
 */
export async function authenticateShare(request: Request): Promise<ShareAuth> {
  const raw = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const limit = envInt("SHARE_RATE_LIMIT_PER_MIN", 600);
  if (await rateLimitedGlobal("share", limit)) {
    return { ok: false, response: shareFail(429, "RATE_LIMITED", "Too many requests") };
  }
  const deny = (message: string) => ({
    ok: false as const,
    response: shareJson(deltaErrorBody("UNAUTHENTICATED", message), 401, {
      "WWW-Authenticate": 'Bearer realm="delta-sharing"',
    }),
  });
  if (!looksLikeShareToken(raw)) return deny("A share token is required");
  const hash = await hashShareToken(raw);
  const { data: tok } = await supabaseAdmin
    .from("lakehouse_share_tokens")
    .select("id, share_id, label, recipient_email, revoked_at, expires_at, use_count, created_by")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!tok) return deny("Invalid share token");
  const expired = tok.expires_at ? new Date(tok.expires_at).getTime() < Date.now() : false;
  if (tok.revoked_at || expired) {
    auditEvent({
      userId: tok.created_by,
      actorEmail: `share:${tok.label}`,
      action: "lakehouse.share.access.denied",
      resourceType: "lakehouse_share",
      resourceId: tok.share_id,
      detail: { reason: tok.revoked_at ? "revoked" : "expired", token_id: tok.id },
    });
    return deny(tok.revoked_at ? "This share token was revoked" : "This share token has expired");
  }
  const { data: share } = await supabaseAdmin
    .from("lakehouse_shares")
    .select("id, user_id, name, description")
    .eq("id", tok.share_id)
    .maybeSingle();
  if (!share) return deny("This share no longer exists");
  void supabaseAdmin
    .from("lakehouse_share_tokens")
    .update({ last_used_at: new Date().toISOString(), use_count: (tok.use_count ?? 0) + 1 })
    .eq("id", tok.id)
    .then(() => undefined);
  return {
    ok: true,
    actor: { tokenId: tok.id, label: tok.label, recipientEmail: tok.recipient_email, share },
  };
}

// --- Listing --------------------------------------------------------------------

export function shareItem(actor: ShareActor) {
  return { name: actor.share.name, id: actor.share.id };
}

/** The one share the token names; another name is a 404, never a hint. */
export function requireShare(actor: ShareActor, name: string | undefined): ShareRow {
  if (!name || name !== actor.share.name) throw notFound(`Share ${name ?? ""}`);
  return actor.share;
}

export async function shareTables(actor: ShareActor, schema?: string): Promise<ShareTableRow[]> {
  let q = supabaseAdmin
    .from("lakehouse_share_tables")
    .select(SHARE_TABLE_COLUMNS)
    .eq("share_id", actor.share.id)
    .order("schema_name")
    .order("shared_as");
  if (schema) q = q.eq("schema_name", schema);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ShareTableRow[];
}

export function tableItem(actor: ShareActor, t: ShareTableRow) {
  return {
    name: t.shared_as,
    schema: t.schema_name,
    share: actor.share.name,
    shareId: actor.share.id,
    id: t.id,
  };
}

export async function requireShareTable(
  actor: ShareActor,
  schema: string | undefined,
  table: string | undefined,
): Promise<ShareTableRow> {
  if (!schema || !table) throw notFound("Table");
  const { data } = await supabaseAdmin
    .from("lakehouse_share_tables")
    .select(SHARE_TABLE_COLUMNS)
    .eq("share_id", actor.share.id)
    .eq("schema_name", schema)
    .eq("shared_as", table)
    .maybeSingle();
  if (!data) throw notFound(`Table ${schema}.${table}`);
  return data as ShareTableRow;
}

// --- Policy -----------------------------------------------------------------------

export type SharePolicy = {
  row_filter: string | null;
  masked_columns: string[];
  mask_style: "null" | "hash";
};

/**
 * The share's rule on top of the table's policy, folded the way tag rules
 * are: filters AND, masks union, a blank beats a scramble. Null when
 * neither says anything, so an open table is read as it is.
 */
export function foldSharePolicy(args: {
  base: TablePolicy | null;
  share: SharePolicy;
}): SharePolicy | null {
  const filters = [args.base?.row_filter, args.share.row_filter]
    .map((f) => f?.trim())
    .filter((f): f is string => Boolean(f));
  const masks = [...new Set([...(args.base?.masked_columns ?? []), ...args.share.masked_columns])];
  if (!filters.length && !masks.length) return null;
  const styles = [
    ...(args.base?.masked_columns.length ? [args.base.mask_style] : []),
    ...(args.share.masked_columns.length ? [args.share.mask_style] : []),
  ];
  return {
    row_filter: filters.length ? filters.map((f) => `(${f})`).join(" AND ") : null,
    masked_columns: masks,
    mask_style: styles.includes("null") ? "null" : styles.includes("hash") ? "hash" : "null",
  };
}

// --- Storage ------------------------------------------------------------------------

/** The lake's S3 settings as a signing target, plus the bucket the data URL names. */
export function shareStorage(): { target: S3Target; bucket: string; shareUrl: string } {
  const cfg = lakehouseConfig();
  if (!cfg) throw new Error("The lakehouse is not configured");
  const m = /^s3a?:\/\/([^/]+)(?:\/(.*))?$/.exec(cfg.dataUrl);
  if (!m) throw new Error(`LAKEHOUSE_DATA_URL is not an s3:// URL: ${cfg.dataUrl}`);
  const bucket = m[1];
  // Beside the lake's data path, never inside it: DuckLake's orphan cleanup
  // removes what it does not track under its own prefix.
  const shareUrl = (process.env.SHARE_DATA_URL?.trim() || `s3://${bucket}/shares`).replace(
    /\/+$/,
    "",
  );
  const sm = /^s3a?:\/\/([^/]+)(?:\/(.*))?$/.exec(shareUrl);
  if (!sm) throw new Error(`SHARE_DATA_URL is not an s3:// URL: ${shareUrl}`);
  return {
    bucket: sm[1],
    shareUrl,
    target: {
      endpoint: cfg.s3.endpoint,
      publicEndpoint: process.env.LAKEHOUSE_S3_PUBLIC_ENDPOINT?.trim() || undefined,
      region: cfg.s3.region || "us-east-1",
      useSsl: cfg.s3.useSsl,
      urlStyle: cfg.s3.urlStyle === "path" ? "path" : "vhost",
      bucket: sm[1],
      accessKeyId: cfg.s3.keyId,
      secretAccessKey: cfg.s3.secret,
    },
  };
}

const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;
const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * What the table is made of right now: a hash of its data and delete files.
 * Unchanged files mean an unchanged table, whatever else moved in the lake.
 */
async function tableFingerprint(
  c: Awaited<ReturnType<typeof lakehouseConnection>>,
  schema: string,
  table: string,
): Promise<{ fingerprint: string; snapshotId: string }> {
  // Small writes stay inlined in the catalog until a flush; without one
  // the listing would miss them and the snapshot would be stale.
  await c.run("CALL ducklake_flush_inlined_data('lake')");
  const snap = await (
    await c.run("SELECT max(snapshot_id)::VARCHAR AS s FROM ducklake_snapshots('lake')")
  ).getRows();
  const snapshotId = String(snap[0]?.[0] ?? "0");
  const rows = await (
    await c.run(
      `SELECT data_file, delete_file FROM ducklake_list_files('lake', ${sq(table)}, schema => ${sq(schema)})`,
    )
  ).getRows();
  const listing = rows
    .map((r) => `${String(r[0] ?? "")}|${String(r[1] ?? "")}`)
    .sort()
    .join("\n");
  return {
    fingerprint: createHash("sha256").update(listing).digest("hex").slice(0, 16),
    snapshotId,
  };
}

async function currentSnapshot(
  shareTableId: string,
  fingerprint: string,
  policyHash: string,
): Promise<ShareSnapshotRow | null> {
  const { data } = await supabaseAdmin
    .from("lakehouse_share_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("share_table_id", shareTableId)
    .eq("fingerprint", fingerprint)
    .eq("policy_hash", policyHash)
    .maybeSingle();
  return (data as ShareSnapshotRow | null) ?? null;
}

/** Drop every snapshot of this table but `keepId`: rows and objects. Best effort. */
async function pruneSnapshots(shareTableId: string, keepId: string | null): Promise<void> {
  const { data } = await supabaseAdmin
    .from("lakehouse_share_snapshots")
    .select("id, files")
    .eq("share_table_id", shareTableId);
  const stale = (data ?? []).filter((s) => s.id !== keepId);
  if (!stale.length) return;
  let target: S3Target | null = null;
  try {
    target = shareStorage().target;
  } catch {
    target = null;
  }
  for (const s of stale) {
    for (const f of (s.files as { key: string }[]) ?? []) {
      if (!target) continue;
      try {
        await s3DeleteObject(target, f.key);
      } catch (e) {
        console.warn(`[delta-sharing] could not delete ${f.key}: ${(e as Error).message}`);
      }
    }
  }
  await supabaseAdmin
    .from("lakehouse_share_snapshots")
    .delete()
    .in(
      "id",
      stale.map((s) => s.id),
    );
}

/** Called when a shared table leaves a share: its snapshots go with it. */
export async function dropShareTableSnapshots(shareTableId: string): Promise<void> {
  await pruneSnapshots(shareTableId, null);
}

/**
 * The governed snapshot for this table under this recipient's policy —
 * the existing one when the table's files and the policy are unchanged,
 * otherwise written now: a governed SELECT copied to Parquet beside the
 * lake, its columns and row count recorded, older snapshots pruned.
 */
export async function ensureShareSnapshot(
  actor: ShareActor,
  st: ShareTableRow,
): Promise<ShareSnapshotRow> {
  const c = await lakehouseConnection();
  try {
    const { fingerprint, snapshotId } = await tableFingerprint(c, st.schema_name, st.table_name);
    const base =
      (
        await loadPolicies(
          [actor.share.user_id],
          [{ schema: st.schema_name, table: st.table_name }],
        )
      ).get(`${st.schema_name.toLowerCase()}.${st.table_name.toLowerCase()}`) ?? null;
    const folded = foldSharePolicy({
      base,
      share: {
        row_filter: st.row_filter,
        masked_columns: st.masked_columns ?? [],
        mask_style: st.mask_style,
      },
    });
    const reader = { id: actor.tokenId, email: actor.recipientEmail ?? `share:${actor.label}` };
    // A filter that names the reader (@me, @user_id) makes the snapshot per
    // token; one that does not is shared by every recipient of the share.
    const perReader = Boolean(folded?.row_filter && /@/.test(folded.row_filter));
    const policyHash = createHash("sha256")
      .update(JSON.stringify({ folded, reader: perReader ? reader.id : null }))
      .digest("hex")
      .slice(0, 16);

    const existing = await currentSnapshot(st.id, fingerprint, policyHash);
    if (existing) return existing;

    let sql = `SELECT * FROM ${qi(st.schema_name)}.${qi(st.table_name)}`;
    if (folded) {
      const policies = new Map<string, TablePolicy>([
        [
          `${st.schema_name.toLowerCase()}.${st.table_name.toLowerCase()}`,
          {
            id: `share:${st.id}`,
            schema_name: st.schema_name,
            table_name: st.table_name,
            row_filter: folded.row_filter,
            masked_columns: folded.masked_columns,
            mask_style: folded.mask_style,
          },
        ],
      ]);
      const rewrite = await applyTablePolicies(c, sql, policies, reader);
      if (!rewrite) throw new Error("The share's policy could not be applied; nothing was shared");
      sql = rewrite.sql;
    }

    const described = await (await c.run(`DESCRIBE ${sql}`)).getRows();
    const columns: ShareColumn[] = described.map((r) => ({
      name: String(r[0]),
      type: String(r[1]),
    }));
    const counted = await (await c.run(`SELECT count(*)::BIGINT FROM (${sql}) AS q`)).getRows();
    const rowCount = Number(counted[0]?.[0] ?? 0);

    const { target, shareUrl, bucket } = shareStorage();
    const prefix = `${shareUrl}/${st.id}/${fingerprint}-${policyHash}`;
    const key = `${prefix.slice(`s3://${bucket}/`.length)}/part-0.parquet`;
    const timeoutMs = envInt("SHARE_MATERIALIZE_TIMEOUT_MS", 600_000);
    const timer = setTimeout(() => c.interrupt(), timeoutMs);
    try {
      await c.run(
        `COPY (${sql}) TO ${sq(`${prefix}/part-0.parquet`)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
    } finally {
      clearTimeout(timer);
    }
    const size = (await s3ObjectSize(target, key)) ?? 0;

    const { data: inserted, error } = await supabaseAdmin
      .from("lakehouse_share_snapshots")
      .insert({
        share_table_id: st.id,
        fingerprint,
        policy_hash: policyHash,
        snapshot_id: snapshotId,
        prefix,
        files: [{ key, size, rows: rowCount }],
        columns,
        row_count: rowCount,
      })
      .select(SNAPSHOT_COLUMNS)
      .single();
    if (error) {
      // Two readers raced; the other one's row is the one to keep.
      const again = await currentSnapshot(st.id, fingerprint, policyHash);
      if (again) return again;
      throw new Error(`Could not record the share snapshot: ${error.message}`);
    }
    const row = inserted as ShareSnapshotRow;
    await pruneSnapshots(st.id, row.id);
    return row;
  } finally {
    c.closeSync();
  }
}

// --- Table endpoints ----------------------------------------------------------------

export async function tableVersion(actor: ShareActor, st: ShareTableRow): Promise<number> {
  const snap = await ensureShareSnapshot(actor, st);
  return Number(snap.snapshot_id) || 0;
}

export async function tableMetadata(actor: ShareActor, st: ShareTableRow) {
  const snap = await ensureShareSnapshot(actor, st);
  return {
    version: Number(snap.snapshot_id) || 0,
    actions: [
      protocolAction(),
      metaDataAction({
        id: st.id,
        name: st.shared_as,
        columns: snap.columns,
        numFiles: snap.files.length,
        size: snap.files.reduce((a, f) => a + f.size, 0),
      }),
    ],
  };
}

export async function queryShareTable(actor: ShareActor, st: ShareTableRow, body: unknown) {
  const hints = readQueryBody(body);
  const snap = await ensureShareSnapshot(actor, st);
  const { target } = shareStorage();
  const expires = envInt("SHARE_URL_EXPIRY_SECONDS", 3600);
  const expirationTimestamp = Date.now() + expires * 1000;
  const files = snap.files.map((f) =>
    fileAction({
      url: presignS3Get({ target, key: f.key, expiresSeconds: expires }),
      id: createHash("sha256").update(f.key).digest("hex").slice(0, 32),
      size: f.size,
      numRecords: f.rows,
      expirationTimestamp,
    }),
  );
  auditEvent({
    userId: actor.share.user_id,
    actorEmail: `share:${actor.label}`,
    action: "lakehouse.share.query",
    resourceType: "lakehouse_share",
    resourceId: actor.share.id,
    resourceName: `${actor.share.name}/${st.schema_name}/${st.shared_as}`,
    detail: {
      token_id: actor.tokenId,
      table: `${st.schema_name}.${st.table_name}`,
      version: Number(snap.snapshot_id) || 0,
      files: files.length,
      rows: snap.row_count,
      limit_hint: hints.limitHint,
      predicate_hints: hints.predicateHints.length,
    },
  });
  return {
    version: Number(snap.snapshot_id) || 0,
    actions: [
      protocolAction(),
      metaDataAction({
        id: st.id,
        name: st.shared_as,
        columns: snap.columns,
        numFiles: snap.files.length,
        size: snap.files.reduce((a, f) => a + f.size, 0),
      }),
      ...files,
    ],
  };
}
