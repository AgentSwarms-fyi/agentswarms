// Server functions for managing data-warehouse connections (save / list /
// delete / test). Secrets are AES-GCM encrypted before touching the DB and
// are never returned to the client.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { encryptJson } from "@/utils/providers/crypto.server";
import { testWarehouseConnection } from "@/utils/warehouse/drivers.server";
import { loadWarehouseConnectionForUser } from "@/utils/warehouse/connections.server";
import { HOST_PORT_PROVIDERS } from "@/utils/warehouse/types";
import type { WarehouseConfig, WarehouseConnectionSummary } from "@/utils/warehouse/types";
import { auditEvent } from "@/utils/audit.server";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return { sb, userId: data.user.id };
}

const ConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("redshift"),
    region: z.string().min(1),
    access_key_id: z.string().min(1),
    secret_access_key: z.string().min(1),
    database: z.string().min(1),
    workgroup_name: z.string().optional(),
    cluster_identifier: z.string().optional(),
    db_user: z.string().optional(),
  }),
  z.object({
    provider: z.literal("snowflake"),
    account: z.string().min(1),
    token: z.string().min(1),
    warehouse: z.string().min(1),
    database: z.string().min(1),
    schema: z.string().optional(),
    role: z.string().optional(),
  }),
  z.object({
    provider: z.literal("databricks"),
    host: z.string().url(),
    warehouse_id: z.string().min(1),
    token: z.string().min(1),
    catalog: z.string().optional(),
    schema: z.string().optional(),
  }),
  z.object({
    provider: z.literal("bigquery"),
    project_id: z.string().min(1),
    service_account_json: z.string().min(2),
    location: z.string().optional(),
    dataset: z.string().optional(),
  }),
  z.object({
    provider: z.literal("azure_synapse"),
    server: z.string().min(1),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    provider: z.literal("postgres"),
    host: z.string().min(1),
    port: z.string().optional(),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    ssl: z.string().optional(),
  }),
  z.object({
    provider: z.literal("mysql"),
    host: z.string().min(1),
    port: z.string().optional(),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    ssl: z.string().optional(),
  }),
  z.object({
    provider: z.literal("trino"),
    host: z.string().min(1),
    port: z.string().optional(),
    username: z.string().min(1),
    password: z.string().optional(),
    access_token: z.string().optional(),
    catalog: z.string().optional(),
    schema: z.string().optional(),
    ssl: z.string().optional(),
  }),
  z.object({
    provider: z.literal("athena"),
    region: z.string().min(1),
    access_key_id: z.string().min(1),
    secret_access_key: z.string().min(1),
    session_token: z.string().optional(),
    database: z.string().optional(),
    catalog: z.string().optional(),
    workgroup: z.string().optional(),
    output_location: z.string().optional(),
  }),
  z.object({
    provider: z.literal("oracle"),
    ords_url: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
    schema: z.string().optional(),
  }),
  z.object({
    provider: z.literal("clickhouse"),
    url: z.string().url(),
    username: z.string().min(1),
    password: z.string(),
    database: z.string().optional(),
  }),
  z.object({
    provider: z.literal("sqlserver"),
    host: z.string().min(1),
    port: z.string().optional(),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    ssl: z.string().optional(),
    trust_server_certificate: z.string().optional(),
    instance_name: z.string().optional(),
  }),
  // Wire-compatible providers. Each is its own member rather than a shared
  // one with a loose provider field, because a discriminated union is what
  // makes an unknown provider a validation ERROR instead of a config that
  // saves cleanly and fails at query time.
  ...HOST_PORT_PROVIDERS.map((p) =>
    z.object({
      provider: z.literal(p),
      host: z.string().min(1),
      port: z.string().optional(),
      database: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1),
      ssl: z.string().optional(),
    }),
  ),
]);

export const listWarehouseConnections = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; connections: WarehouseConnectionSummary[] } | { ok: false; error: string }
    > => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        // Never selects `credentials` — a summary has no business shipping
        // ciphertext to a client, owned or shared.
        const COLS =
          "id, provider, name, is_active, last_test_status, last_test_error, last_tested_at, created_at, credentials_rotated_at";
        const { data: rows, error } = await sb
          .from("data_warehouse_connections")
          .select(COLS)
          .order("created_at", { ascending: true });
        if (error) return { ok: false, error: error.message };
        const owned = (rows ?? []) as WarehouseConnectionSummary[];

        // Connections shared with this user through IAM. Fetched separately
        // with the service role because these rows are deliberately NOT
        // readable under the grantee's RLS — they hold the credential.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
        const grantedIds = [
          ...(await resolveGrantedResourceIds(supabaseAdmin, userId, "warehouse_connection")),
        ];
        if (grantedIds.length === 0) return { ok: true, connections: owned };

        const ownedIds = new Set(owned.map((c) => c.id));
        const { data: sharedRows } = await supabaseAdmin
          .from("data_warehouse_connections")
          .select(COLS)
          .in("id", grantedIds);
        const shared = ((sharedRows ?? []) as WarehouseConnectionSummary[])
          // A grant to something you already own is not a second connection.
          .filter((c) => !ownedIds.has(c.id))
          .map((c) => ({ ...c, shared: true }));

        return { ok: true, connections: [...owned, ...shared] };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

export const saveWarehouseConnection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-zA-Z0-9_\- ]+$/, "Letters, numbers, spaces, - and _ only"),
        config: ConfigSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const encrypted = await encryptJson(data.config as WarehouseConfig);
      const { data: row, error } = await sb
        .from("data_warehouse_connections")
        .upsert(
          {
            user_id: userId,
            name: data.name.trim(),
            provider: data.config.provider,
            credentials: encrypted,
            is_active: true,
            last_test_status: null,
            last_test_error: null,
            // A save always writes freshly-entered credentials — they are
            // never returned to the client, so there is nothing to resubmit
            // unchanged. `updated_at` cannot serve this purpose: its trigger
            // fires for health checks and Test-connection presses too, which
            // would keep resetting the age of a credential nobody had touched.
            credentials_rotated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,name" },
        )
        .select("id")
        .single();
      if (error || !row) return { ok: false, error: error?.message ?? "Save failed" };
      auditEvent({
        userId,
        action: "warehouse.connection.save",
        resourceType: "warehouse_connection",
        resourceId: row.id,
      });
      return { ok: true, id: row.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Save failed" };
    }
  });

export const deleteWarehouseConnection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), connection_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const { error } = await sb
        .from("data_warehouse_connections")
        .delete()
        .eq("id", data.connection_id);
      if (error) return { ok: false, error: error.message };
      auditEvent({
        userId,
        action: "warehouse.connection.delete",
        resourceType: "warehouse_connection",
        resourceId: data.connection_id,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Delete failed" };
    }
  });

export const testWarehouseConnectionFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), connection_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    let sb: ReturnType<typeof userClient> | null = null;
    try {
      const ctx = await requireUser(data.access_token);
      sb = ctx.sb;
      const conn = await loadWarehouseConnectionForUser(
        sb,
        { connectionId: data.connection_id },
        ctx.userId,
      );
      await testWarehouseConnection(conn.config);
      await sb
        .from("data_warehouse_connections")
        .update({
          last_test_status: "ok",
          last_test_error: null,
          last_tested_at: new Date().toISOString(),
        })
        .eq("id", data.connection_id);
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : "Connection test failed";
      if (sb) {
        await sb
          .from("data_warehouse_connections")
          .update({
            last_test_status: "error",
            last_test_error: message.slice(0, 500),
            last_tested_at: new Date().toISOString(),
          })
          .eq("id", data.connection_id);
      }
      return { ok: false, error: message };
    }
  });
