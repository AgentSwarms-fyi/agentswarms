// Iceberg interop, the engine half: attach every registered REST catalog to
// the shared DuckDB instance, mount a namespace as a lakehouse schema of
// views, publish a lakehouse table into a catalog, copy an Iceberg table in.
//
// Governance stays where it is for everything else on the lakehouse: a
// mount is a schema row with owner and IAM shares, its views are read
// through the per-user statement guard, and a user statement can never name
// an attached catalog directly (the guard refuses every catalog but `lake`).
// Publishing and importing run here, as the caller, after ownership checks.
import type { DuckDBConnection } from "@duckdb/node-api";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  ICEBERG_NAME,
  ICEBERG_NAMESPACE,
  icebergAlias,
  icebergAttachSql,
  icebergDetachSql,
  icebergImportSql,
  icebergListNamespacesSql,
  icebergListTablesSql,
  icebergPublishSql,
  icebergSecretNames,
  icebergSecretSql,
  icebergViewName,
  icebergViewSql,
  validateIcebergCatalog,
  type IcebergCatalogConfig,
} from "@/utils/lakehouse/iceberg";
import { resolveSecretRefs } from "@/utils/secrets.server";

export type IcebergCatalogRow = Database["public"]["Tables"]["iceberg_catalogs"]["Row"];

const qi = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function configOf(row: IcebergCatalogRow): IcebergCatalogConfig {
  return {
    name: row.name,
    endpoint: row.endpoint,
    warehouse: row.warehouse,
    auth_type: row.auth_type as IcebergCatalogConfig["auth_type"],
    token_secret: row.token_secret ?? "",
    client_id_secret: row.client_id_secret ?? "",
    client_secret_secret: row.client_secret_secret ?? "",
    oauth2_server_uri: row.oauth2_server_uri ?? "",
    storage: row.storage as IcebergCatalogConfig["storage"],
  };
}

/** The catalog's credentials, resolved from the owner's secrets by name. */
async function catalogSecrets(
  userId: string,
  cfg: IcebergCatalogConfig,
): Promise<{ token?: string; client_id?: string; client_secret?: string }> {
  const out: { token?: string; client_id?: string; client_secret?: string } = {};
  for (const { key, secret } of icebergSecretNames(cfg)) {
    const ref = `{{secret:${secret}}}`;
    const value = await resolveSecretRefs(userId, ref);
    if (!value || value === ref) {
      throw new Error(`The secret "${secret}" is not set for this account (Settings → Secrets).`);
    }
    out[key] = value;
  }
  return out;
}

/** CREATE SECRET (when the auth needs one) then ATTACH, under the given alias. */
export async function attachIcebergCatalog(
  c: DuckDBConnection,
  userId: string,
  cfg: IcebergCatalogConfig,
  alias: string,
): Promise<void> {
  const secretSql = icebergSecretSql(alias, cfg, await catalogSecrets(userId, cfg));
  if (secretSql) await c.run(secretSql);
  await c.run(icebergAttachSql(alias, cfg));
}

/**
 * Attachments are per engine instance, and the app runs one instance per
 * worker: a catalog registered on one worker must reach the others, and a
 * catalog removed must leave them. So every connection syncs, at most every
 * SYNC_MS, against the catalog rows - a DB read a few times a minute, never
 * per statement - and a statement that still meets a missing catalog asks
 * for a forced sync and retries once.
 */
const attached = new Set<string>();
let lastSync = 0;
const SYNC_MS = 15_000;
/**
 * A catalog that failed to attach waits this long before the next try: each
 * attempt holds the connection that triggered it for the endpoint's timeout
 * and writes the row, and a dead endpoint retried every sync would tax every
 * user of the lakehouse. A forced sync tries at once.
 */
const failedAt = new Map<string, number>();
const RETRY_FAILED_MS = 5 * 60_000;

/**
 * Attach every active catalog this instance lacks, detach the ones removed.
 * A catalog that fails to attach is noted on its row and skipped, so one
 * dead endpoint never blocks the lakehouse; it is tried again after
 * RETRY_FAILED_MS.
 */
export async function ensureIcebergCatalogs(c: DuckDBConnection, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSync < SYNC_MS) return;
  lastSync = now;
  const { data: rows } = await supabaseAdmin
    .from("iceberg_catalogs")
    .select("*")
    .eq("is_active", true);
  const live = new Set<string>();
  for (const row of (rows ?? []) as IcebergCatalogRow[]) {
    live.add(row.id);
    if (attached.has(row.id)) continue;
    if (!force && now - (failedAt.get(row.id) ?? 0) < RETRY_FAILED_MS) continue;
    try {
      await attachIcebergCatalog(c, row.user_id, configOf(row), icebergAlias(row.id));
      attached.add(row.id);
      failedAt.delete(row.id);
      if (row.last_error) {
        await supabaseAdmin.from("iceberg_catalogs").update({ last_error: null }).eq("id", row.id);
      }
    } catch (e) {
      failedAt.set(row.id, Date.now());
      const message = (e as Error).message.slice(0, 500);
      console.warn(`[lakehouse] iceberg catalog "${row.name}" did not attach:`, message);
      await supabaseAdmin
        .from("iceberg_catalogs")
        .update({ last_error: message })
        .eq("id", row.id)
        .then(() => undefined);
    }
  }
  for (const id of [...attached]) {
    if (live.has(id)) continue;
    await c.run(icebergDetachSql(icebergAlias(id))).catch(() => undefined);
    attached.delete(id);
  }
}

/** The engine's own words for a statement that met a catalog this instance has not attached. */
export function isMissingIcebergCatalogError(message: string): boolean {
  return /Catalog "ice_[0-9a-f]{32}" does not exist/.test(message);
}

const NO_EXTENSION =
  "The Iceberg extension is not loaded on this lakehouse engine; the server log at boot says why.";

/** A connection with the catalog attached (idempotent), for one operation. */
async function withCatalog<T>(
  row: IcebergCatalogRow,
  fn: (c: DuckDBConnection, alias: string) => Promise<T>,
): Promise<T> {
  const { lakehouseConnection, icebergExtensionAvailable } =
    await import("@/utils/lakehouse/core.server");
  const c = await lakehouseConnection();
  if (!icebergExtensionAvailable()) {
    c.closeSync();
    throw new Error(NO_EXTENSION);
  }
  const alias = icebergAlias(row.id);
  try {
    await attachIcebergCatalog(c, row.user_id, configOf(row), alias);
    attached.add(row.id);
    return await fn(c, alias);
  } finally {
    c.closeSync();
  }
}

async function firstColumn(c: DuckDBConnection, sql: string): Promise<string[]> {
  const rows = await (await c.run(sql)).getRows();
  return rows.map((r) => String(r[0]));
}

/**
 * Try a catalog before it is saved: attach under a throwaway alias, list its
 * namespaces, detach. The answer is the namespaces, or the reason it failed
 * in the engine's words.
 */
export async function probeIcebergCatalog(
  userId: string,
  cfg: IcebergCatalogConfig,
): Promise<string[]> {
  const bad = validateIcebergCatalog(cfg);
  if (bad) throw new Error(bad);
  const { lakehouseConnection, icebergExtensionAvailable } =
    await import("@/utils/lakehouse/core.server");
  const c = await lakehouseConnection();
  if (!icebergExtensionAvailable()) {
    c.closeSync();
    throw new Error(NO_EXTENSION);
  }
  const alias = `ice_probe_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await attachIcebergCatalog(c, userId, cfg, alias);
    return await firstColumn(c, icebergListNamespacesSql(alias));
  } finally {
    await c.run(icebergDetachSql(alias)).catch(() => undefined);
    c.closeSync();
  }
}

export async function listIcebergNamespaces(row: IcebergCatalogRow): Promise<string[]> {
  return withCatalog(row, (c, alias) => firstColumn(c, icebergListNamespacesSql(alias)));
}

export async function listIcebergTables(
  row: IcebergCatalogRow,
  namespace: string,
): Promise<string[]> {
  if (!ICEBERG_NAMESPACE.test(namespace))
    throw new Error("That namespace name is not usable here.");
  return withCatalog(row, (c, alias) => firstColumn(c, icebergListTablesSql(alias, namespace)));
}

/** Create or refresh the views of a mount: one per table the namespace has now. */
async function syncMountViews(
  c: DuckDBConnection,
  alias: string,
  namespace: string,
  schemaName: string,
): Promise<{ views: number; skipped: number }> {
  await c.run(`CREATE SCHEMA IF NOT EXISTS ${qi(schemaName)}`);
  const tables = await firstColumn(c, icebergListTablesSql(alias, namespace));
  let views = 0;
  let skipped = 0;
  for (const table of tables) {
    const view = icebergViewName(table);
    if (!view) {
      skipped++;
      continue;
    }
    try {
      await c.run(icebergViewSql(schemaName, view, alias, namespace, table));
      views++;
    } catch {
      skipped++;
    }
  }
  return { views, skipped };
}

/**
 * Mount one namespace as a lakehouse schema: a schema row (owner, shares,
 * the guard) and a read-only view per table. Nothing is copied.
 */
export async function mountIcebergNamespace(args: {
  row: IcebergCatalogRow;
  namespace: string;
  schemaName: string;
}): Promise<{ id: string; views: number; skipped: number }> {
  if (!ICEBERG_NAMESPACE.test(args.namespace)) {
    throw new Error("That namespace name is not usable here.");
  }
  if (!ICEBERG_NAME.test(args.schemaName)) {
    throw new Error(
      "Name the schema with lowercase letters, digits and underscores, starting with a letter.",
    );
  }
  const { data: schemaRow, error } = await supabaseAdmin
    .from("lakehouse_schemas")
    .insert({
      name: args.schemaName,
      user_id: args.row.user_id,
      description: `Iceberg mount of "${args.row.name}" · ${args.namespace}`,
      iceberg_catalog_id: args.row.id,
      iceberg_namespace: args.namespace,
    })
    .select("id")
    .single();
  if (error || !schemaRow) {
    throw new Error(
      error?.code === "23505"
        ? `Schema "${args.schemaName}" already exists`
        : (error?.message ?? "Failed"),
    );
  }
  try {
    const counts = await withCatalog(args.row, (c, alias) =>
      syncMountViews(c, alias, args.namespace, args.schemaName),
    );
    auditEvent({
      userId: args.row.user_id,
      action: "lakehouse.iceberg.mount",
      resourceType: "lakehouse_schema",
      resourceId: schemaRow.id,
      resourceName: args.schemaName,
      detail: { catalog: args.row.name, namespace: args.namespace, ...counts },
    });
    return { id: schemaRow.id, ...counts };
  } catch (e) {
    await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", schemaRow.id);
    throw new Error(`Could not mount: ${(e as Error).message}`);
  }
}

/** Re-read the namespace and bring the mount's views level with it. */
export async function refreshIcebergMount(args: {
  row: IcebergCatalogRow;
  namespace: string;
  schemaName: string;
}): Promise<{ views: number; skipped: number }> {
  return withCatalog(args.row, (c, alias) =>
    syncMountViews(c, alias, args.namespace, args.schemaName),
  );
}

/** Drop a mount's schema from the engine; the row goes with the caller's delete. */
export async function dropIcebergMountSchema(schemaName: string): Promise<void> {
  const { lakehouseConnection } = await import("@/utils/lakehouse/core.server");
  const c = await lakehouseConnection();
  try {
    await c.run(`DROP SCHEMA IF EXISTS ${qi(schemaName)} CASCADE`);
  } finally {
    c.closeSync();
  }
}

/** Detach a catalog from the engine (after its mounts are gone). */
export async function detachIcebergCatalog(catalogId: string): Promise<void> {
  const { lakehouseConnection } = await import("@/utils/lakehouse/core.server");
  const c = await lakehouseConnection();
  try {
    await c.run(icebergDetachSql(icebergAlias(catalogId)));
    attached.delete(catalogId);
  } finally {
    c.closeSync();
  }
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Publish a lakehouse table into the catalog: the namespace if needed, then
 * CREATE TABLE AS over the governed table. The caller has already checked
 * that the source schema is theirs to read.
 */
export async function publishToIceberg(args: {
  row: IcebergCatalogRow;
  namespace: string;
  table: string;
  sourceSchema: string;
  sourceTable: string;
  mode: "create" | "replace";
  userId: string;
}): Promise<{ rows: number }> {
  if (!ICEBERG_NAMESPACE.test(args.namespace))
    throw new Error("That namespace name is not usable here.");
  if (!TABLE_NAME.test(args.table)) throw new Error("That table name is not usable here.");
  const rows = await withCatalog(args.row, async (c, alias) => {
    for (const sql of icebergPublishSql({
      alias,
      namespace: args.namespace,
      table: args.table,
      sourceSchema: args.sourceSchema,
      sourceTable: args.sourceTable,
      mode: args.mode,
    })) {
      await c.run(sql);
    }
    const [n] = await firstColumn(
      c,
      `SELECT count(*) FROM ${qi(alias)}.${qi(args.namespace)}.${qi(args.table)}`,
    );
    return Number(n ?? 0);
  });
  auditEvent({
    userId: args.userId,
    action: "lakehouse.iceberg.publish",
    resourceType: "lakehouse_table",
    resourceName: `${args.sourceSchema}.${args.sourceTable}`,
    detail: {
      catalog: args.row.name,
      namespace: args.namespace,
      table: args.table,
      mode: args.mode,
      rows,
    },
  });
  return { rows };
}

/** Copy an Iceberg table into a lakehouse table the caller owns: a real DuckLake table, no dependence on the catalog. */
export async function importFromIceberg(args: {
  row: IcebergCatalogRow;
  namespace: string;
  table: string;
  targetSchema: string;
  targetTable: string;
  mode: "create" | "replace";
  userId: string;
}): Promise<{ rows: number }> {
  if (!ICEBERG_NAMESPACE.test(args.namespace))
    throw new Error("That namespace name is not usable here.");
  if (!TABLE_NAME.test(args.table) || !TABLE_NAME.test(args.targetTable)) {
    throw new Error("That table name is not usable here.");
  }
  const rows = await withCatalog(args.row, async (c, alias) => {
    await c.run(
      icebergImportSql({
        alias,
        namespace: args.namespace,
        table: args.table,
        targetSchema: args.targetSchema,
        targetTable: args.targetTable,
        mode: args.mode,
      }),
    );
    const [n] = await firstColumn(
      c,
      `SELECT count(*) FROM ${qi("lake")}.${qi(args.targetSchema)}.${qi(args.targetTable)}`,
    );
    return Number(n ?? 0);
  });
  auditEvent({
    userId: args.userId,
    action: "lakehouse.iceberg.import",
    resourceType: "lakehouse_table",
    resourceName: `${args.targetSchema}.${args.targetTable}`,
    detail: {
      catalog: args.row.name,
      namespace: args.namespace,
      table: args.table,
      mode: args.mode,
      rows,
    },
  });
  return { rows };
}
