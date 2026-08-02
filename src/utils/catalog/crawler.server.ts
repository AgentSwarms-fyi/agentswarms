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
import { isBlockedAlways } from "@/utils/ssrfGuard.server";
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
  /** Source-of-truth comment ingested from the external catalog (e.g. Unity
   *  Catalog column comment). Crawler-owned; refreshed each crawl. */
  comment?: string;
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
  /** External-catalog table comment (e.g. Unity Catalog). Seeds description on
   *  first discovery only — never overwrites user/AI curation on re-crawl. */
  description?: string | null;
  /** External-catalog tags (e.g. Unity Catalog table tags). Seeds tags on
   *  first discovery only. */
  tags?: string[];
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

// The heuristic itself lives in lib/piiHeuristic so the catalog UI and this
// crawler cannot drift apart; this file used to carry its own copy.
import { isPiiColumnName } from "@/lib/piiHeuristic";

export const isPiiColumn = isPiiColumnName;

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

type UcMetadata = {
  tableComment: Map<string, string>; // "schema.table" → comment
  columnComment: Map<string, string>; // "schema.table.column" → comment
  tableTags: Map<string, string[]>; // "schema.table" → ["name:value", …]
};

/**
 * Ingest external-catalog metadata (table/column comments + table tags) from a
 * Databricks Unity Catalog connection's information_schema. Each query is
 * best-effort: a missing view or denied permission yields no enrichment, never
 * a failed crawl.
 *
 * NOTE: unverified against a live Unity Catalog workspace — the SQL targets the
 * documented UC information_schema surface and degrades gracefully if it differs.
 */
async function fetchUnityCatalogMetadata(config: WarehouseConfig): Promise<UcMetadata> {
  const meta: UcMetadata = {
    tableComment: new Map(),
    columnComment: new Map(),
    tableTags: new Map(),
  };
  const g = (row: Record<string, unknown>, k: string) => row[k] ?? row[k.toUpperCase()];
  const key = (s: unknown, t: unknown) =>
    `${String(s ?? "").toLowerCase()}.${String(t ?? "").toLowerCase()}`;

  try {
    const r = await executeWarehouseQuery(
      config,
      `SELECT table_schema, table_name, comment FROM information_schema.tables WHERE comment IS NOT NULL`,
      5000,
    );
    for (const row of r.rows) {
      const c = String(g(row, "comment") ?? "").trim();
      if (c) meta.tableComment.set(key(g(row, "table_schema"), g(row, "table_name")), c);
    }
  } catch {
    /* no table comments available */
  }
  try {
    const r = await executeWarehouseQuery(
      config,
      `SELECT table_schema, table_name, column_name, comment FROM information_schema.columns WHERE comment IS NOT NULL`,
      50000,
    );
    for (const row of r.rows) {
      const c = String(g(row, "comment") ?? "").trim();
      if (c) {
        meta.columnComment.set(
          `${key(g(row, "table_schema"), g(row, "table_name"))}.${String(g(row, "column_name") ?? "").toLowerCase()}`,
          c,
        );
      }
    }
  } catch {
    /* no column comments available */
  }
  try {
    const r = await executeWarehouseQuery(
      config,
      `SELECT schema_name, table_name, tag_name, tag_value FROM information_schema.table_tags`,
      50000,
    );
    for (const row of r.rows) {
      const name = String(g(row, "tag_name") ?? "").trim();
      if (!name) continue;
      const val = String(g(row, "tag_value") ?? "").trim();
      const tag = val ? `${name}:${val}` : name;
      const k = key(g(row, "schema_name"), g(row, "table_name"));
      const arr = meta.tableTags.get(k) ?? [];
      if (!arr.includes(tag)) arr.push(tag);
      meta.tableTags.set(k, arr);
    }
  } catch {
    /* no tags available */
  }
  return meta;
}

export async function crawlWarehouse(
  config: WarehouseConfig,
): Promise<{ assets: CrawledAsset[]; sampled: number }> {
  const [tables, estimates] = await Promise.all([
    listWarehouseTables(config),
    rowEstimates(config),
  ]);
  const assets: CrawledAsset[] = tables.map((t) => {
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

  // Unity Catalog enrichment (Databricks): fold table/column comments + table
  // tags onto the crawled assets. Comments/tags seed catalog metadata but never
  // overwrite user curation (see persistAssets).
  if (config.provider === "databricks") {
    try {
      const uc = await fetchUnityCatalogMetadata(config);
      for (const a of assets) {
        const k = `${a.schema_name ?? ""}.${a.name}`.toLowerCase();
        const tc = uc.tableComment.get(k);
        if (tc) a.description = tc;
        const tags = uc.tableTags.get(k);
        if (tags && tags.length) a.tags = tags;
        for (const col of a.columns) {
          const cc = uc.columnComment.get(`${k}.${col.name.toLowerCase()}`);
          if (cc) col.comment = cc;
        }
      }
    } catch {
      /* enrichment is optional — a plain crawl is still valid */
    }
  }

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
    (a, b) => b.objects.reduce((s, o) => s + o.size, 0) - a.objects.reduce((s, o) => s + o.size, 0),
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
  description: string | null;
  tags: string[];
};

export async function loadExistingAssets(sourceId: string): Promise<ExistingAsset[]> {
  const { data, error } = await supabaseAdmin
    .from("catalog_assets")
    .select("id, fqn, columns, row_count, schema_hash, description, tags")
    .eq("source_id", sourceId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    columns: (Array.isArray(r.columns) ? r.columns : []) as CatalogColumn[],
    description: r.description ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
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
      // External-catalog metadata seeds description/tags on FIRST discovery
      // only; on re-crawl we write the existing (possibly user-curated) values
      // back unchanged, so curation is never clobbered.
      description: prev ? prev.description : (a.description ?? null),
      tags: prev ? prev.tags : (a.tags ?? []),
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

type LineageEdge = {
  upstream_fqn: string;
  downstream_fqn: string;
  upstream_column?: string | null;
  downstream_column?: string | null;
};

/**
 * Read real upstream→downstream lineage from Databricks Unity Catalog system
 * tables (system.access.column_lineage for column-level, table_lineage for the
 * rest). Best-effort — the `system` catalog is often not granted, in which case
 * this returns nothing and the crawl proceeds.
 *
 * NOTE: unverified against a live Unity Catalog workspace.
 */
async function fetchDatabricksLineage(config: WarehouseConfig): Promise<LineageEdge[]> {
  const edges: LineageEdge[] = [];
  const seen = new Set<string>();
  const g = (row: Record<string, unknown>, k: string) => row[k] ?? row[k.toUpperCase()];
  const add = (uf: unknown, df: unknown, uc: unknown, dc: unknown) => {
    const u = String(uf ?? "").toLowerCase();
    const d = String(df ?? "").toLowerCase();
    if (!u || !d || u === d) return;
    const ucv = uc ? String(uc) : null;
    const dcv = dc ? String(dc) : null;
    const key = `${u}|${d}|${ucv ?? ""}|${dcv ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      upstream_fqn: u,
      downstream_fqn: d,
      upstream_column: ucv,
      downstream_column: dcv,
    });
  };
  try {
    const r = await executeWarehouseQuery(
      config,
      `SELECT DISTINCT source_table_full_name, source_column_name, target_table_full_name, target_column_name
       FROM system.access.column_lineage
       WHERE source_table_full_name IS NOT NULL AND target_table_full_name IS NOT NULL`,
      20000,
    );
    for (const row of r.rows) {
      add(
        g(row, "source_table_full_name"),
        g(row, "target_table_full_name"),
        g(row, "source_column_name"),
        g(row, "target_column_name"),
      );
    }
  } catch {
    /* column lineage unavailable */
  }
  try {
    const r = await executeWarehouseQuery(
      config,
      `SELECT DISTINCT source_table_full_name, target_table_full_name
       FROM system.access.table_lineage
       WHERE source_table_full_name IS NOT NULL AND target_table_full_name IS NOT NULL`,
      20000,
    );
    for (const row of r.rows) {
      add(g(row, "source_table_full_name"), g(row, "target_table_full_name"), null, null);
    }
  } catch {
    /* table lineage unavailable */
  }
  return edges.slice(0, 5000);
}

/** Replace a source's stored lineage with a freshly-read set. */
async function persistLineage(
  userId: string,
  sourceId: string,
  edges: LineageEdge[],
): Promise<void> {
  await supabaseAdmin.from("catalog_lineage").delete().eq("source_id", sourceId);
  if (edges.length === 0) return;
  const rows = edges.map((e) => ({
    user_id: userId,
    source_id: sourceId,
    upstream_fqn: e.upstream_fqn,
    downstream_fqn: e.downstream_fqn,
    upstream_column: e.upstream_column ?? null,
    downstream_column: e.downstream_column ?? null,
    source_system: "databricks",
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await supabaseAdmin.from("catalog_lineage").insert(rows.slice(i, i + 500));
  }
}

/** Run a full crawl for a source row, updating its status/stats around it. */
// ── Iceberg REST catalog crawling ────────────────────────────────────────
// Metadata-only connector for an Apache Iceberg REST catalog (Polaris, Unity
// Catalog's Iceberg REST endpoint, Nessie, Gravitino, Lakekeeper, Tabular…).
// Lists namespaces + tables and reads each table's current schema; querying the
// data itself is done via an engine (Trino/Athena), not here.

export type IcebergRestConfig = { uri: string; warehouse?: string; token?: string };

const ICEBERG_MAX_NAMESPACES = 300;
const ICEBERG_MAX_TABLES = 1000;

/** Reject cloud-metadata / link-local hosts (private/VPC catalogs stay allowed). */
function assertIcebergHostAllowed(uri: string): string {
  let host: string;
  try {
    host = new URL(uri).hostname;
  } catch {
    throw new Error("Iceberg: invalid catalog URI");
  }
  if (isBlockedAlways(host)) throw new Error("Iceberg: refusing to connect to a blocked host");
  return host;
}

async function icebergGet<T>(base: string, path: string, token?: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: token
      ? { Accept: "application/json", Authorization: `Bearer ${token}` }
      : { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Iceberg REST ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Connectivity + auth probe used before a source is stored. */
export async function testIcebergCatalog(cfg: IcebergRestConfig): Promise<void> {
  assertIcebergHostAllowed(cfg.uri);
  const base = cfg.uri.replace(/\/+$/, "");
  const q = cfg.warehouse ? `?warehouse=${encodeURIComponent(cfg.warehouse)}` : "";
  await icebergGet(base, `/v1/config${q}`, cfg.token);
}

type IcebergField = { id?: number; name: string; type: unknown; required?: boolean; doc?: string };
type IcebergSchema = { "schema-id"?: number; fields?: IcebergField[] };
type IcebergTableResp = {
  metadata?: {
    schemas?: IcebergSchema[];
    "current-schema-id"?: number;
    schema?: IcebergSchema;
    "current-snapshot-id"?: number;
    snapshots?: { "snapshot-id": number; summary?: Record<string, string> }[];
  };
};

/** Iceberg type → a display string (nested struct/list/map collapse to a tag). */
function icebergTypeName(t: unknown): string {
  if (typeof t === "string") return t;
  if (t && typeof t === "object") return (t as { type?: string }).type ?? "struct";
  return "unknown";
}

function icebergTableToAsset(
  ns: string[],
  name: string,
  resp: IcebergTableResp,
): CrawledAsset | null {
  const md = resp.metadata;
  if (!md) return null;
  const schema =
    md.schemas?.find((s) => s["schema-id"] === md["current-schema-id"]) ??
    md.schemas?.[0] ??
    md.schema;
  const fields = schema?.fields ?? [];
  const { columns, pii } = classify(
    fields.map((f) => ({ name: f.name, type: icebergTypeName(f.type) })),
  );
  for (const f of fields) {
    if (f.doc) {
      const col = columns.find((c) => c.name === f.name);
      if (col) col.comment = f.doc;
    }
  }
  const schemaName = ns.join(".");
  let row_count: number | null = null;
  let size_bytes: number | null = null;
  const snap = md.snapshots?.find((s) => s["snapshot-id"] === md["current-snapshot-id"]);
  if (snap?.summary) {
    const rec = Number(snap.summary["total-records"]);
    if (Number.isFinite(rec)) row_count = rec;
    const sz = Number(snap.summary["total-files-size"]);
    if (Number.isFinite(sz)) size_bytes = sz;
  }
  return {
    asset_type: "table",
    schema_name: schemaName || null,
    name,
    fqn: schemaName ? `${schemaName}.${name}` : name,
    columns,
    row_count,
    size_bytes,
    format: "iceberg",
    file_count: null,
    pii,
  };
}

export async function crawlIcebergRest(
  cfg: IcebergRestConfig,
): Promise<{ assets: CrawledAsset[]; sampled: number }> {
  assertIcebergHostAllowed(cfg.uri);
  const base = cfg.uri.replace(/\/+$/, "");
  const token = cfg.token;

  // Some catalogs (Polaris/Unity) return a routing `prefix` from /v1/config that
  // must be inserted into subsequent paths.
  let prefix = "";
  try {
    const q = cfg.warehouse ? `?warehouse=${encodeURIComponent(cfg.warehouse)}` : "";
    const conf = await icebergGet<{
      overrides?: Record<string, string>;
      defaults?: Record<string, string>;
    }>(base, `/v1/config${q}`, token);
    prefix = conf.overrides?.prefix || conf.defaults?.prefix || "";
  } catch {
    /* config is optional on some catalogs */
  }
  const pfx = prefix ? `/${prefix.replace(/^\/|\/$/g, "")}` : "";
  // Multi-level namespaces are joined by the unit-separator (0x1F) in the path.
  const nsPath = (levels: string[]) => levels.map(encodeURIComponent).join("%1F");

  // Breadth-first namespace discovery (bounded).
  const allNs: string[][] = [];
  const queue: (string[] | null)[] = [null];
  const seen = new Set<string>();
  while (queue.length && allNs.length < ICEBERG_MAX_NAMESPACES) {
    const parent = queue.shift() ?? null;
    const parentQ = parent ? `?parent=${nsPath(parent)}` : "";
    let listed: { namespaces?: string[][] };
    try {
      listed = await icebergGet(base, `/v1${pfx}/namespaces${parentQ}`, token);
    } catch {
      continue;
    }
    for (const ns of listed.namespaces ?? []) {
      const key = ns.join("");
      if (seen.has(key)) continue;
      seen.add(key);
      allNs.push(ns);
      queue.push(ns);
      if (allNs.length >= ICEBERG_MAX_NAMESPACES) break;
    }
  }

  const assets: CrawledAsset[] = [];
  for (const ns of allNs) {
    if (assets.length >= ICEBERG_MAX_TABLES) break;
    let tablesResp: { identifiers?: { namespace: string[]; name: string }[] };
    try {
      tablesResp = await icebergGet(base, `/v1${pfx}/namespaces/${nsPath(ns)}/tables`, token);
    } catch {
      continue;
    }
    for (const ident of tablesResp.identifiers ?? []) {
      if (assets.length >= ICEBERG_MAX_TABLES) break;
      try {
        const loaded = await icebergGet<IcebergTableResp>(
          base,
          `/v1${pfx}/namespaces/${nsPath(ns)}/tables/${encodeURIComponent(ident.name)}`,
          token,
        );
        const asset = icebergTableToAsset(ns, ident.name, loaded);
        if (asset) assets.push(asset);
      } catch {
        /* skip a table we can't load */
      }
    }
  }
  return { assets, sampled: 0 };
}

/** Decrypt an Iceberg source's stored config + bearer token. */
export async function loadIcebergConfig(source: CatalogSourceRow): Promise<IcebergRestConfig> {
  const cfg = (source.config ?? {}) as { uri?: string; warehouse?: string };
  if (!cfg.uri) throw new Error(`Source "${source.name}" has no catalog URI`);
  let token: string | undefined;
  const enc = source.credentials as { ciphertext?: string; iv?: string } | null;
  if (enc?.ciphertext && enc?.iv) {
    const dec = await decryptJson<{ token?: string }>(enc.ciphertext, enc.iv);
    token = dec.token;
  }
  return { uri: cfg.uri, warehouse: cfg.warehouse, token };
}

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
    let warehouseConfig: WarehouseConfig | null = null;
    if (source.kind === "warehouse") {
      if (!source.connection_id) throw new Error("Source has no linked connection");
      warehouseConfig = await loadWarehouseConfig(source.connection_id);
      const res = await crawlWarehouse(warehouseConfig);
      assets = res.assets;
      sampled = res.sampled;
    } else if (source.kind === "iceberg_rest") {
      const cfg = await loadIcebergConfig(source);
      const res = await crawlIcebergRest(cfg);
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

    // Source-derived lineage (Databricks Unity Catalog system tables).
    // Best-effort — refreshes the source's edges, or clears them if the system
    // catalog isn't accessible.
    if (warehouseConfig?.provider === "databricks") {
      try {
        const edges = await fetchDatabricksLineage(warehouseConfig);
        await persistLineage(userId, source.id, edges);
      } catch {
        /* lineage is optional — never fail the crawl over it */
      }
    }

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
