// Server-side helpers + RPC for the Model Registry feature.
// The actual sync implementation lives in `modelRegistry.server.ts` so the
// cron route can import it without pulling client-blocked modules.
import { createServerFn } from "@tanstack/react-start";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperadmin } from "@/utils/iam.server";
import { syncModelRegistryFromAimlapi } from "@/utils/modelRegistry.server";
import { envInt } from "@/utils/rateLimit.server";
import { pageTraces } from "@/lib/traceWindow";
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
  .handler(
    async ({
      data,
    }): Promise<{ models: RegistryModel[]; meta: RegistryMeta | null; total: number }> => {
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

      // The count BEFORE the rows, so the page can tell a complete catalogue
      // from a prefix of one. The read used to be a single `.limit(2000)`,
      // which had no way to know the difference — and whose 2,000 was fiction
      // besides: PostgREST caps responses at max-rows, 1,000 on this
      // deployment, so above that the limit was silently halved.
      const [{ count, error: countError }, { data: metaRow }] = await Promise.all([
        supabaseAdmin.from("model_registry").select("id", { count: "exact", head: true }),
        supabaseAdmin
          .from("model_registry_meta")
          .select("last_synced_at, last_sync_status, last_sync_count, last_sync_error")
          .eq("id", 1)
          .maybeSingle(),
      ]);

      // PAGE matches the PostgREST max-rows default so each range() is one full
      // page; MAX_ROWS bounds the work on a deployment whose registry has grown,
      // and is an env knob rather than a constant because the catalogue upstream
      // only gets bigger. The ordering carries `id` last: two rows can share a
      // developer and a display name across modalities, and a page boundary
      // landing inside such a tie is how paging starts repeating or skipping.
      const PAGE = 1000;
      const MAX_ROWS = Math.max(PAGE, envInt("MODEL_REGISTRY_MAX_ROWS", 5000));
      const models = await pageTraces<RegistryModel>(
        async (offset, pageSize) => {
          const { data: rows, error } = await supabaseAdmin
            .from("model_registry")
            .select(
              "id, model_id, alias, display_name, developer, provider_slug, description, context_length, output_max, modality, capabilities, docs_url, source, last_seen_at",
            )
            .order("developer", { ascending: true })
            .order("display_name", { ascending: true })
            .order("id", { ascending: true })
            .range(offset, offset + pageSize - 1);
          if (error) throw new Error(error.message);
          return { rows: (rows || []) as RegistryModel[] };
        },
        { pageSize: PAGE, maxRows: MAX_ROWS },
      );

      return {
        models,
        meta: (metaRow as RegistryMeta) || null,
        // A count that failed does not fail the page — rows on screen beat a
        // perfect label — but then the label may only claim what it holds.
        total: countError ? models.length : (count ?? models.length),
      };
    },
  );

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
