// Iceberg catalogs, as the Lakehouse page uses them: register a REST
// catalog (tried before it is saved), list its namespaces and tables, mount
// a namespace as a schema, refresh a mount, publish a lakehouse table into
// the catalog, copy an Iceberg table in. Every write goes through the
// service role pinned to the caller's user id; the catalog rows carry secret
// names only.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import {
  ICEBERG_AUTH_TYPES,
  ICEBERG_NAMESPACE,
  ICEBERG_PARTITION_TRANSFORMS,
  ICEBERG_STORAGE_MODES,
  ICEBERG_TABLE,
  validateIcebergCatalog,
  type IcebergCatalogConfig,
} from "@/utils/lakehouse/iceberg";
import type { IcebergCatalogRow } from "@/utils/lakehouse/iceberg.server";
import type { IcebergInspection } from "@/utils/lakehouse/icebergInspect";
import { EXPIRE_DEFAULTS, ICEBERG_MAINTENANCE } from "@/utils/lakehouse/icebergSpark";
import type { LakehouseResult } from "@/utils/lakehouse/core.server";
import { callerFailure } from "@/utils/callerLookup.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: callerFailure(error, "Not signed in") };
  return { ok: true, userId: data.user.id };
}

const configSchema = z.object({
  name: z.string().trim().min(1).max(63),
  endpoint: z.string().trim().min(1).max(500),
  warehouse: z.string().trim().min(1).max(500),
  auth_type: z.enum(ICEBERG_AUTH_TYPES),
  token_secret: z.string().trim().max(120).default(""),
  client_id_secret: z.string().trim().max(120).default(""),
  client_secret_secret: z.string().trim().max(120).default(""),
  oauth2_server_uri: z.string().trim().max(500).default(""),
  storage: z.enum(ICEBERG_STORAGE_MODES).default("vended"),
  require_private: z.boolean().default(false),
});

/**
 * The database has no require_private column until migration
 * 20261104000000 runs (R428): a write naming it is refused by PostgREST
 * (PGRST204) or Postgres (42703). Said in words, with what to do.
 */
function missingRuleColumn(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    (error.code === "PGRST204" || error.code === "42703") &&
    /require_private/.test(error.message ?? "")
  );
}
const NEEDS_MIGRATION =
  "Require a private network path needs the database migration " +
  "20261104000000_iceberg_catalog_require_private. Apply it, or add the catalog without the rule.";

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
// One rule with the engine module (R457): a hyphen is a name catalogs use.
const NAMESPACE = ICEBERG_NAMESPACE;
const TABLE = ICEBERG_TABLE;
const LAKE_TABLE = /^[a-z][a-z0-9_]{0,62}$/;

const layoutSchema = z.object({
  format_version: z.union([z.literal(2), z.literal(3)]),
  partition: z
    .array(
      z.object({
        column: z.string().min(1).max(128),
        transform: z.enum(ICEBERG_PARTITION_TRANSFORMS),
        width: z.number().int().min(1).max(1024).optional(),
      }),
    )
    .max(4)
    .default([]),
});

async function ownCatalog(userId: string, id: string): Promise<IcebergCatalogRow | null> {
  const { data } = await supabaseAdmin
    .from("iceberg_catalogs")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as IcebergCatalogRow | null) ?? null;
}

export type IcebergCatalogView = Omit<IcebergCatalogRow, "user_id"> & {
  mounts: { id: string; name: string; namespace: string }[];
};

/** The caller's catalogs, each with the schemas mounted from it. */
export const icebergCatalogsList = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<{ ok: true; catalogs: IcebergCatalogView[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: rows } = await supabaseAdmin
      .from("iceberg_catalogs")
      .select("*")
      .eq("user_id", caller.userId)
      .order("created_at");
    const { data: mounts } = await supabaseAdmin
      .from("lakehouse_schemas")
      .select("id, name, iceberg_catalog_id, iceberg_namespace")
      .not("iceberg_catalog_id", "is", null);
    const catalogs = ((rows ?? []) as IcebergCatalogRow[]).map((row) => {
      const { user_id: _omit, ...rest } = row;
      void _omit;
      return {
        ...rest,
        mounts: (mounts ?? [])
          .filter((m) => m.iceberg_catalog_id === row.id)
          .map((m) => ({ id: m.id, name: m.name, namespace: m.iceberg_namespace ?? "" })),
      };
    });
    return { ok: true, catalogs };
  });

/** Register a catalog: it is attached and asked for its namespaces first, and saved only if that worked. */
export const icebergCatalogCreate = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), config: configSchema }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string; namespaces: string[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const cfg = data.config as IcebergCatalogConfig;
    const bad = validateIcebergCatalog(cfg);
    if (bad) return { ok: false, error: bad };
    let namespaces: string[];
    try {
      const { probeIcebergCatalog } = await import("@/utils/lakehouse/iceberg.server");
      namespaces = await probeIcebergCatalog(caller.userId, cfg);
    } catch (e) {
      const err = e as Error;
      // Refused before anything was sent to it (R428): the catalog was not asked.
      const refused =
        err.name === "IcebergCatalogRefused" || err.name === "PrivatePathRequiredError";
      return {
        ok: false,
        error: refused ? err.message : `The catalog did not answer: ${err.message}`,
      };
    }
    const { data: row, error } = await supabaseAdmin
      .from("iceberg_catalogs")
      .insert({
        user_id: caller.userId,
        name: cfg.name,
        endpoint: cfg.endpoint.trim(),
        warehouse: cfg.warehouse.trim(),
        auth_type: cfg.auth_type,
        token_secret: cfg.token_secret || null,
        client_id_secret: cfg.client_id_secret || null,
        client_secret_secret: cfg.client_secret_secret || null,
        oauth2_server_uri: cfg.oauth2_server_uri || null,
        storage: cfg.storage,
        // Named only when on, so a database without the column still saves
        // every catalog that does not ask for the rule.
        ...(cfg.require_private ? { require_private: true } : {}),
      })
      .select("id")
      .single();
    if (missingRuleColumn(error)) return { ok: false, error: NEEDS_MIGRATION };
    if (error || !row) {
      return {
        ok: false,
        error:
          error?.code === "23505"
            ? `You already have a catalog named "${cfg.name}"`
            : (error?.message ?? "Failed"),
      };
    }
    return { ok: true, id: row.id, namespaces };
  });

const urlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), "must be an http(s) URL");

/**
 * Which way the engine would reach a catalog's endpoint and token server,
 * before it is saved: the addresses each name resolves to from this server,
 * private or public, and the certificate of an https name. Sends nothing to
 * the catalog beyond a TLS handshake.
 */
export const icebergCatalogNetworkPath = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        endpoint: urlSchema,
        oauth2_server_uri: urlSchema.default(""),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; lines: { label: string; summary: string; private: boolean }[] } | Fail
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      if (!data.endpoint) return { ok: false, error: "Enter the REST endpoint first." };
      try {
        const { icebergCatalogPath } = await import("@/utils/lakehouse/iceberg.server");
        return { ok: true, lines: await icebergCatalogPath(data) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/**
 * Turn a catalog's "require a private network path" on or off. Turning it on
 * checks the path first and refuses, saying why, when the catalog would not
 * attach under it; from then on every attach and every engine sync checks it.
 */
export const icebergCatalogSetRequirePrivate = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        require_private: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const row = await ownCatalog(caller.userId, data.id);
    if (!row) return { ok: false, error: "Catalog not found" };
    if (data.require_private) {
      const { assertIcebergUrlsAllowed, configOf } =
        await import("@/utils/lakehouse/iceberg.server");
      const cfg = { ...configOf(row), require_private: true };
      try {
        await assertIcebergUrlsAllowed(cfg, (detail) =>
          auditEvent({
            userId: caller.userId,
            action: "lakehouse.iceberg.private_path.refused",
            resourceType: "iceberg_catalog",
            resourceId: row.id,
            resourceName: row.name,
            detail: { reason: detail },
          }),
        );
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    const { error } = await supabaseAdmin
      .from("iceberg_catalogs")
      .update({ require_private: data.require_private })
      .eq("id", row.id)
      .eq("user_id", caller.userId);
    if (missingRuleColumn(error)) return { ok: false, error: NEEDS_MIGRATION };
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: caller.userId,
      action: "lakehouse.iceberg.network_rule",
      resourceType: "iceberg_catalog",
      resourceId: row.id,
      resourceName: row.name,
      detail: { require_private: data.require_private },
    });
    return { ok: true };
  });

/** Remove a catalog: its mounted schemas go first (engine and rows), then the catalog, then the attachment. */
export const icebergCatalogDelete = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; schemas: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const row = await ownCatalog(caller.userId, data.id);
    if (!row) return { ok: false, error: "Catalog not found" };
    const { dropIcebergMountSchema, detachIcebergCatalog, mountForeignTables } =
      await import("@/utils/lakehouse/iceberg.server");
    const { data: mounts, error: mountsErr } = await supabaseAdmin
      .from("lakehouse_schemas")
      .select("id, name")
      .eq("iceberg_catalog_id", row.id);
    // Unread mounts would leave their schemas behind in the engine.
    if (mountsErr) return { ok: false, error: `Could not list its mounts: ${mountsErr.message}` };
    // FOUND IN R111. Each mount is dropped with CASCADE, and the dialog says
    // only that the mounted schemas go. A real table in one (written before
    // the guard refused such writes) would go too, unannounced. Refuse, and
    // name it, rather than drop what the owner never saw listed.
    const held: string[] = [];
    try {
      for (const m of mounts ?? []) {
        for (const t of await mountForeignTables(m.name)) held.push(`${m.name}.${t}`);
      }
    } catch (e) {
      return {
        ok: false,
        error: `Not removed: could not check its mounted schemas for tables of your own (${(e as Error).message}).`,
      };
    }
    if (held.length) {
      return {
        ok: false,
        // The way out is spelled out because writes into a mount are now
        // refused: copy the table (a read of the mount, a write elsewhere),
        // then drop the mounted schema in the explorer, whose confirm says
        // every table in it goes.
        error: `Not removed: ${held.join(", ")} ${held.length === 1 ? "is a table" : "are tables"} of your own inside a mounted schema, and would be dropped with it. Copy ${held.length === 1 ? "it" : "them"} to a regular schema first (CREATE TABLE analytics.… AS SELECT * FROM ${held[0]}), then drop the mounted schema in the explorer, which says every table in it goes.`,
      };
    }
    for (const m of mounts ?? []) {
      await dropIcebergMountSchema(m.name).catch(() => undefined);
      await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", m.id);
    }
    await supabaseAdmin.from("iceberg_catalogs").delete().eq("id", row.id);
    await detachIcebergCatalog(row.id).catch(() => undefined);
    return { ok: true, schemas: mounts?.length ?? 0 };
  });

export const icebergNamespacesList = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; namespaces: string[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const row = await ownCatalog(caller.userId, data.id);
    if (!row) return { ok: false, error: "Catalog not found" };
    try {
      const { listIcebergNamespaces } = await import("@/utils/lakehouse/iceberg.server");
      return { ok: true, namespaces: await listIcebergNamespaces(row) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export const icebergTablesList = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        namespace: z.string().regex(NAMESPACE),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; tables: string[] } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const row = await ownCatalog(caller.userId, data.id);
    if (!row) return { ok: false, error: "Catalog not found" };
    try {
      const { listIcebergTables } = await import("@/utils/lakehouse/iceberg.server");
      return { ok: true, tables: await listIcebergTables(row, data.namespace) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export const icebergMount = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        namespace: z.string().regex(NAMESPACE),
        schema_name: z.string().regex(NAME),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; id: string; views: number; skipped: number } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const row = await ownCatalog(caller.userId, data.id);
      if (!row) return { ok: false, error: "Catalog not found" };
      try {
        const { mountIcebergNamespace } = await import("@/utils/lakehouse/iceberg.server");
        const res = await mountIcebergNamespace({
          row,
          namespace: data.namespace,
          schemaName: data.schema_name,
        });
        return { ok: true, ...res };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/** Bring a mount's views level with the namespace (new tables appear, renamed ones follow). */
export const icebergMountRefresh = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), schema_name: z.string().regex(NAME) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; views: number; skipped: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: schemaRow } = await supabaseAdmin
      .from("lakehouse_schemas")
      .select("id, name, iceberg_catalog_id, iceberg_namespace")
      .eq("name", data.schema_name)
      .eq("user_id", caller.userId)
      .maybeSingle();
    if (!schemaRow?.iceberg_catalog_id || !schemaRow.iceberg_namespace) {
      return { ok: false, error: "That schema is not an Iceberg mount you own" };
    }
    const row = await ownCatalog(caller.userId, schemaRow.iceberg_catalog_id);
    if (!row) return { ok: false, error: "Catalog not found" };
    try {
      const { refreshIcebergMount } = await import("@/utils/lakehouse/iceberg.server");
      const res = await refreshIcebergMount({
        row,
        namespace: schemaRow.iceberg_namespace,
        schemaName: schemaRow.name,
      });
      auditEvent({
        userId: caller.userId,
        action: "lakehouse.iceberg.refresh",
        resourceType: "lakehouse_schema",
        resourceId: schemaRow.id,
        resourceName: schemaRow.name,
        detail: { catalog: row.name, namespace: schemaRow.iceberg_namespace, ...res },
      });
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export const icebergPublish = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        namespace: z.string().regex(NAMESPACE),
        table: z.string().regex(TABLE),
        source_schema: z.string().regex(NAME),
        source_table: z.string().regex(LAKE_TABLE),
        mode: z.enum(["create", "replace", "upsert"]),
        layout: layoutSchema.optional(),
        keys: z.array(z.string().min(1).max(128)).max(8).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; rows: number; format_version: number | null } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const row = await ownCatalog(caller.userId, data.id);
      if (!row) return { ok: false, error: "Catalog not found" };
      try {
        const { icebergPublishRefusal } = await import("@/utils/lakehouse/publishGuard.server");
        const refusal = await icebergPublishRefusal(
          caller.userId,
          data.source_schema,
          data.source_table,
        );
        if (refusal) return { ok: false, error: refusal };
        const { publishToIceberg } = await import("@/utils/lakehouse/iceberg.server");
        const res = await publishToIceberg({
          row,
          namespace: data.namespace,
          table: data.table,
          sourceSchema: data.source_schema,
          sourceTable: data.source_table,
          mode: data.mode,
          userId: caller.userId,
          layout: data.layout
            ? { formatVersion: data.layout.format_version, partition: data.layout.partition }
            : undefined,
          keys: data.keys,
        });
        return { ok: true, ...res };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/**
 * The mount a schema is, for a caller who can read it: the schema row with
 * its catalog row. A grantee reads a mount through its owner's catalog, as a
 * query on its views does, so the catalog is looked up by id, not by caller.
 */
async function readableMount(
  userId: string,
  schemaName: string,
): Promise<{ row: IcebergCatalogRow; schemaName: string } | Fail> {
  const { accessibleSchemas } = await import("@/utils/lakehouse/core.server");
  const schema = (await accessibleSchemas(userId)).find((s) => s.name === schemaName);
  if (!schema) return { ok: false, error: `No access to schema "${schemaName}"` };
  if (!schema.iceberg_catalog_id)
    return { ok: false, error: `${schemaName} is not an Iceberg mount.` };
  const { data: row, error: rowError } = await supabaseAdmin
    .from("iceberg_catalogs")
    .select("*")
    .eq("id", schema.iceberg_catalog_id)
    .maybeSingle();
  if (rowError) return { ok: false, error: `Could not read the catalog: ${rowError.message}` };
  if (!row) return { ok: false, error: "The catalog behind this mount is gone." };
  return { row: row as IcebergCatalogRow, schemaName };
}

/** A mounted table, from its own Iceberg metadata (R457). */
export const icebergMountInspect = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(NAME),
        table: z.string().regex(LAKE_TABLE),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          inspection: IcebergInspection & { namespace: string; table: string; catalog: string };
          /**
           * R459: whether the upkeep panel may run maintenance here: the caller
           * owns the catalog and the Spark engine is configured. Null when
           * not, with the reason to show.
           */
          maintenance: { available: true } | { available: false; reason: string };
        }
      | Fail
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const mount = await readableMount(caller.userId, data.schema);
      if ("ok" in mount) return mount;
      try {
        const { inspectMountedTable } = await import("@/utils/lakehouse/iceberg.server");
        const inspection = await inspectMountedTable({
          row: mount.row,
          schemaName: data.schema,
          view: data.table,
        });
        let maintenance: { available: true } | { available: false; reason: string } = {
          available: true,
        };
        if (mount.row.user_id !== caller.userId) {
          maintenance = {
            available: false,
            reason: "Only the catalog's owner can run maintenance on its tables.",
          };
        } else {
          const { sparkEngineAvailability } = await import("@/utils/etl/sparkCluster.server");
          if (!(await sparkEngineAvailability()).configured) {
            maintenance = {
              available: false,
              reason:
                "Maintenance runs on the Spark engine, which is not configured (Admin → Developer runtime → Spark engine).",
            };
          }
        }
        const { policedReadRefusal } = await import("@/utils/lakehouse/publishGuard.server");
        // Snapshot summaries count rows; a reader under a row filter is not
        // told how many rows the filter hides.
        if (await policedReadRefusal(caller.userId, data.schema, data.table, "time travel")) {
          for (const s of inspection.snapshots) {
            s.added_records = null;
            s.deleted_records = null;
            s.total_records = null;
            s.rows = null;
          }
          inspection.files = null;
          inspection.advice = inspection.advice.filter((a) => a.kind === "upgrade");
        }
        return { ok: true, inspection, maintenance };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/**
 * Run an upkeep item on the Spark engine (R459): compaction, rewriting away
 * deletes, or expiring snapshots. Owner only; the job is polled like a Spark
 * query (getLakehouseSparkQuery).
 */
export const icebergMountMaintain = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(NAME),
        table: z.string().regex(LAKE_TABLE),
        action: z.enum(ICEBERG_MAINTENANCE),
        older_than_days: z.number().int().min(1).max(3650).optional(),
        retain_last: z.number().int().min(1).max(10_000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string; sql: string } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    try {
      const { startIcebergMaintenance } = await import("@/utils/lakehouse/sparkQuery.server");
      const out = await startIcebergMaintenance(caller.userId, {
        schema: data.schema,
        view: data.table,
        maintenance:
          data.action === "expire"
            ? {
                action: "expire",
                older_than_days: data.older_than_days ?? EXPIRE_DEFAULTS.older_than_days,
                retain_last: data.retain_last ?? EXPIRE_DEFAULTS.retain_last,
              }
            : { action: data.action },
      });
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

/** A mounted table as it was at a snapshot, a branch or a tag (R457). */
export const icebergMountTimeTravel = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        schema: z.string().regex(NAME),
        table: z.string().regex(LAKE_TABLE),
        ref: z.string().trim().min(1).max(256),
        row_cap: z.number().int().min(1).max(10_000).default(100),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; result: LakehouseResult; snapshot_id: string } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const mount = await readableMount(caller.userId, data.schema);
      if ("ok" in mount) return mount;
      const { policedReadRefusal } = await import("@/utils/lakehouse/publishGuard.server");
      const refusal = await policedReadRefusal(
        caller.userId,
        data.schema,
        data.table,
        "time travel",
      );
      if (refusal) return { ok: false, error: refusal };
      try {
        const { timeTravelMountedTable } = await import("@/utils/lakehouse/iceberg.server");
        const out = await timeTravelMountedTable({
          row: mount.row,
          schemaName: data.schema,
          view: data.table,
          ref: data.ref,
          rowCap: data.row_cap,
        });
        auditEvent({
          userId: caller.userId,
          action: "lakehouse.iceberg.time_travel",
          resourceType: "lakehouse_table",
          resourceName: `${data.schema}.${data.table}`,
          detail: {
            catalog: mount.row.name,
            ref: data.ref,
            snapshot_id: out.snapshot_id,
            rows: out.result.row_count,
          },
        });
        return { ok: true, ...out };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

export const icebergImport = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        namespace: z.string().regex(NAMESPACE),
        table: z.string().regex(TABLE),
        target_schema: z.string().regex(NAME),
        target_table: z.string().regex(TABLE),
        mode: z.enum(["create", "replace"]),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; rows: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const row = await ownCatalog(caller.userId, data.id);
    if (!row) return { ok: false, error: "Catalog not found" };
    const { data: target } = await supabaseAdmin
      .from("lakehouse_schemas")
      .select("id, lake_source_id, iceberg_catalog_id")
      .eq("name", data.target_schema)
      .eq("user_id", caller.userId)
      .maybeSingle();
    if (!target)
      return { ok: false, error: `You do not own a schema named "${data.target_schema}"` };
    if (target.lake_source_id || target.iceberg_catalog_id) {
      return { ok: false, error: "A mount is read-only; import into a schema you created." };
    }
    {
      const { sheetOwnedRefusal } = await import("@/utils/sheets/owned.server");
      const why = await sheetOwnedRefusal([
        { schema: data.target_schema, table: data.target_table },
      ]);
      if (why) return { ok: false, error: why };
    }
    try {
      const { importFromIceberg } = await import("@/utils/lakehouse/iceberg.server");
      const res = await importFromIceberg({
        row,
        namespace: data.namespace,
        table: data.table,
        targetSchema: data.target_schema,
        targetTable: data.target_table,
        mode: data.mode,
        userId: caller.userId,
      });
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
