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
  ICEBERG_STORAGE_MODES,
  validateIcebergCatalog,
  type IcebergCatalogConfig,
} from "@/utils/lakehouse/iceberg";
import type { IcebergCatalogRow } from "@/utils/lakehouse/iceberg.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
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
});

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const NAMESPACE = /^[A-Za-z0-9_]{1,128}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

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
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
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
  .inputValidator((input: unknown) =>
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
      return { ok: false, error: `The catalog did not answer: ${(e as Error).message}` };
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
      })
      .select("id")
      .single();
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

/** Remove a catalog: its mounted schemas go first (engine and rows), then the catalog, then the attachment. */
export const icebergCatalogDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; schemas: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const row = await ownCatalog(caller.userId, data.id);
    if (!row) return { ok: false, error: "Catalog not found" };
    const { dropIcebergMountSchema, detachIcebergCatalog } =
      await import("@/utils/lakehouse/iceberg.server");
    const { data: mounts } = await supabaseAdmin
      .from("lakehouse_schemas")
      .select("id, name")
      .eq("iceberg_catalog_id", row.id);
    for (const m of mounts ?? []) {
      await dropIcebergMountSchema(m.name).catch(() => undefined);
      await supabaseAdmin.from("lakehouse_schemas").delete().eq("id", m.id);
    }
    await supabaseAdmin.from("iceberg_catalogs").delete().eq("id", row.id);
    await detachIcebergCatalog(row.id).catch(() => undefined);
    return { ok: true, schemas: mounts?.length ?? 0 };
  });

export const icebergNamespacesList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
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
  .inputValidator((input: unknown) =>
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
  .inputValidator((input: unknown) =>
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
  .inputValidator((input: unknown) =>
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

/** The source table must be readable by the caller: their own schema, or one shared with them. */
async function canRead(userId: string, schema: string): Promise<boolean> {
  const { accessibleSchemas } = await import("@/utils/lakehouse/core.server");
  return (await accessibleSchemas(userId)).some((s) => s.name === schema);
}

export const icebergPublish = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        namespace: z.string().regex(NAMESPACE),
        table: z.string().regex(TABLE),
        source_schema: z.string().regex(NAME),
        source_table: z.string().regex(TABLE),
        mode: z.enum(["create", "replace"]),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; rows: number } | Fail> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const row = await ownCatalog(caller.userId, data.id);
    if (!row) return { ok: false, error: "Catalog not found" };
    if (!(await canRead(caller.userId, data.source_schema))) {
      return { ok: false, error: `No access to schema "${data.source_schema}"` };
    }
    try {
      const { publishToIceberg } = await import("@/utils/lakehouse/iceberg.server");
      const res = await publishToIceberg({
        row,
        namespace: data.namespace,
        table: data.table,
        sourceSchema: data.source_schema,
        sourceTable: data.source_table,
        mode: data.mode,
        userId: caller.userId,
      });
      return { ok: true, ...res };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

export const icebergImport = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
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
