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
import { isBiCompatProvider, isTextModelId } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";

export type ProviderModelInfo = {
  id: string;
  name: string | null;
  /** Costs nothing to call — see isFreeModel. Absent means "not known to be free". */
  free?: boolean;
  /** Context window in tokens, when the provider publishes one. */
  context?: number;
};

/**
 * Whether a listed model is free to call.
 *
 * OpenRouter's catalogue moves — models gain and lose free variants, and the
 * `:free` suffix is a naming convention, not a guarantee. So the price fields
 * are the authority and the suffix is only a fallback for providers that don't
 * publish pricing. Read live rather than hard-coded, because a hard-coded list
 * is wrong within weeks.
 */
function isFreeModel(m: RawModel): boolean {
  const p = m.pricing;
  if (p && (p.prompt !== undefined || p.completion !== undefined)) {
    const num = (v: string | number | undefined) => (v === undefined ? NaN : Number(v));
    const prompt = num(p.prompt);
    const completion = num(p.completion);
    // Both must be known and zero — a model free on input but billed on output
    // is not free, and NaN (unparseable) must not read as 0.
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      return prompt === 0 && completion === 0;
    }
  }
  return /:free$/i.test(m.id ?? "");
}

// Image-OUTPUT model detection for /models responses. OpenRouter publishes
// modality strings like "text+image->text+image"; other providers get an
// id heuristic (kept in sync with isImageModelId in lib/providerSupport).
const IMAGE_OUT_MODALITY_RE = /->[^>]*image/i;
const IMAGE_ID_RE =
  /(^|\/|[-.])(gpt-image|imagen|image|dall-e|flux|stable-diffusion|sdxl|photon|recraft|ideogram)([-.\d]|$)/i;
const NEVER_IMAGE_RE = /embed|whisper|tts|audio|moderation|transcri|rerank/i;

type RawModel = {
  id?: string;
  name?: string;
  architecture?: { modality?: string };
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
};

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
  // The timer stays armed until the BODY is read: fetch() resolves on headers,
  // so clearing it there leaves the read itself unbounded against a slow host.
  let r: Response;
  let payload: string;
  try {
    r = await fetch(url, {
      headers: {
        ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
        ...(transport.extraHeaders ?? {}),
      },
      signal: ctrl.signal,
    });
    payload = await r.text();
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) return { ok: false, error: `The models endpoint returned ${r.status}` };
  const body = JSON.parse(payload || "{}") as { data?: RawModel[] };
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
          // Text-output models only. OpenRouter publishes modality strings
          // ("text->text", "text+image->text") — trust them; providers without
          // modality metadata fall back to the shared id heuristic.
          if (modality) {
            if (!/->text$/.test(modality)) continue;
          } else if (!isTextModelId(m.id)) {
            continue;
          }
          seen.add(m.id);
          models.push({
            id: m.id,
            name: m.name ?? null,
            free: isFreeModel(m) || undefined,
            context: m.context_length,
          });
          if (models.length >= 600) break;
        }
        // Free models first, then alphabetical. Someone scanning the list for
        // something that costs nothing should not have to hunt for it.
        models.sort((a, b) => (a.free === b.free ? a.id.localeCompare(b.id) : a.free ? -1 : 1));
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
          const isImage = modality ? IMAGE_OUT_MODALITY_RE.test(modality) : IMAGE_ID_RE.test(m.id);
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
