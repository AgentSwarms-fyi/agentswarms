// Server functions for SaaS data sources (save / list / delete / discover
// streams / sync). Credentials are AES-GCM encrypted before touching the DB
// and are never returned to the client.
//
// Mirrors warehouse.functions deliberately, including the userClient/requireUser
// pair — one auth pattern for connection management, not two.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { decryptJson, encryptJson } from "@/utils/providers/crypto.server";
import { auditEvent } from "@/utils/audit.server";
import { listSaasStreams, syncSaasStreams } from "@/utils/saas/sync.server";
import type { SaasConfig, SaasConnectionSummary, SaasStream } from "@/utils/saas/types";

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
    provider: z.literal("google_sheets"),
    service_account_json: z.string().min(2),
    spreadsheet_id: z.string().min(1),
  }),
]);

/**
 * Load and decrypt a connection the caller owns.
 *
 * `user_id` is an explicit filter even though these run under the caller's JWT
 * with RLS on. It costs nothing, and it means a future service-role caller
 * cannot read another tenant's service-account key by passing an id — the same
 * reasoning as loadWarehouseConnection's ownerUserId.
 */
async function loadConnection(
  sb: ReturnType<typeof userClient>,
  userId: string,
  id: string,
): Promise<{ name: string; config: SaasConfig; streams: string[] }> {
  const { data: row, error } = await sb
    .from("saas_connections")
    .select("name, config, streams, is_active")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("Data source not found");
  if (!row.is_active) throw new Error(`Data source "${row.name}" is disabled`);

  const enc = row.config as { ciphertext?: string; iv?: string };
  if (!enc?.ciphertext || !enc?.iv) {
    throw new Error(`Data source "${row.name}" has no stored credentials`);
  }
  return {
    name: row.name,
    config: await decryptJson<SaasConfig>(enc.ciphertext, enc.iv),
    streams: Array.isArray(row.streams) ? (row.streams as string[]) : [],
  };
}

export const listSaasConnections = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<SaasConnectionSummary[]> => {
    const { sb } = await requireUser(data.access_token);
    // `config` is deliberately NOT selected — a summary must not be able to
    // leak ciphertext, let alone anything decrypted from it.
    const { data: rows, error } = await sb
      .from("saas_connections")
      .select(
        "id, provider, name, is_active, last_sync_status, last_sync_error, last_synced_at, created_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (rows ?? []) as SaasConnectionSummary[];
  });

export const saveSaasConnection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(120),
        config: ConfigSchema,
        streams: z.array(z.string().min(1)).default([]),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { sb, userId } = await requireUser(data.access_token);
    const encrypted = await encryptJson(data.config);

    const row = {
      user_id: userId,
      provider: data.config.provider,
      name: data.name,
      config:
        encrypted as unknown as Database["public"]["Tables"]["saas_connections"]["Insert"]["config"],
      streams:
        data.streams as unknown as Database["public"]["Tables"]["saas_connections"]["Insert"]["streams"],
    };

    const q = data.id
      ? sb.from("saas_connections").update(row).eq("id", data.id).eq("user_id", userId).select("id")
      : sb.from("saas_connections").insert(row).select("id");
    const { data: saved, error } = await q.single();
    if (error) throw new Error(error.message);

    auditEvent({
      userId,
      action: data.id ? "saas_connection.update" : "saas_connection.create",
      resourceType: "saas_connection",
      resourceId: saved.id,
      resourceName: data.name,
      detail: { provider: data.config.provider, streams: data.streams.length },
    });
    return { id: saved.id };
  });

export const deleteSaasConnection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { sb, userId } = await requireUser(data.access_token);
    const { data: row } = await sb
      .from("saas_connections")
      .select("name")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    const { error } = await sb
      .from("saas_connections")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    auditEvent({
      userId,
      action: "saas_connection.delete",
      resourceType: "saas_connection",
      resourceId: data.id,
      resourceName: row?.name ?? undefined,
      // Datasets already synced are deliberately LEFT IN PLACE. Deleting a
      // source should not silently destroy data someone has built dashboards
      // on; removing those is a separate, deliberate act.
      detail: { datasets_retained: true },
    });
    return { ok: true };
  });

/**
 * Discover what this connection can sync.
 *
 * Doubles as the "test connection" action: it authenticates and reads the
 * source's structure, so a bad key or an unshared sheet fails here with the
 * connector's own message rather than at sync time.
 */
export const discoverSaasStreams = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        // Either an unsaved config (during setup) or a saved connection's id.
        config: ConfigSchema.optional(),
        id: z.string().uuid().optional(),
      })
      .refine((v) => !!v.config || !!v.id, { message: "config or id is required" })
      .parse(input),
  )
  .handler(async ({ data }): Promise<SaasStream[]> => {
    const { sb, userId } = await requireUser(data.access_token);
    const config = data.config ?? (await loadConnection(sb, userId, data.id!)).config;
    return listSaasStreams(config);
  });

export const syncSaasConnection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        /** Overrides the saved stream list for a one-off sync. */
        streams: z.array(z.string().min(1)).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { sb, userId } = await requireUser(data.access_token);
    const conn = await loadConnection(sb, userId, data.id);
    const streamIds = data.streams?.length ? data.streams : conn.streams;
    if (streamIds.length === 0) {
      throw new Error("No streams selected for this data source.");
    }

    const result = await syncSaasStreams({
      userId,
      connectionName: conn.name,
      config: conn.config,
      streamIds,
    });

    // A partial success is recorded as a FAILURE with the detail, not as "ok".
    // A source where one of six tabs silently stopped syncing is exactly the
    // kind of thing that goes unnoticed for a quarter.
    const status = result.failed.length === 0 ? "ok" : "partial";
    await sb
      .from("saas_connections")
      .update({
        last_sync_status: status,
        last_sync_error:
          result.failed.length > 0
            ? result.failed
                .map((f) => `${f.stream}: ${f.error}`)
                .join("; ")
                .slice(0, 2000)
            : null,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", userId);

    auditEvent({
      userId,
      action: "saas_connection.sync",
      resourceType: "saas_connection",
      resourceId: data.id,
      resourceName: conn.name,
      detail: {
        synced: result.synced.map((s) => s.tableName),
        rows: result.synced.reduce((n, s) => n + s.rowCount, 0),
        failed: result.failed.length,
      },
    });
    return result;
  });
