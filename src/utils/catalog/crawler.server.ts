// Data Catalog crawlers.
//
// A crawl turns a source into a set of assets:
//   - warehouse/database sources: information_schema listing via the
//     existing driver layer, plus best-effort row-count estimates from
//     provider statistics (never full COUNT(*) scans);
//   - object storage sources: paginated ListObjectsV2, partition-aware
//     grouping (a folder of same-format files becomes one "dataset"
//     asset), then head-of-file sampling to infer columns for CSV/JSON.
// Column names matching common PII patterns are flagged so the catalog
// can surface classification at a glance. Crawls are bounded (object,
// sample and byte caps) so a huge bucket cannot wedge the server.
import { createHash } from "node:crypto";

import type { Database, Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { decryptJson } from "@/utils/providers/crypto.server";
import { resolveSecretRefsInObject } from "@/utils/secrets.server";
import { executeWarehouseQuery, listWarehouseTables } from "@/utils/warehouse/drivers.server";
import type { WarehouseConfig } from "@/utils/warehouse/types";
import {
  computeColumnStats,
  fileFormat,
  inferColumns,
  listObjects,
  sampleObject,
  type InferredColumn,
  type ObjectStoreConfig,
  type StoredObject,
} from "./objectStore.server";

const MAX_OBJECTS = 2000;
const MAX_SAMPLES = 20;
const SAMPLE_BYTES = 128 * 1024;
/** Warehouse tables profiled per crawl (one LIMIT-200 preview query each). */
const PROFILE_TABLE_CAP = 15;
const PROFILE_ROWS = 200;

export type CatalogColumn = {
  name: string;
  type: string;
  sample?: string;
  pii?: boolean;
  /** Curation/AI documentation — preserved across re-crawls. */
  description?: string;
  /** Sample-based profile stats. */
  null_pct?: number;
  distinct_count?: number;
  min?: number;
  max?: number;
};

/** Fingerprint of the column set, for schema-drift detection. */
export function schemaHash(columns: { name: string; type: string }[]): string {
  const canon = [...columns]
    .map((c) => `${c.name}:${c.type}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

export type CrawledAsset = {
  asset_type: "table" | "view" | "file" | "dataset";
  schema_name: string | null;
  name: string;
  fqn: string;
  columns: CatalogColumn[];
  row_count: number | null;
  size_bytes: number | null;
  format: string | null;
  file_count: number | null;
  pii: boolean;
};

export type CrawlChanges = {
  added: string[];
  removed: string[];
  changed: string[];
};

export type CrawlStats = {
  assets: number;
  columns: number;
  sampled: number;
  duration_ms: number;
  changes: CrawlChanges;
};

// ── PII classification (column-name heuristics) ──────────────────────────

const PII_RE =
  /(^|[_\s-])(email|e[-_]?mail|phone|mobile|ssn|social[-_]?security|passport|dob|birth[-_]?date|birthday|address|street|zip[-_]?code|postal[-_]?code|salary|income|iban|swift|credit[-_]?card|card[-_]?number|cvv|tax[-_]?id|national[-_]?id|driver[-_]?license|first[-_]?name|last[-_]?name|full[-_]?name|surname|gender|ip[-_]?address)([_\s-]|$)/i;

export function isPiiColumn(name: string): boolean {
  return PII_RE.test(name);
}

function classify(columns: { name: string; type: string; sample?: string }[]): {
  columns: CatalogColumn[];
  pii: boolean;
} {
  let pii = false;
  const out = columns.map((c) => {
    const hit = isPiiColumn(c.name);
    if (hit) pii = true;
    return hit ? { ...c, pii: true } : { ...c };
  });
  return { columns: out, pii };
}

// ── Warehouse crawling ───────────────────────────────────────────────────

/** Best-effort row estimates from provider stats — one query, never COUNT(*). */
async function rowEstimates(config: WarehouseConfig): Promise<Map<string, number>> {
  const sqlByProvider: Partial<Record<WarehouseConfig["provider"], string>> = {
    postgres: `SELECT n.nspname AS s, c.relname AS t, GREATEST(c.reltuples, 0)::bigint AS rc
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema')`,
    mysql: `SELECT table_schema AS s, table_name AS t, table_rows AS rc
      FROM information_schema.tables WHERE table_schema = DATABASE()`,
    snowflake: `SELECT table_schema AS s, table_name AS t, row_count AS rc
      FROM information_schema.tables WHERE table_type = 'BASE TABLE'`,
    redshift: `SELECT "schema" AS s, "table" AS t, tbl_rows AS rc FROM svv_table_info`,
    azure_synapse: `SELECT s.name AS s, t.name AS t, SUM(p.rows) AS rc
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      GROUP BY s.name, t.name`,
  };
  const sql = sqlByProvider[config.provider];
  const map = new Map<string, number>();
  if (!sql) return map;
  try {
    const res = await executeWarehouseQuery(config, sql, 5000);
    for (const r of res.rows) {
      const n = Number(r.rc ?? r.RC);
      if (Number.isFinite(n)) {
        map.set(`${String(r.s ?? r.S)}.${String(r.t ?? r.T)}`.toLowerCase(), Math.round(n));
      }
    }
  } catch {
    // Statistics are optional — schema listing alone is still a valid crawl.
  }
  return map;
}

/** Provider-correct `SELECT * … LIMIT n` for the sample-based profiler. */
function previewSql(provider: WarehouseConfig["provider"], schema: string, table: string): string {
  switch (provider) {
    case "mysql":
      return `SELECT * FROM \`${schema}\`.\`${table}\` LIMIT ${PROFILE_ROWS}`;
    case "bigquery":
      return `SELECT * FROM \`${schema}.${table}\` LIMIT ${PROFILE_ROWS}`;
    case "databricks":
      return `SELECT * FROM \`${schema}\`.\`${table}\` LIMIT ${PROFILE_ROWS}`;
    case "azure_synapse":
      return `SELECT TOP ${PROFILE_ROWS} * FROM [${schema}].[${table}]`;
    default: // postgres, redshift, snowflake
      return `SELECT * FROM "${schema}"."${table}" LIMIT ${PROFILE_ROWS}`;
  }
}

export async function crawlWarehouse(
  config: WarehouseConfig,
): Promise<{ assets: CrawledAsset[]; sampled: number }> {
  const [tables, estimates] = await Promise.all([listWarehouseTables(config), rowEstimates(config)]);
  const assets = tables.map((t) => {
    const { columns, pii } = classify(t.columns.map((c) => ({ name: c.name, type: c.type })));
    return {
      asset_type: "table" as const,
      schema_name: t.schema || null,
      name: t.name,
      fqn: t.schema ? `${t.schema}.${t.name}` : t.name,
      columns,
      row_count: estimates.get(`${t.schema}.${t.name}`.toLowerCase()) ?? null,
      size_bytes: null,
      format: null,
      file_count: null,
      pii,
    };
  });

  // Sample-based column profiling: one cheap preview query per table,
  // biggest tables first, bounded so a large warehouse can't stall a crawl.
  let sampled = 0;
  const ranked = [...assets].sort((a, b) => (b.row_count ?? 0) - (a.row_count ?? 0));
  for (const asset of ranked.slice(0, PROFILE_TABLE_CAP)) {
    try {
      const res = await executeWarehouseQuery(
        config,
        previewSql(config.provider, asset.schema_name ?? "", asset.name),
        PROFILE_ROWS,
      );
      if (res.rows.length === 0) continue;
      const byLower = new Map(Object.keys(res.rows[0]).map((k) => [k.toLowerCase(), k]));
      for (const col of asset.columns) {
        const key = byLower.get(col.name.toLowerCase());
        if (!key) continue;
        const stats = computeColumnStats(res.rows, key);
        col.sample = stats.sample;
        col.null_pct = stats.null_pct;
        col.distinct_count = stats.distinct_count;
        if (stats.min !== undefined) col.min = stats.min;
        if (stats.max !== undefined) col.max = stats.max;
      }
      sampled++;
    } catch {
      // Profiling is best-effort — schema metadata alone is a valid crawl.
    }
  }
  return { assets, sampled };
}

// ── Object storage crawling ──────────────────────────────────────────────

type ObjectGroup = {
  dir: string;
  format: string | null;
  objects: StoredObject[];
};

/**
 * Partition-aware grouping: files sharing a directory AND format collapse
 * into one "dataset" asset (the Glue-crawler convention for partitioned
 * data lakes); lone files become individual assets.
 */
export function groupObjects(objects: StoredObject[]): ObjectGroup[] {
  const groups = new Map<string, ObjectGroup>();
  for (const o of objects) {
    const slash = o.key.lastIndexOf("/");
    const dir = slash === -1 ? "" : o.key.slice(0, slash);
    const format = fileFormat(o.key);
    const gk = `${dir} ${format ?? "other"}`;
    const g = groups.get(gk) ?? { dir, format, objects: [] };
    g.objects.push(o);
    groups.set(gk, g);
  }
  return [...groups.values()];
}

/** Rough row estimate for a text file: bytes-per-line from the sample. */
function estimateRows(sample: Buffer, totalBytes: number, format: string | null): number | null {
  if (format !== "csv" && format !== "ndjson") return null;
  const text = sample.toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim() !== "").length;
  if (lines < 2) return null;
  const bytesPerLine = sample.length / lines;
  const dataRows = Math.round(totalBytes / bytesPerLine) - (format === "csv" ? 1 : 0);
  return Math.max(dataRows, 0);
}

/** Prior crawl state for incremental sampling: fqn → reusable metadata. */
export type PriorAssets = Map<string, { columns: CatalogColumn[]; row_count: number | null }>;

export async function crawlObjectStorage(
  cfg: ObjectStoreConfig,
  prior?: PriorAssets,
  /** Objects unchanged since this ISO timestamp reuse prior schema without re-sampling. */
  since?: string | null,
): Promise<{ assets: CrawledAsset[]; sampled: number }> {
  const objects = await listObjects(cfg, MAX_OBJECTS);
  const groups = groupObjects(objects);
  // Sample the biggest groups/files first — they carry the real datasets.
  const ranked = [...groups].sort(
    (a, b) =>
      b.objects.reduce((s, o) => s + o.size, 0) - a.objects.reduce((s, o) => s + o.size, 0),
  );
  const sampleBudget = new Set(ranked.slice(0, MAX_SAMPLES).map((g) => g));

  const groupFqn = (g: ObjectGroup) =>
    g.objects.length > 1 && g.format !== null ? `${g.dir || "."}/*.${g.format}` : g.objects[0].key;
  const unchangedSince = (g: ObjectGroup) =>
    Boolean(since) && g.objects.every((o) => o.last_modified !== "" && o.last_modified <= since!);

  let sampled = 0;
  const assets: CrawledAsset[] = [];
  for (const g of groups) {
    const totalSize = g.objects.reduce((s, o) => s + o.size, 0);
    const isDataset = g.objects.length > 1 && g.format !== null;
    // Sample the largest object of the group for schema inference —
    // unless the group is unchanged since the last crawl and we already
    // hold its inferred schema (incremental crawl: no GETs re-issued).
    let inferred: InferredColumn[] = [];
    let rowEstimate: number | null = null;
    const canInfer = g.format === "csv" || g.format === "json" || g.format === "ndjson";
    const reuse = canInfer && unchangedSince(g) ? prior?.get(groupFqn(g)) : undefined;
    if (reuse && reuse.columns.length > 0) {
      inferred = reuse.columns;
      rowEstimate = reuse.row_count;
    } else if (canInfer && sampleBudget.has(g) && sampled < MAX_SAMPLES) {
      const biggest = [...g.objects].sort((a, b) => b.size - a.size)[0];
      try {
        const buf = await sampleObject(cfg, biggest.key, SAMPLE_BYTES);
        inferred = inferColumns(g.format, buf);
        const perFile = estimateRows(buf, biggest.size, g.format);
        if (perFile !== null) {
          // Scale the per-byte density across the whole group.
          rowEstimate = Math.round((perFile / Math.max(biggest.size, 1)) * totalSize);
        }
        sampled++;
      } catch {
        // Sampling is best-effort; the asset still gets listed.
      }
    }
    const { columns, pii } = classify(inferred);

    if (isDataset) {
      const name = g.dir === "" ? `*.${g.format}` : (g.dir.split("/").pop() ?? g.dir);
      assets.push({
        asset_type: "dataset",
        schema_name: g.dir || null,
        name,
        fqn: `${g.dir || "."}/*.${g.format}`,
        columns,
        row_count: rowEstimate,
        size_bytes: totalSize,
        format: g.format,
        file_count: g.objects.length,
        pii,
      });
    } else {
      // Non-dataset groups are lone files (or same-dir files of unknown
      // format, which never have inferred columns anyway).
      for (const o of g.objects) {
        const single = g.objects.length === 1;
        assets.push({
          asset_type: "file",
          schema_name: g.dir || null,
          name: o.key.split("/").pop() ?? o.key,
          fqn: o.key,
          columns: single ? columns : [],
          row_count: single ? rowEstimate : null,
          size_bytes: o.size,
          format: g.format,
          file_count: null,
          pii: single ? pii : false,
        });
      }
    }
  }
  return { assets, sampled };
}

// ── Persistence ──────────────────────────────────────────────────────────

export type ExistingAsset = {
  id: string;
  fqn: string;
  columns: CatalogColumn[];
  row_count: number | null;
  schema_hash: string | null;
};

export async function loadExistingAssets(sourceId: string): Promise<ExistingAsset[]> {
  const { data, error } = await supabaseAdmin
    .from("catalog_assets")
    .select("id, fqn, columns, row_count, schema_hash")
    .eq("source_id", sourceId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    columns: (Array.isArray(r.columns) ? r.columns : []) as CatalogColumn[],
  }));
}

/**
 * Upsert crawled assets and remove ones that disappeared from the source,
 * returning what changed (for drift notifications). Curation — description,
 * tags, owner, status — is NOT in the upsert payload, and per-column
 * descriptions (AI- or user-written) are merged forward, so documentation
 * survives re-crawls.
 */
export async function persistAssets(
  userId: string,
  sourceId: string,
  assets: CrawledAsset[],
  existing: ExistingAsset[],
): Promise<CrawlChanges> {
  const now = new Date().toISOString();
  const existingByFqn = new Map(existing.map((e) => [e.fqn, e]));

  const changes: CrawlChanges = { added: [], removed: [], changed: [] };
  const rows = assets.map((a) => {
    const prev = existingByFqn.get(a.fqn);
    // Carry column documentation forward onto the fresh crawl result.
    if (prev) {
      const prevDesc = new Map(
        prev.columns.filter((c) => c.description).map((c) => [c.name, c.description!]),
      );
      for (const col of a.columns) {
        const d = prevDesc.get(col.name);
        if (d && !col.description) col.description = d;
      }
    }
    const hash = schemaHash(a.columns);
    if (!prev) changes.added.push(a.fqn);
    else if (prev.schema_hash && prev.schema_hash !== hash) changes.changed.push(a.fqn);
    return {
      user_id: userId,
      source_id: sourceId,
      asset_type: a.asset_type,
      schema_name: a.schema_name,
      name: a.name,
      fqn: a.fqn,
      columns: a.columns as unknown as Json,
      row_count: a.row_count,
      size_bytes: a.size_bytes,
      format: a.format,
      file_count: a.file_count,
      pii: a.pii,
      schema_hash: hash,
      last_crawled_at: now,
    };
  });

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("catalog_assets")
      .upsert(rows.slice(i, i + CHUNK), { onConflict: "source_id,fqn" });
    if (error) throw new Error(error.message);
  }

  // Reconcile deletions locally — a NOT IN () URL filter would overflow.
  const keep = new Set(assets.map((a) => a.fqn));
  const stale = existing.filter((e) => !keep.has(e.fqn));
  changes.removed = stale.map((e) => e.fqn);
  for (let i = 0; i < stale.length; i += 100) {
    await supabaseAdmin
      .from("catalog_assets")
      .delete()
      .in(
        "id",
        stale.slice(i, i + 100).map((e) => e.id),
      );
  }
  return changes;
}

/** Resolve {{secret:NAME}} refs and decrypt a stored bucket config. */
export async function loadStorageConfig(
  userId: string,
  source: { credentials: Json | null; name: string },
): Promise<ObjectStoreConfig> {
  const enc = source.credentials as { ciphertext?: string; iv?: string } | null;
  if (!enc?.ciphertext || !enc?.iv) {
    throw new Error(`Source "${source.name}" has no stored credentials`);
  }
  const cfg = await decryptJson<ObjectStoreConfig>(enc.ciphertext, enc.iv);
  return (await resolveSecretRefsInObject(
    userId,
    cfg as unknown as Record<string, unknown>,
  )) as unknown as ObjectStoreConfig;
}

export type CatalogSourceRow = Database["public"]["Tables"]["catalog_sources"]["Row"];

/** Run a full crawl for a source row, updating its status/stats around it. */
export async function runCrawl(
  userId: string,
  source: CatalogSourceRow,
  loadWarehouseConfig: (connectionId: string) => Promise<WarehouseConfig>,
  decryptStorageConfig: (source: CatalogSourceRow) => Promise<ObjectStoreConfig>,
): Promise<CrawlStats> {
  const started = Date.now();
  await supabaseAdmin
    .from("catalog_sources")
    .update({ status: "crawling", last_error: null, updated_at: new Date().toISOString() })
    .eq("id", source.id);
  try {
    const existing = await loadExistingAssets(source.id);
    let assets: CrawledAsset[];
    let sampled = 0;
    if (source.kind === "warehouse") {
      if (!source.connection_id) throw new Error("Source has no linked connection");
      const config = await loadWarehouseConfig(source.connection_id);
      const res = await crawlWarehouse(config);
      assets = res.assets;
      sampled = res.sampled;
    } else {
      const cfg = await decryptStorageConfig(source);
      const prior: PriorAssets = new Map(
        existing.map((e) => [e.fqn, { columns: e.columns, row_count: e.row_count }]),
      );
      const res = await crawlObjectStorage(cfg, prior, source.last_crawl_at);
      assets = res.assets;
      sampled = res.sampled;
    }
    const changes = await persistAssets(userId, source.id, assets, existing);
    const stats: CrawlStats = {
      assets: assets.length,
      columns: assets.reduce((s, a) => s + a.columns.length, 0),
      sampled,
      duration_ms: Date.now() - started,
      changes,
    };
    auditEvent({
      userId,
      action: "catalog.crawl",
      resourceType: "catalog_source",
      resourceName: source.name,
      resourceId: source.id,
      detail: {
        assets: stats.assets,
        added: changes.added.length,
        removed: changes.removed.length,
        changed: changes.changed.length,
      },
    });
    await supabaseAdmin
      .from("catalog_sources")
      .update({
        status: "ready",
        last_crawl_at: new Date().toISOString(),
        last_error: null,
        crawl_stats: stats as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id);
    return stats;
  } catch (e) {
    await supabaseAdmin
      .from("catalog_sources")
      .update({
        status: "error",
        last_error: (e as Error).message.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id);
    throw e;
  }
}
