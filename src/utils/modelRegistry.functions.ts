// Server-side helpers + RPC for the Model Registry feature.
// The actual sync implementation lives in `modelRegistry.server.ts` so the
// cron route can import it without pulling client-blocked modules.
import { createServerFn } from "@tanstack/react-start";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperadmin } from "@/utils/iam.server";
import { syncModelRegistryFromAimlapi } from "@/utils/modelRegistry.server";
import { z } from "zod";

// --- Public types --------------------------------------------------------

export type RegistryModel = {
  id: string;
  model_id: string;
  alias: string | null;
  display_name: string;
  developer: string;
  provider_slug: string;
  description: string | null;
  context_length: number | null;
  output_max: number | null;
  modality: string;
  capabilities: string[];
  docs_url: string | null;
  source: string;
  last_seen_at: string;
};

export type RegistryMeta = {
  last_synced_at: string | null;
  last_sync_status: string | null;
  last_sync_count: number | null;
  last_sync_error: string | null;
};

// --- Read RPC (browse) ---------------------------------------------------

export const getModelRegistry = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const Schema = z.object({ access_token: z.string().min(1) });
    return Schema.parse(input);
  })
  .handler(async ({ data }): Promise<{ models: RegistryModel[]; meta: RegistryMeta | null }> => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Server not configured");
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${data.access_token}` } },
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authErr } = await sb.auth.getUser();
    if (authErr || !userData?.user) throw new Error("Unauthorized");

    const [{ data: rows, error }, { data: metaRow }] = await Promise.all([
      supabaseAdmin
        .from("model_registry")
        .select(
          "id, model_id, alias, display_name, developer, provider_slug, description, context_length, output_max, modality, capabilities, docs_url, source, last_seen_at",
        )
        .order("developer", { ascending: true })
        .order("display_name", { ascending: true })
        .limit(2000),
      supabaseAdmin
        .from("model_registry_meta")
        .select("last_synced_at, last_sync_status, last_sync_count, last_sync_error")
        .eq("id", 1)
        .maybeSingle(),
    ]);
    if (error) throw new Error(error.message);
    return {
      models: (rows || []) as RegistryModel[],
      meta: (metaRow as RegistryMeta) || null,
    };
  });

// Server function so an admin can trigger a sync from the UI.
export const triggerModelRegistrySync = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const Schema = z.object({ access_token: z.string().min(1) });
    return Schema.parse(input);
  })
  .handler(async ({ data }) => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) {
      return { ok: false, error: "Only a superadmin can trigger a manual sync" };
    }
    return syncModelRegistryFromAimlapi();
  });
