// Live model discovery for connected providers. Every OpenAI-compatible
// provider exposes GET {base}/models; this server fn calls it with the
// CALLER's own credentials (resolved exactly like chat/BI calls, incl.
// {{secret:}} refs and the operator OpenRouter fallback) so pickers always
// list what the integration can actually serve — refreshed per app session,
// no registry sync required.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOpenAICompatTransport } from "@/utils/providers/credentials.server";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";

export type ProviderModelInfo = { id: string; name: string | null };

// Obvious non-chat model ids (embeddings, speech, image gen…) for providers
// whose /models response carries no modality metadata.
const NON_TEXT_RE = /embed|whisper|tts|audio|moderation|dall-e|realtime|transcri|image-gen/i;

export const listProviderModels = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), provider: z.string().min(1) }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; models: ProviderModelInfo[] } | { ok: false; error: string }> => {
      try {
        const { data: auth, error } = await supabaseAdmin.auth.getUser(data.access_token);
        if (error || !auth.user) return { ok: false, error: "Unauthorized" };
        if (!isBiCompatProvider(data.provider)) {
          return { ok: false, error: `Unsupported provider "${data.provider}"` };
        }
        const transport = await resolveOpenAICompatTransport({
          userId: auth.user.id,
          provider: data.provider as ProviderId,
        });
        if (!transport) return { ok: false, error: "Provider not configured" };

        const url = transport.endpointUrl.replace(/\/chat\/completions\/?$/, "/models");
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12_000);
        const r = await fetch(url, {
          headers: {
            ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
            ...(transport.extraHeaders ?? {}),
          },
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timer));
        if (!r.ok) return { ok: false, error: `The models endpoint returned ${r.status}` };

        const body = (await r.json()) as {
          data?: Array<{ id?: string; name?: string; architecture?: { modality?: string } }>;
        };
        const models: ProviderModelInfo[] = [];
        const seen = new Set<string>();
        for (const m of body.data ?? []) {
          if (!m.id || seen.has(m.id)) continue;
          const modality = m.architecture?.modality;
          // Text-output models only: OpenRouter publishes modality strings
          // ("text->text", "text+image->text"); others get an id heuristic.
          if (modality && !/->text$/.test(modality)) continue;
          if (!modality && NON_TEXT_RE.test(m.id)) continue;
          seen.add(m.id);
          models.push({ id: m.id, name: m.name ?? null });
          if (models.length >= 600) break;
        }
        return { ok: true, models };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed to list models" };
      }
    },
  );
