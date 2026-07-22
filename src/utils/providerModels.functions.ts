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

// Image-OUTPUT model detection for /models responses. OpenRouter publishes
// modality strings like "text+image->text+image"; other providers get an
// id heuristic (kept in sync with isImageModelId in lib/providerSupport).
const IMAGE_OUT_MODALITY_RE = /->[^>]*image/i;
const IMAGE_ID_RE =
  /(^|\/|[-.])(gpt-image|imagen|image|dall-e|flux|stable-diffusion|sdxl|photon|recraft|ideogram)([-.\d]|$)/i;
const NEVER_IMAGE_RE = /embed|whisper|tts|audio|moderation|transcri|rerank/i;

// Obvious non-chat model ids (embeddings, speech, image gen…) for providers
// whose /models response carries no modality metadata.
const NON_TEXT_RE = /embed|whisper|tts|audio|moderation|dall-e|realtime|transcri|image-gen/i;

type RawModel = { id?: string; name?: string; architecture?: { modality?: string } };

/** Fetch a provider's raw /models list with the caller's credentials. */
async function fetchProviderModels(
  accessToken: string,
  provider: string,
): Promise<{ ok: true; raw: RawModel[] } | { ok: false; error: string }> {
  const { data: auth, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !auth.user) return { ok: false, error: "Unauthorized" };
  if (!isBiCompatProvider(provider)) {
    return { ok: false, error: `Unsupported provider "${provider}"` };
  }
  const transport = await resolveOpenAICompatTransport({
    userId: auth.user.id,
    provider: provider as ProviderId,
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
  const body = (await r.json()) as { data?: RawModel[] };
  return { ok: true, raw: body.data ?? [] };
}

export const listProviderModels = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), provider: z.string().min(1) }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; models: ProviderModelInfo[] } | { ok: false; error: string }> => {
      try {
        const res = await fetchProviderModels(data.access_token, data.provider);
        if (!res.ok) return res;
        const models: ProviderModelInfo[] = [];
        const seen = new Set<string>();
        for (const m of res.raw) {
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

/** Image-GENERATION models a connected provider can serve. */
export const listProviderImageModels = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), provider: z.string().min(1) }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; models: ProviderModelInfo[] } | { ok: false; error: string }> => {
      try {
        const res = await fetchProviderModels(data.access_token, data.provider);
        if (!res.ok) return res;
        const models: ProviderModelInfo[] = [];
        const seen = new Set<string>();
        for (const m of res.raw) {
          if (!m.id || seen.has(m.id) || NEVER_IMAGE_RE.test(m.id)) continue;
          // Router meta-models ("openrouter/auto") advertise image output but
          // can't be dispatched through the image-generation branch.
          if (/^openrouter\//i.test(m.id)) continue;
          const modality = m.architecture?.modality;
          const isImage = modality
            ? IMAGE_OUT_MODALITY_RE.test(modality)
            : IMAGE_ID_RE.test(m.id);
          if (!isImage) continue;
          seen.add(m.id);
          models.push({ id: m.id, name: m.name ?? null });
          if (models.length >= 200) break;
        }
        // Drop stale preview/experimental variants when the released model
        // is also listed (e.g. "…-image-preview" alongside "…-image"), so
        // the picker shows one entry per model instead of duplicates.
        const ids = new Set(models.map((m) => m.id));
        const deduped = models.filter((m) => {
          const base = m.id.replace(/[-_](preview|exp|experimental|beta|latest)$/i, "");
          return base === m.id || !ids.has(base);
        });
        return { ok: true, models: deduped };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed to list models" };
      }
    },
  );
