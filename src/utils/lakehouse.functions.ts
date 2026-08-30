// Lakehouse RPCs: everything the UI (and later BI, agents and the analyst)
// calls. Every entry point resolves the caller from their access token,
// enforces schema access through core.server's single chokepoint, and writes
// audit events — the lakehouse has no side door.
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import {
  accessibleSchemas,
  lakehouseConnection,
  lakehouseEnabled,
  runLakehouseStatement,
  type LakehouseResult,
  type SchemaRow,
} from "@/utils/lakehouse/core.server";

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Identifier already validated against the regexes above — safe to quote. */
function qi(ident: string): string {
  return `"${ident}"`;
}

// ── Browse ──────────────────────────────────────────────────────────────────

export type LakehouseTableSummary = {
  schema: string;
  name: string;
  column_count: number;
  row_count: number | null;
  file_count: number | null;
  size_bytes: number | null;
};

export type LakehouseOverview = {
  enabled: boolean;
  schemas: (SchemaRow & { owned: boolean; table_count: number })[];
  tables: LakehouseTableSummary[];
};

export const getLakehouseOverview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<LakehouseOverview> => {
    const userId = await resolveCaller(data.access_token);
    if (!lakehouseEnabled()) return { enabled: false, schemas: [], tables: [] };
    const allowed = await accessibleSchemas(userId);
    if (!allowed.length) return { enabled: true, schemas: [], tables: [] };

    const c = await lakehouseConnection();
    try {
      const names = allowed.map((s) => `'${s.name}'`).join(", ");
      const cols = await (
        await c.run(
          `SELECT table_schema, table_name, count(*)::INT AS cols
           FROM information_schema.columns
           WHERE table_catalog = 'lake' AND table_schema IN (${names})
           GROUP BY 1, 2 ORDER BY 1, 2`,
        )
      ).getRows();
      // Row counts: one UNION over every visible table. Accurate even while
      // DuckLake still holds small inserts INLINED in the catalog (file stats
      // say zero then — the data hasn't been flushed to Parquet yet).
      const stats = new Map<string, { rows: number; files: number; bytes: number }>();
      const capped = cols.slice(0, 100);
      if (capped.length) {
        const union = capped
          .map(
            (r) =>
              `SELECT '${String(r[0])}' AS s, '${String(r[1])}' AS t, count(*)::BIGINT AS n FROM "${String(r[0])}"."${String(r[1])}"`,
          )
          .join(" UNION ALL ");
        try {
          const counts = await (await c.run(union)).getRows();
          for (const r of counts) {
            stats.set(`${String(r[0])}.${String(r[1])}`, {
              rows: Number(r[2] ?? 0),
              files: 0,
              bytes: 0,
            });
          }
        } catch {
          /* counts stay null */
        }
      }
      // File stats where Parquet exists (post-flush), via the DuckLake
      // metadata catalog the attach exposes alongside the data catalog.
      try {
        const st = await (
          await c.run(
            `SELECT sc.schema_name, ti.table_name, ti.file_count::BIGINT, ti.file_size_bytes::BIGINT
             FROM ducklake_table_info('lake') ti
             JOIN __ducklake_metadata_lake.ducklake_schema sc ON sc.schema_id = ti.schema_id`,
          )
        ).getRows();
        for (const r of st) {
          const key = `${String(r[0])}.${String(r[1])}`;
          const cur = stats.get(key) ?? { rows: 0, files: 0, bytes: 0 };
          cur.files = Number(r[2] ?? 0);
          cur.bytes = Number(r[3] ?? 0);
          stats.set(key, cur);
        }
      } catch {
        /* sizes stay zero */
      }
      const tables: LakehouseTableSummary[] = cols.map((r) => {
        const key = `${String(r[0])}.${String(r[1])}`;
        const st = stats.get(key);
        return {
          schema: String(r[0]),
          name: String(r[1]),
          column_count: Number(r[2]),
          row_count: st?.rows ?? null,
          file_count: st?.files ?? null,
          size_bytes: st ? st.bytes : null,
        };
      });
      const counts = new Map<string, number>();
      for (const t of tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1);
      return {
        enabled: true,
        schemas: allowed.map((s) => ({
          ...s,
          owned: s.user_id === userId,
          table_count: counts.get(s.name) ?? 0,
        })),
        tables,
      };
    } finally {
      c.closeSync();
    }
  });

export type LakehouseTableDetail = {
  columns: { name: string; type: string; nullable: boolean }[];
  row_count: number | null;
  snapshots: { id: number; time: string | null; changes: string }[];
  /** Partition key columns, in key order. Empty = unpartitioned. */
  partitioned_by: string[];
};

/**
 * The engine's OWN view of a table's partitioning, read from DuckLake's
 * metadata rather than from anything we recorded. A user can partition from
 * the SQL editor too, so app-side bookkeeping would drift; this cannot.
 */
async function readPartitionColumns(
  c: Awaited<ReturnType<typeof lakehouseConnection>>,
  schema: string,
  table: string,
): Promise<string[]> {
  try {
    const rows = await (
      await c.run(
        `SELECT col.column_name
         FROM __ducklake_metadata_lake.ducklake_partition_info pi
         JOIN __ducklake_metadata_lake.ducklake_partition_column pc
           ON pc.partition_id = pi.partition_id AND pc.table_id = pi.table_id
         JOIN __ducklake_metadata_lake.ducklake_table t
           ON t.table_id = pi.table_id AND t.end_snapshot IS NULL
         JOIN __ducklake_metadata_lake.ducklake_schema sc
           ON sc.schema_id = t.schema_id AND sc.end_snapshot IS NULL
         JOIN __ducklake_metadata_lake.ducklake_column col
           ON col.table_id = pi.table_id AND col.column_id = pc.column_id
          AND col.end_snapshot IS NULL
         WHERE pi.end_snapshot IS NULL
           AND sc.schema_name = '${schema}' AND t.table_name = '${table}'
         ORDER BY pc.partition_key_index`,
      )
    ).getRows();
    return rows.map((r) => String(r[0]));
  } catch {
    // Metadata layout is DuckLake-internal; a change there costs the badge,
    // never the page.
    return [];
  }
}

export const getLakehouseTable = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(SCHEMA_NAME),
        table: z.string().regex(TABLE_NAME),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<LakehouseTableDetail> => {
    const userId = await resolveCaller(data.access_token);
    const allowed = await accessibleSchemas(userId);
    if (!allowed.some((s) => s.name === data.schema)) throw new Error("No access to this schema");
    const c = await lakehouseConnection();
    try {
      const cols = await (
        await c.run(
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_catalog='lake' AND table_schema='${data.schema}' AND table_name='${data.table}'
           ORDER BY ordinal_position`,
        )
      ).getRows();
      if (!cols.length) throw new Error("Table not found");
      let rowCount: number | null = null;
      try {
        const rc = await (
          await c.run(`SELECT count(*)::BIGINT FROM ${qi(data.schema)}.${qi(data.table)}`)
        ).getRows();
        rowCount = Number(rc[0][0]);
      } catch {
        /* count stays null */
      }
      let snapshots: LakehouseTableDetail["snapshots"] = [];
      try {
        const sn = await (
          await c.run(
            `SELECT snapshot_id::BIGINT, snapshot_time::VARCHAR, changes::VARCHAR
             FROM lake.snapshots() ORDER BY snapshot_id DESC LIMIT 12`,
          )
        ).getRows();
        snapshots = sn.map((r) => ({
          id: Number(r[0]),
          time: r[1] === null ? null : String(r[1]),
          changes: String(r[2]).slice(0, 300),
        }));
      } catch {
        /* snapshots stay empty */
      }
      return {
        columns: cols.map((r) => ({
          name: String(r[0]),
          type: String(r[1]),
          nullable: String(r[2]).toUpperCase() === "YES",
        })),
        row_count: rowCount,
        snapshots,
        partitioned_by: await readPartitionColumns(c, data.schema, data.table),
      };
    } finally {
      c.closeSync();
    }
  });

// ── Query ───────────────────────────────────────────────────────────────────

export const runLakehouseQuery = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        sql: z.string().min(1).max(50_000),
        row_cap: z.number().int().min(1).max(100_000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<LakehouseResult> => {
    const userId = await resolveCaller(data.access_token);
    return runLakehouseStatement(userId, data.sql, { rowCap: data.row_cap, auditVia: "ui" });
  });

export const listLakehouseHistory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      history: {
        id: number;
        sql: string;
        kind: string;
        status: string;
        row_count: number | null;
        duration_ms: number | null;
        cached: boolean;
        retries: number;
        created_at: string;
      }[];
    }> => {
      const userId = await resolveCaller(data.access_token);
      const { data: rows } = await supabaseAdmin
        .from("lakehouse_query_history")
        .select("id, sql, kind, status, row_count, duration_ms, cached, retries, created_at")
        .eq("user_id", userId)
        .order("id", { ascending: false })
        .limit(50);
      return { history: rows ?? [] };
    },
  );

// ── Schema lifecycle ────────────────────────────────────────────────────────

export const createLakehouseSchema = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: z
          .string()
          .regex(SCHEMA_NAME, "lowercase letters, digits and _ (start with a letter)"),
        description: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const userId = await resolveCaller(data.access_token);
    if (["main", "information_schema", "pg_catalog"].includes(data.name)) {
      throw new Error("That name is reserved");
    }
    // Ownership row FIRST (unique name = the claim), engine DDL second —
    // losing the race leaves nothing to clean up.
    const { data: row, error } = await supabaseAdmin
      .from("lakehouse_schemas")
      .insert({ name: data.name, user_id: userId, description: data.description ?? null })
      .select("id")
      .single();
    if (error || !row) {
      throw new Error(
        error?.code === "23505"
          ? `Schema "${data.name}" already exists`
          : (error?.message ?? "Failed"),
      );
    }
    const c = await lakehouseConnection();
    try {
      await c.run(`CREATE SCHEMA IF NOT EXISTS ${qi(data.name)}`);
    } catch (e) {
      await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", row.id);
      throw new Error(`Could not create schema in the lakehouse: ${(e as Error).message}`);
    } finally {
      c.closeSync();
    }
    auditEvent({
      userId,
      action: "lakehouse.schema.create",
      resourceType: "lakehouse_schema",
      resourceId: row.id,
      resourceName: data.name,
    });
    return { id: row.id };
  });

export const dropLakehouseSchema = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), name: z.string().regex(SCHEMA_NAME) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: row } = await supabaseAdmin
      .from("lakehouse_schemas")
      .select("id, user_id")
      .eq("name", data.name)
      .maybeSingle();
    if (!row || row.user_id !== userId) {
      throw new Error("Only the schema's owner can drop it");
    }
    const c = await lakehouseConnection();
    try {
      await c.run(`DROP SCHEMA IF EXISTS ${qi(data.name)} CASCADE`);
    } finally {
      c.closeSync();
    }
    await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", row.id);
    await supabaseAdmin
      .from("iam_resource_grants")
      .delete()
      .eq("resource_type", "lakehouse_schema")
      .eq("resource_id", row.id);
    auditEvent({
      userId,
      action: "lakehouse.schema.drop",
      resourceType: "lakehouse_schema",
      resourceId: row.id,
      resourceName: data.name,
    });
    return { ok: true };
  });

// ── Table lifecycle + rows ──────────────────────────────────────────────────

const COLUMN_TYPES = [
  "BOOLEAN",
  "INTEGER",
  "BIGINT",
  "DOUBLE",
  "DECIMAL(18,4)",
  "VARCHAR",
  "DATE",
  "TIMESTAMP",
  "JSON",
] as const;

export const createLakehouseTable = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(SCHEMA_NAME),
        table: z.string().regex(TABLE_NAME),
        columns: z
          .array(
            z.object({
              name: z.string().regex(TABLE_NAME, "lowercase identifier"),
              type: z.enum(COLUMN_TYPES),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const userId = await resolveCaller(data.access_token);
    const ddl = `CREATE TABLE ${qi(data.schema)}.${qi(data.table)} (${data.columns
      .map((col) => `${qi(col.name)} ${col.type}`)
      .join(", ")})`;
    await runLakehouseStatement(userId, ddl, { auditVia: "ui-create-table" });
    return { ok: true };
  });

export const importDatasetToLakehouse = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        table_id: z.string().uuid(),
        schema: z.string().regex(SCHEMA_NAME),
        table: z.string().regex(TABLE_NAME),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ rows: number }> => {
    const userId = await resolveCaller(data.access_token);
    const allowed = await accessibleSchemas(userId);
    if (!allowed.some((s) => s.name === data.schema)) throw new Error("No access to this schema");
    // Owner OR IAM-granted — the same rule the platform's own dataset access
    // uses, so anything the picker can list, the import can read.
    const { data: table } = await supabaseAdmin
      .from("user_data_tables")
      .select("id, name, user_id, is_sample")
      .eq("id", data.table_id)
      .maybeSingle();
    if (!table) throw new Error("Dataset not found");
    // Samples are ownerless and readable by everyone; otherwise owner or grant.
    if (!table.is_sample && table.user_id !== userId) {
      const { data: granted } = await supabaseAdmin.rpc("has_resource_access", {
        rtype: "data_table",
        rid: data.table_id,
        uid: userId,
      });
      if (!granted) throw new Error("Dataset not found");
    }

    // Page the rows out of the platform store and CREATE TABLE AS from a
    // JSON read — types inferred by DuckDB, columns preserved.
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: chunk } = await supabaseAdmin
        .from("user_data_rows")
        .select("row")
        .eq("table_id", data.table_id)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (!chunk?.length) break;
      rows.push(...chunk.map((r) => r.row as Record<string, unknown>));
      if (rows.length >= 500_000) throw new Error("Dataset too large to import (500k row cap)");
      if (chunk.length < 1000) break;
    }
    if (!rows.length) throw new Error("Dataset has no rows");

    // Stage as a server-local temp file and let DuckDB's JSON reader infer
    // the columns — the one place a local file is involved, and it lives for
    // milliseconds. The path is mkdtemp-owned, never user-controlled.
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "lakehouse-import-"));
    const file = join(dir, "rows.json");
    const c = await lakehouseConnection();
    try {
      await writeFile(file, JSON.stringify(rows), "utf8");
      await c.run(
        `CREATE OR REPLACE TABLE ${qi(data.schema)}.${qi(data.table)} AS ` +
          `SELECT * FROM read_json_auto('${file.replace(/\\/g, "/").replace(/'/g, "''")}')`,
      );
    } finally {
      c.closeSync();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    auditEvent({
      userId,
      action: "lakehouse.import",
      resourceType: "lakehouse",
      resourceName: `${data.schema}.${data.table}`,
      detail: { source_dataset: table.name, rows: rows.length },
    });
    return { rows: rows.length };
  });

// ── Data-lake mounts ────────────────────────────────────────────────────────

export type LakeMountCandidate = { id: string; name: string; asset_count: number };

export const listLakeMountCandidates = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<{ sources: LakeMountCandidate[] }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: sources } = await supabaseAdmin
      .from("catalog_sources")
      .select("id, name, kind, user_id")
      .eq("user_id", userId)
      .eq("kind", "object_storage")
      .order("name");
    const out: LakeMountCandidate[] = [];
    for (const src of sources ?? []) {
      const { count } = await supabaseAdmin
        .from("catalog_assets")
        .select("id", { count: "exact", head: true })
        .eq("source_id", src.id)
        .eq("asset_type", "dataset");
      out.push({ id: src.id, name: src.name, asset_count: count ?? 0 });
    }
    return { sources: out };
  });

/**
 * Mount a catalog storage source as a READ-ONLY lakehouse schema: one view per
 * crawled dataset, each reading its files directly. The read_parquet /
 * read_csv calls live inside server-authored view bodies — user SQL never
 * names a path, and the mount's credential is scoped to its own bucket.
 */
export const mountLakeSource = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        catalog_source_id: z.string().uuid(),
        name: z.string().regex(SCHEMA_NAME, "lowercase letters, digits and _"),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string; views: number; skipped: number }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: src } = await supabaseAdmin
      .from("catalog_sources")
      .select("id, name, kind, user_id, credentials")
      .eq("id", data.catalog_source_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!src) throw new Error("Storage source not found");
    if (src.kind !== "object_storage")
      throw new Error("Only object-storage sources can be mounted");

    const { data: assets } = await supabaseAdmin
      .from("catalog_assets")
      .select("name, fqn, format, schema_name")
      .eq("source_id", src.id)
      .eq("asset_type", "dataset");
    if (!assets?.length) {
      throw new Error(
        "That source has no crawled datasets yet — crawl it first in the Data Catalog",
      );
    }

    const { data: row, error } = await supabaseAdmin
      .from("lakehouse_schemas")
      .insert({
        name: data.name,
        user_id: userId,
        description: `Data lake mount of "${src.name}"`,
        lake_source_id: src.id,
      })
      .select("id")
      .single();
    if (error || !row) {
      throw new Error(
        error?.code === "23505"
          ? `Schema "${data.name}" already exists`
          : (error?.message ?? "Failed"),
      );
    }

    const { loadStorageConfig } = await import("@/utils/catalog/crawler.server");
    const { ensureLakeSecrets } = await import("@/utils/lakehouse/core.server");
    const cfg = await loadStorageConfig(userId, src);
    const c = await lakehouseConnection();
    let views = 0;
    let skipped = 0;
    try {
      await ensureLakeSecrets(c);
      await c.run(`CREATE SCHEMA IF NOT EXISTS ${qi(data.name)}`);
      const prefix = (cfg.prefix ?? "").replace(/^\/+|\/+$/g, "");
      for (const asset of assets) {
        // fqn is "<dir>/*.<format>" from the crawler's grouping.
        const m = /^(.*)\/\*\.([a-z0-9]+)$/i.exec(asset.fqn);
        const view = asset.name
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_")
          .slice(0, 60);
        if (!m || !TABLE_NAME.test(view)) {
          skipped++;
          continue;
        }
        const [, dir, fmt] = m;
        const reader =
          fmt === "parquet"
            ? "read_parquet"
            : fmt === "csv"
              ? "read_csv_auto"
              : ["ndjson", "json"].includes(fmt)
                ? "read_json_auto"
                : null;
        if (!reader) {
          skipped++;
          continue;
        }
        const glob = `s3://${cfg.bucket}/${[prefix, dir].filter(Boolean).join("/")}/*`;
        try {
          await c.run(
            `CREATE OR REPLACE VIEW ${qi(data.name)}.${qi(view)} AS ` +
              `SELECT * FROM ${reader}('${glob.replace(/'/g, "''")}')`,
          );
          views++;
        } catch {
          skipped++;
        }
      }
    } catch (e) {
      await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", row.id);
      throw new Error(`Could not mount: ${(e as Error).message}`);
    } finally {
      c.closeSync();
    }
    auditEvent({
      userId,
      action: "lakehouse.lake.mount",
      resourceType: "lakehouse_schema",
      resourceId: row.id,
      resourceName: data.name,
      detail: { source: src.name, views, skipped },
    });
    return { id: row.id, views, skipped };
  });

// ── Performance surfaces ────────────────────────────────────────────────────

/**
 * Set (or clear) a table's partition columns. Partitioning is the biggest
 * scan-reduction lever we have: DuckLake writes one file set per partition
 * value, and a query filtering on that column opens only the matching files.
 */
export const setLakehousePartitioning = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(SCHEMA_NAME),
        table: z.string().regex(TABLE_NAME),
        columns: z.array(z.string().regex(TABLE_NAME)).max(4),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ partitioned_by: string[] }> => {
    const userId = await resolveCaller(data.access_token);
    const allowed = await accessibleSchemas(userId);
    const schemaRow = allowed.find((sch) => sch.name === data.schema);
    if (!schemaRow) throw new Error("No access to this schema");
    if (schemaRow.lake_source_id) {
      throw new Error("Data-lake mounts are read-only — partitioning belongs to the source");
    }
    const c = await lakehouseConnection();
    try {
      const target = `${qi(data.schema)}.${qi(data.table)}`;
      if (data.columns.length) {
        const cols = data.columns.map((col) => qi(col)).join(", ");
        await c.run(`ALTER TABLE ${target} SET PARTITIONED BY (${cols})`);
      } else {
        await c.run(`ALTER TABLE ${target} RESET PARTITIONED BY`);
      }
      auditEvent({
        userId,
        action: "lakehouse.partitioning",
        resourceType: "lakehouse_schema",
        resourceId: schemaRow.id,
        resourceName: `${data.schema}.${data.table}`,
        detail: { partitioned_by: data.columns },
      });
      return { partitioned_by: await readPartitionColumns(c, data.schema, data.table) };
    } finally {
      c.closeSync();
    }
  });

export type LakehouseProfile = {
  plan: string;
  rows_scanned: number | null;
  latency_ms: number | null;
  result_rows: number | null;
};

/**
 * EXPLAIN ANALYZE for one statement: the plan the engine chose plus what it
 * actually cost. This is how a user learns that a query read every file
 * because it did not filter on the partition key — the difference between
 * "it's slow" and a fix.
 */
export const profileLakehouseQuery = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), sql: z.string().min(1).max(50_000) }).parse(input),
  )
  .handler(async ({ data }): Promise<LakehouseProfile> => {
    const userId = await resolveCaller(data.access_token);
    const { classifyStatement, selectReferencedSchemas, assertSchemasAllowed, stripSqlComments } =
      await import("@/utils/lakehouse/core.server");
    // Profiling a write would EXECUTE it; only reads may be analysed.
    const classified = classifyStatement(data.sql);
    if (classified.kind !== "select") {
      throw new Error("Only SELECT statements can be profiled — a write would have to run");
    }
    const allowed = await accessibleSchemas(userId);
    const c = await lakehouseConnection();
    try {
      assertSchemasAllowed(await selectReferencedSchemas(c, data.sql), allowed);
      const clean = stripSqlComments(data.sql).replace(/;\s*$/, "");
      const textRows = await (await c.run(`EXPLAIN ANALYZE ${clean}`)).getRows();
      const plan = textRows.map((r) => String(r[r.length - 1])).join("\n");

      let rowsScanned: number | null = null;
      let latency: number | null = null;
      let resultRows: number | null = null;
      try {
        await c.run("SET enable_profiling='json'");
        const jsonRows = await (await c.run(`EXPLAIN ANALYZE ${clean}`)).getRows();
        const parsed = JSON.parse(String(jsonRows[0][jsonRows[0].length - 1])) as {
          cumulative_rows_scanned?: number;
          latency?: number;
          rows_returned?: number;
          result_set_size?: number;
        };
        rowsScanned = Number(parsed.cumulative_rows_scanned ?? 0) || null;
        latency = parsed.latency != null ? Math.round(Number(parsed.latency) * 1000) : null;
        resultRows = Number(parsed.rows_returned ?? 0) || null;
      } catch {
        // Plan text alone is still worth showing.
      } finally {
        await c.run("SET enable_profiling=false").catch(() => {});
      }
      auditEvent({
        userId,
        action: "lakehouse.profile",
        resourceType: "lakehouse",
        resourceName: "EXPLAIN ANALYZE",
        detail: { rows_scanned: rowsScanned ?? undefined },
      });
      return { plan, rows_scanned: rowsScanned, latency_ms: latency, result_rows: resultRows };
    } finally {
      c.closeSync();
    }
  });

// ── Row and column security ─────────────────────────────────────────────────

export type LakehousePolicy = {
  row_filter: string | null;
  masked_columns: string[];
  mask_style: "null" | "hash";
};

/**
 * Read the policy on a table. Only the schema OWNER may read it — showing a
 * grantee the filter would tell them precisely what they are being denied,
 * which is the one thing a security policy should not volunteer.
 */
export const getLakehousePolicy = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(SCHEMA_NAME),
        table: z.string().regex(TABLE_NAME),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<LakehousePolicy | null> => {
    const userId = await resolveCaller(data.access_token);
    const allowed = await accessibleSchemas(userId);
    const schemaRow = allowed.find((sch) => sch.name === data.schema);
    if (!schemaRow || schemaRow.user_id !== userId) return null;
    const { data: row } = await supabaseAdmin
      .from("lakehouse_table_policies")
      .select("row_filter, masked_columns, mask_style")
      .eq("user_id", userId)
      .eq("schema_name", data.schema)
      .eq("table_name", data.table)
      .maybeSingle();
    if (!row) return null;
    return {
      row_filter: row.row_filter,
      masked_columns: row.masked_columns ?? [],
      mask_style: (row.mask_style as "null" | "hash") ?? "null",
    };
  });

/**
 * Create, update or clear a table's security policy. The filter is validated
 * by running it through the engine's parser against the real table before it
 * is stored — a policy that fails to parse would otherwise be discovered by
 * blocking every reader, which is the worst possible time to find out.
 */
export const setLakehousePolicy = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(SCHEMA_NAME),
        table: z.string().regex(TABLE_NAME),
        row_filter: z.string().max(4000).nullable(),
        masked_columns: z.array(z.string().regex(TABLE_NAME)).max(64),
        mask_style: z.enum(["null", "hash"]),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<LakehousePolicy | null> => {
    const userId = await resolveCaller(data.access_token);
    const allowed = await accessibleSchemas(userId);
    const schemaRow = allowed.find((sch) => sch.name === data.schema);
    if (!schemaRow) throw new Error("No access to this schema");
    if (schemaRow.user_id !== userId) {
      throw new Error("Only the schema owner can set a security policy");
    }
    if (schemaRow.lake_source_id) {
      throw new Error("Data-lake mounts are read-only — secure the source instead");
    }

    const filter = data.row_filter?.trim() || null;
    const cleared = !filter && data.masked_columns.length === 0;

    if (filter) {
      // Validate against the real table, with the placeholders bound to a
      // sample identity so the expression is complete.
      const { bindFilterPlaceholders } = await import("@/utils/lakehouse/policies.server");
      const bound = bindFilterPlaceholders(filter, { id: userId, email: "probe@example.com" });
      const c = await lakehouseConnection();
      try {
        await c.run(`SELECT 1 FROM ${qi(data.schema)}.${qi(data.table)} WHERE (${bound}) LIMIT 0`);
      } catch (e) {
        throw new Error(`That row filter is not valid on this table: ${(e as Error).message}`);
      } finally {
        c.closeSync();
      }
    }

    if (cleared) {
      await supabaseAdmin
        .from("lakehouse_table_policies")
        .delete()
        .eq("user_id", userId)
        .eq("schema_name", data.schema)
        .eq("table_name", data.table);
    } else {
      const { error } = await supabaseAdmin.from("lakehouse_table_policies").upsert(
        {
          user_id: userId,
          schema_name: data.schema,
          table_name: data.table,
          row_filter: filter,
          masked_columns: data.masked_columns,
          mask_style: data.mask_style,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,schema_name,table_name" },
      );
      if (error) throw new Error(error.message);
    }

    auditEvent({
      userId,
      action: "lakehouse.policy",
      resourceType: "lakehouse_schema",
      resourceId: schemaRow.id,
      resourceName: `${data.schema}.${data.table}`,
      detail: {
        cleared: cleared || undefined,
        row_filter: filter ?? undefined,
        masked_columns: data.masked_columns.length ? data.masked_columns : undefined,
        mask_style: data.masked_columns.length ? data.mask_style : undefined,
      },
    });

    if (cleared) return null;
    return {
      row_filter: filter,
      masked_columns: data.masked_columns,
      mask_style: data.mask_style,
    };
  });

// ── Materialized views ──────────────────────────────────────────────────────

export type LakehouseMatview = {
  id: string;
  schema_name: string;
  table_name: string;
  sql: string;
  schedule: "manual" | "hourly" | "daily" | "weekly";
  is_active: boolean;
  next_run_at: string | null;
  last_refreshed_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  last_duration_ms: number | null;
  last_row_count: number | null;
  is_owner: boolean;
};

/** Every materialized view in a schema the caller can reach. */
export const listLakehouseMatviews = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<LakehouseMatview[]> => {
    const userId = await resolveCaller(data.access_token);
    const allowed = await accessibleSchemas(userId);
    if (!allowed.length) return [];
    const { data: rows } = await supabaseAdmin
      .from("lakehouse_materialized_views")
      .select("*")
      .in(
        "schema_name",
        allowed.map((sch) => sch.name),
      )
      .order("schema_name")
      .order("table_name");
    return (rows ?? []).map((r) => ({
      id: r.id,
      schema_name: r.schema_name,
      table_name: r.table_name,
      sql: r.sql,
      schedule: r.schedule as LakehouseMatview["schedule"],
      is_active: r.is_active,
      next_run_at: r.next_run_at,
      last_refreshed_at: r.last_refreshed_at,
      last_status: r.last_status as "ok" | "error" | null,
      last_error: r.last_error,
      last_duration_ms: r.last_duration_ms,
      last_row_count: r.last_row_count === null ? null : Number(r.last_row_count),
      is_owner: r.user_id === userId,
    }));
  });

/**
 * Save a SELECT as a materialized view and build it once immediately — a view
 * that exists but holds nothing until its first schedule fires would look
 * broken.
 */
export const saveLakehouseMatview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(SCHEMA_NAME),
        table: z.string().regex(TABLE_NAME),
        sql: z.string().min(1).max(50_000),
        schedule: z.enum(["manual", "hourly", "daily", "weekly"]),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string; rows: number | null; error?: string }> => {
    const userId = await resolveCaller(data.access_token);
    const allowed = await accessibleSchemas(userId);
    const schemaRow = allowed.find((sch) => sch.name === data.schema);
    if (!schemaRow) throw new Error("No access to this schema");
    if (schemaRow.user_id !== userId) {
      throw new Error("A materialized view can only be written into a schema you own");
    }
    if (schemaRow.lake_source_id) {
      throw new Error("Data-lake mounts are read-only");
    }

    const { nextMatviewRunAt, refreshMaterializedView } =
      await import("@/utils/lakehouse/matviews.server");

    const { data: saved, error } = await supabaseAdmin
      .from("lakehouse_materialized_views")
      .upsert(
        {
          user_id: userId,
          schema_name: data.schema,
          table_name: data.table,
          sql: data.sql,
          schedule: data.schedule,
          is_active: true,
          next_run_at: nextMatviewRunAt(data.schedule),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "schema_name,table_name" },
      )
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    auditEvent({
      userId,
      action: "lakehouse.matview.save",
      resourceType: "lakehouse_matview",
      resourceId: saved.id,
      resourceName: `${data.schema}.${data.table}`,
      detail: { schedule: data.schedule },
    });

    // Build it now. A failure here is reported but does not undo the save —
    // the definition is still worth keeping so the user can fix it.
    const res = await refreshMaterializedView({ ...saved, last_row_count: null } as never, "save");
    return { id: saved.id as string, rows: res.rows ?? null, error: res.error };
  });

/** Rebuild one view now. */
export const refreshLakehouseMatview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ rows: number | null; error?: string; ms: number }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: row } = await supabaseAdmin
      .from("lakehouse_materialized_views")
      .select("*")
      .eq("id", data.id)
      .single();
    if (!row) throw new Error("No such materialized view");
    if (row.user_id !== userId) throw new Error("Only its owner can refresh this view");
    const { refreshMaterializedView } = await import("@/utils/lakehouse/matviews.server");
    const res = await refreshMaterializedView(row as never, "manual");
    return { rows: res.rows ?? null, error: res.error, ms: res.ms };
  });

/**
 * Forget a materialized view. The TABLE is left in place: it is an ordinary
 * lakehouse table, and silently deleting data because a schedule was removed
 * would be the wrong default. Drop it from the table view if you want it gone.
 */
export const deleteLakehouseMatview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: row } = await supabaseAdmin
      .from("lakehouse_materialized_views")
      .select("id, user_id, schema_name, table_name")
      .eq("id", data.id)
      .single();
    if (!row) throw new Error("No such materialized view");
    if (row.user_id !== userId) throw new Error("Only its owner can remove this view");
    await supabaseAdmin.from("lakehouse_materialized_views").delete().eq("id", data.id);
    auditEvent({
      userId,
      action: "lakehouse.matview.delete",
      resourceType: "lakehouse_matview",
      resourceId: data.id,
      resourceName: `${row.schema_name}.${row.table_name}`,
      detail: { table_kept: true },
    });
    return { ok: true };
  });
