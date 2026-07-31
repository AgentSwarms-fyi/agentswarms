// Server-only helpers for the Model Registry feature.
// Kept separate from `modelRegistry.functions.ts` so route handlers (cron) can
// import the sync logic without dragging server-only modules into the client
// bundle via the `.functions.ts` file.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type AimlEntry = {
  id?: string;
  type?: string;
  aliases?: string[];
  tags?: string[];
  info?: {
    name?: string;
    developer?: string;
    description?: string;
    contextLength?: number;
    outputMax?: number;
    url?: string;
    docsUrl?: string;
  };
};

// Map developer label → stable lowercase slug used for filtering.
function devToSlug(dev: string): string {
  const d = (dev || "").trim().toLowerCase();
  if (!d) return "other";
  if (d.includes("open ai") || d === "openai") return "openai";
  if (d.includes("anthropic")) return "anthropic";
  if (d === "google" || d.includes("google")) return "google";
  if (d.includes("alibaba") || d.includes("qwen")) return "alibaba";
  if (d.includes("deepseek")) return "deepseek";
  if (d.includes("x ai") || d === "xai") return "xai";
  if (d.includes("meta")) return "meta";
  if (d.includes("mistral")) return "mistral";
  if (d.includes("zhipu")) return "zhipu";
  if (d.includes("moonshot")) return "moonshot";
  if (d.includes("cohere")) return "cohere";
  if (d.includes("perplexity")) return "perplexity";
  if (d.includes("nvidia")) return "nvidia";
  if (d.includes("baidu")) return "baidu";
  if (d.includes("bytedance")) return "bytedance";
  if (d.includes("kling")) return "kling";
  if (d.includes("minimax")) return "minimax";
  if (d.includes("flux") || d.includes("black forest")) return "flux";
  if (d.includes("runway")) return "runway";
  if (d.includes("eleven")) return "elevenlabs";
  if (d.includes("deepgram")) return "deepgram";
  if (d.includes("pixverse")) return "pixverse";
  if (d.includes("ltxv") || d.includes("lightricks")) return "lightricks";
  if (d.includes("magic")) return "magic";
  if (d.includes("inworld")) return "inworld";
  return d.replace(/\s+/g, "-");
}

function inferModality(type: string, tags: string[]): string {
  const t = type.toLowerCase();
  const tagSet = new Set(tags.map((x) => x.toLowerCase()));
  if (t.includes("embedding") || tagSet.has("playground:embeddings")) return "embedding";
  if (t.includes("image") || tagSet.has("playground:image") || tagSet.has("playground:image_3d"))
    return "image";
  if (t.includes("video") || tagSet.has("playground:video")) return "video";
  if (t.includes("speech-to-text") || t.includes("stt") || tagSet.has("playground:stt"))
    return "speech-to-text";
  if (t.includes("text-to-speech") || t.includes("tts") || tagSet.has("playground:tts"))
    return "text-to-speech";
  if (t.includes("audio") || tagSet.has("playground:audio") || tagSet.has("playground:chat_audio"))
    return "audio";
  if (t.includes("ocr") || tagSet.has("playground:ocr")) return "ocr";
  return "text";
}

function inferCapabilities(modality: string, tags: string[], description: string): string[] {
  const caps = new Set<string>();
  const tagSet = new Set(tags.map((x) => x.toLowerCase()));
  const desc = (description || "").toLowerCase();
  if (modality === "text" || tagSet.has("playground:chat")) caps.add("chat");
  if (tagSet.has("playground:code") || desc.includes("code")) caps.add("code");
  if (modality === "image") caps.add("image-gen");
  if (modality === "video") caps.add("video-gen");
  if (modality === "embedding") caps.add("embeddings");
  if (modality === "speech-to-text") caps.add("transcription");
  if (modality === "text-to-speech") caps.add("voice-synth");
  if (modality === "ocr") caps.add("ocr");
  if (modality === "audio") caps.add("audio");
  if (desc.includes("vision") || desc.includes("image input") || desc.includes("multimodal"))
    caps.add("vision");
  if (desc.includes("tool") || desc.includes("function call")) caps.add("tools");
  if (desc.includes("reason")) caps.add("reasoning");
  if (desc.includes("long context") || desc.includes("1m token") || desc.includes("million token"))
    caps.add("long-context");
  return Array.from(caps);
}

function normalize(entry: AimlEntry): {
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
  raw: AimlEntry;
} | null {
  const id = (entry.id || "").trim();
  if (!id) return null;
  const info = entry.info || {};
  const developer = (info.developer || "Unknown").trim();
  const tags = entry.tags || [];
  const type = entry.type || "";
  const modality = inferModality(type, tags);
  const description = (info.description || "").trim() || null;
  return {
    model_id: id,
    alias:
      Array.isArray(entry.aliases) && entry.aliases.length > 0 ? String(entry.aliases[0]) : null,
    display_name: (info.name || id).trim(),
    developer,
    provider_slug: devToSlug(developer),
    description,
    context_length: typeof info.contextLength === "number" ? info.contextLength : null,
    output_max: typeof info.outputMax === "number" ? info.outputMax : null,
    modality,
    capabilities: inferCapabilities(modality, tags, description || ""),
    docs_url: info.docsUrl || info.url || null,
    raw: entry,
  };
}

export async function syncModelRegistryFromAimlapi(): Promise<{
  ok: boolean;
  count: number;
  error?: string;
}> {
  const startedAt = new Date().toISOString();
  try {
    const r = await fetch("https://api.aimlapi.com/models", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`AIMLAPI ${r.status}: ${t.slice(0, 300)}`);
    }
    const json = (await r.json()) as { data?: AimlEntry[] };
    const entries = Array.isArray(json.data) ? json.data : [];

    const seen = new Map<string, ReturnType<typeof normalize>>();
    for (const e of entries) {
      const norm = normalize(e);
      if (!norm) continue;
      const key = `${norm.model_id}::${norm.modality}`;
      if (!seen.has(key)) seen.set(key, norm);
    }
    const rows = Array.from(seen.values()).filter(Boolean) as Array<
      NonNullable<ReturnType<typeof normalize>>
    >;

    const BATCH = 200;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH).map((n) => ({
        ...n,
        source: "aimlapi",
        last_seen_at: startedAt,
      }));
      const { error } = await supabaseAdmin
        .from("model_registry")
        .upsert(slice, { onConflict: "source,model_id,modality" });
      if (error) throw new Error(`upsert batch failed: ${error.message}`);
      upserted += slice.length;
    }

    const { error: pruneErr } = await supabaseAdmin
      .from("model_registry")
      .delete()
      .eq("source", "aimlapi")
      .lt("last_seen_at", startedAt);
    if (pruneErr) throw new Error(`prune failed: ${pruneErr.message}`);

    await supabaseAdmin
      .from("model_registry_meta")
      .update({
        last_synced_at: new Date().toISOString(),
        last_sync_status: "success",
        last_sync_count: upserted,
        last_sync_error: null,
      })
      .eq("id", 1);

    return { ok: true, count: upserted };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin
      .from("model_registry_meta")
      .update({
        last_synced_at: new Date().toISOString(),
        last_sync_status: "error",
        last_sync_error: msg.slice(0, 500),
      })
      .eq("id", 1);
    return { ok: false, count: 0, error: msg };
  }
}
