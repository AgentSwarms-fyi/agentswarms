// Server functions for managing data-warehouse connections (save / list /
// delete / test). Secrets are AES-GCM encrypted before touching the DB and
// are never returned to the client.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { encryptJson } from "@/utils/providers/crypto.server";
import { testWarehouseConnection } from "@/utils/warehouse/drivers.server";
import { loadWarehouseConnection } from "@/utils/warehouse/connections.server";
import type { WarehouseConfig, WarehouseConnectionSummary } from "@/utils/warehouse/types";

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
        const { sb } = await requireUser(data.access_token);
        const { data: rows, error } = await sb
          .from("data_warehouse_connections")
          .select(
            "id, provider, name, is_active, last_test_status, last_test_error, last_tested_at, created_at",
          )
          .order("created_at", { ascending: true });
        if (error) return { ok: false, error: error.message };
        return { ok: true, connections: (rows ?? []) as WarehouseConnectionSummary[] };
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
          },
          { onConflict: "user_id,name" },
        )
        .select("id")
        .single();
      if (error || !row) return { ok: false, error: error?.message ?? "Save failed" };
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
      const { sb } = await requireUser(data.access_token);
      const { error } = await sb
        .from("data_warehouse_connections")
        .delete()
        .eq("id", data.connection_id);
      if (error) return { ok: false, error: error.message };
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
      const conn = await loadWarehouseConnection(sb, { connectionId: data.connection_id });
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
