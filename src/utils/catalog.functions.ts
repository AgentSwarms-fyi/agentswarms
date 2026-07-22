// Server functions for the Data Catalog: register sources (warehouse
// connections or S3-compatible buckets), test connectivity, run crawls
// and delete sources. Bucket credentials are AES-GCM encrypted with the
// same server-side key as warehouse credentials and are never returned
// to the client; `{{secret:NAME}}` references from the Secrets Manager
// are resolved at crawl time.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { decryptJson, encryptJson } from "@/utils/providers/crypto.server";
import { resolveSecretRefsInObject } from "@/utils/secrets.server";
import { loadWarehouseConnection } from "@/utils/warehouse/connections.server";
import { runCrawl, type CrawlStats } from "@/utils/catalog/crawler.server";
import { testObjectStore, type ObjectStoreConfig } from "@/utils/catalog/objectStore.server";

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

const StorageConfigSchema = z.object({
  provider: z.enum(["aws", "r2", "minio", "spaces", "b2", "custom"]),
  endpoint: z.string().url().optional().or(z.literal("")),
  region: z.string().min(1).max(64),
  bucket: z.string().min(1).max(255),
  prefix: z.string().max(512).optional(),
  path_style: z.boolean().optional(),
  access_key_id: z.string().min(1).max(512),
  secret_access_key: z.string().min(1).max(512),
});

type StorageConfigInput = z.infer<typeof StorageConfigSchema>;

function normalizeStorage(cfg: StorageConfigInput): ObjectStoreConfig {
  return {
    provider: cfg.provider,
    endpoint: cfg.endpoint ? cfg.endpoint.replace(/\/+$/, "") : undefined,
    region: cfg.region.trim(),
    bucket: cfg.bucket.trim(),
    prefix: cfg.prefix?.replace(/^\/+/, "") || undefined,
    path_style: cfg.path_style ?? Boolean(cfg.endpoint),
    access_key_id: cfg.access_key_id.trim(),
    secret_access_key: cfg.secret_access_key,
  };
}

/** Resolve {{secret:NAME}} refs and decrypt a stored bucket config. */
async function loadStorageConfig(
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

type CatalogError = { ok: false; error: string };

export const catalogCreateSource = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-zA-Z0-9_\- .]+$/, "Letters, numbers, spaces, - _ . only"),
        kind: z.enum(["warehouse", "object_storage"]),
        connection_id: z.string().uuid().optional(),
        storage: StorageConfigSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<CatalogError | { ok: true; source_id: string }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);

      let config: Json = {};
      let credentials: Json | null = null;
      let connectionId: string | null = null;

      if (data.kind === "warehouse") {
        if (!data.connection_id) return { ok: false, error: "Pick a warehouse connection" };
        // Validates ownership (RLS) + that credentials decrypt.
        await loadWarehouseConnection(sb, { connectionId: data.connection_id }, userId);
        connectionId = data.connection_id;
      } else {
        if (!data.storage) return { ok: false, error: "Storage configuration is required" };
        const cfg = normalizeStorage(data.storage);
        if (!cfg.endpoint && cfg.provider !== "aws") {
          return { ok: false, error: "This provider needs an endpoint URL" };
        }
        // Connectivity check before anything is stored (secret refs resolved).
        const live = (await resolveSecretRefsInObject(
          userId,
          cfg as unknown as Record<string, unknown>,
        )) as unknown as ObjectStoreConfig;
        await testObjectStore(live);
        const { access_key_id: _a, secret_access_key: _s, ...publicCfg } = cfg;
        config = publicCfg as unknown as Json;
        credentials = (await encryptJson(cfg)) as unknown as Json;
      }

      const { data: row, error } = await sb
        .from("catalog_sources")
        .insert({
          user_id: userId,
          kind: data.kind,
          name: data.name.trim(),
          connection_id: connectionId,
          config,
          credentials,
        })
        .select("id")
        .single();
      if (error || !row) {
        return {
          ok: false,
          error: error?.code === "23505" ? "A source with this name already exists" : (error?.message ?? "Failed"),
        };
      }
      return { ok: true, source_id: row.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Failed" };
    }
  });

export const catalogCrawlSource = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), source_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<CatalogError | { ok: true; stats: CrawlStats }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      // Ownership via RLS: invisible rows simply don't come back.
      const { data: source, error } = await sb
        .from("catalog_sources")
        .select("*")
        .eq("id", data.source_id)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!source) return { ok: false, error: "Source not found" };
      if (source.status === "crawling") return { ok: false, error: "A crawl is already running" };

      const stats = await runCrawl(
        userId,
        source,
        async (connectionId) =>
          (await loadWarehouseConnection(sb, { connectionId }, userId)).config,
        async (src) => loadStorageConfig(userId, src),
      );
      return { ok: true, stats };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Crawl failed" };
    }
  });

export const catalogDeleteSource = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), source_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<CatalogError | { ok: true }> => {
    try {
      const { sb } = await requireUser(data.access_token);
      const { error } = await sb.from("catalog_sources").delete().eq("id", data.source_id);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Failed" };
    }
  });
