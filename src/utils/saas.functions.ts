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
import { listSaasStreams, runConnectionSync } from "@/utils/saas/sync.server";
import { SYNC_SCHEDULES } from "@/utils/saas/types";
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
  z.object({
    provider: z.literal("stripe"),
    api_key: z.string().min(1),
  }),
  z.object({
    provider: z.literal("shopify"),
    shop_domain: z.string().min(1),
    access_token: z.string().min(1),
  }),
  z.object({
    provider: z.literal("hubspot"),
    access_token: z.string().min(1),
  }),
  z.object({
    provider: z.literal("salesforce"),
    instance_url: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
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
/** Connection ids `userId` may use through an IAM grant. */
async function grantedConnectionIds(userId: string): Promise<Set<string>> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
  // Service role, and resolved fresh — same reasoning as warehouse
  // connections: a cached grant survives revocation, and reading the grant
  // tables under the asker's RLS would let the asker influence the answer.
  return resolveGrantedResourceIds(supabaseAdmin, userId, "saas_connection");
}

async function loadConnection(
  sb: ReturnType<typeof userClient>,
  userId: string,
  id: string,
  opts: { allowShared?: boolean } = {},
): Promise<{ name: string; config: SaasConfig; streams: string[]; ownerUserId: string }> {
  const granted = opts.allowShared ? await grantedConnectionIds(userId) : new Set<string>();
  const isShared = granted.has(id);
  // A shared row is not readable under the grantee's RLS — by design, since it
  // holds the credential — so it is fetched with the service role once a grant
  // has been established, never before.
  const client = isShared
    ? (await import("@/integrations/supabase/client.server")).supabaseAdmin
    : sb;

  let q = client.from("saas_connections").select("name, config, streams, is_active, user_id");
  q = q.eq("id", id);
  if (!isShared) q = q.eq("user_id", userId);

  const { data: row, error } = await q.maybeSingle();
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
    ownerUserId: row.user_id,
  };
}

export const listSaasConnections = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<SaasConnectionSummary[]> => {
    const { sb, userId } = await requireUser(data.access_token);
    // `config` is deliberately NOT selected — a summary must not be able to
    // leak ciphertext, let alone anything decrypted from it.
    // ONE STRING LITERAL, not a concatenation: supabase-js infers the row type
    // from the literal, and `a + b` widens it to `string` and collapses the
    // result to GenericStringError[].
    const COLS =
      "id, provider, name, is_active, last_sync_status, last_sync_error, last_synced_at, created_at, last_test_status, last_test_error, last_tested_at, credentials_rotated_at";
    const { data: rows, error } = await sb
      .from("saas_connections")
      .select(COLS)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const owned = (rows ?? []) as SaasConnectionSummary[];

    // Sources shared via IAM. Fetched with the service role because those rows
    // are deliberately not readable under the grantee's RLS.
    const grantedIds = [...(await grantedConnectionIds(userId))];
    if (grantedIds.length === 0) return owned;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const ownedIds = new Set(owned.map((c) => c.id));
    const { data: sharedRows } = await supabaseAdmin
      .from("saas_connections")
      .select(COLS)
      .in("id", grantedIds);
    return [
      ...owned,
      ...((sharedRows ?? []) as SaasConnectionSummary[])
        .filter((c) => !ownedIds.has(c.id))
        .map((c) => ({ ...c, shared: true })),
    ];
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
        sync_schedule: z.enum(SYNC_SCHEDULES).default("manual"),
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
      sync_schedule: data.sync_schedule,
      // See the warehouse save for why this is not updated_at: the health pass
      // and the sync writer both touch the row, and the trigger would keep
      // reporting every credential as freshly rotated.
      credentials_rotated_at: new Date().toISOString(),
      // Due immediately on save for a scheduled source, so the first run does
      // not wait a whole interval — and null for manual, which is what keeps
      // it out of the scheduler's index entirely.
      next_sync_at: data.sync_schedule === "manual" ? null : new Date().toISOString(),
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
    const config =
      data.config ?? (await loadConnection(sb, userId, data.id!, { allowShared: true })).config;
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
    const conn = await loadConnection(sb, userId, data.id, { allowShared: true });
    const streamIds = data.streams?.length ? data.streams : conn.streams;
    if (streamIds.length === 0) {
      throw new Error("No streams selected for this data source.");
    }

    // A SYNC ALWAYS RUNS AS THE CONNECTION'S OWNER, even when a grantee
    // triggered it. The datasets this source maintains belong to the owner and
    // already exist under their account; running as the caller would create a
    // parallel, half-populated copy under the grantee instead of refreshing
    // the real one — and would sync the owner's data into a second place.
    //
    // The service role is used for the same reason: a grantee cannot write to
    // the owner's row or datasets under their own RLS.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const isShared = conn.ownerUserId !== userId;
    const result = await runConnectionSync(isShared ? supabaseAdmin : sb, {
      id: data.id,
      userId: conn.ownerUserId,
      name: conn.name,
      config: conn.config,
      streamIds,
    });

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
        // Recorded because the actor and the account whose data moved differ
        // on a shared source. An audit entry that named only the trigger would
        // not answer "whose datasets changed".
        ...(isShared ? { triggered_by_grantee: true, owner_user_id: conn.ownerUserId } : {}),
      },
    });
    return result;
  });
