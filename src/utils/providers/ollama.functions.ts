// Ollama server functions: detection + live model listing.
//
// Ollama runs next to (or reachable from) the AgentSwarms SERVER, so both
// probes happen server-side — the browser can't reach a localhost daemon on
// the server host. `detectOllama` powers the one-click connect flow on
// /integrations (probe the default localhost:11434, or whatever address the
// user typed); `listOllamaModels` reads the caller's saved Ollama
// integration and returns the models actually installed there, so every
// model picker can offer real tags instead of static guesses.

import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DEFAULT_ENDPOINT = "http://localhost:11434";

type OllamaProbe = {
  running: boolean;
  endpoint: string;
  models: string[];
  detail: string;
};

async function probeOllama(endpointRaw: string): Promise<OllamaProbe> {
  const endpoint = endpointRaw.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${endpoint}/api/tags`, { signal: ctrl.signal });
    if (!r.ok) {
      return {
        running: false,
        endpoint,
        models: [],
        detail: `Reached ${endpoint} but /api/tags returned ${r.status} — is this an Ollama server?`,
      };
    }
    const j = (await r.json().catch(() => null)) as { models?: Array<{ name?: string }> } | null;
    const models = (j?.models ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name : ""))
      .filter(Boolean)
      .sort();
    return {
      running: true,
      endpoint,
      models,
      detail:
        models.length > 0
          ? `Ollama is running (${models.length} model${models.length === 1 ? "" : "s"} installed)`
          : "Ollama is running but has no models yet — pull one with `ollama pull llama3.2`",
    };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
    return {
      running: false,
      endpoint,
      models: [],
      detail: `Could not reach ${endpoint} (${msg})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function requireUser(accessToken: string | undefined): Promise<string | null> {
  if (!accessToken) return null;
  const { data } = await supabaseAdmin.auth.getUser(accessToken);
  return data.user?.id ?? null;
}

/** Probe an Ollama server from the AgentSwarms server (default: localhost). */
export const detectOllama = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const d = (input ?? {}) as { access_token?: string; endpoint?: string };
    return {
      access_token: typeof d.access_token === "string" ? d.access_token : undefined,
      endpoint:
        typeof d.endpoint === "string" && d.endpoint.trim() ? d.endpoint.trim().slice(0, 300) : "",
    };
  })
  .handler(async ({ data }): Promise<OllamaProbe> => {
    const userId = await requireUser(data.access_token);
    if (!userId) {
      return { running: false, endpoint: "", models: [], detail: "Not signed in" };
    }
    return probeOllama(data.endpoint || DEFAULT_ENDPOINT);
  });

/** Models installed on the caller's CONNECTED Ollama integration. */
export const listOllamaModels = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const d = (input ?? {}) as { access_token?: string };
    return { access_token: typeof d.access_token === "string" ? d.access_token : undefined };
  })
  .handler(
    async ({ data }): Promise<{ connected: boolean; endpoint: string; models: string[] }> => {
      const userId = await requireUser(data.access_token);
      if (!userId) return { connected: false, endpoint: "", models: [] };
      const { data: row } = await supabaseAdmin
        .from("integrations")
        .select("config, is_active")
        .eq("user_id", userId)
        .eq("provider", "ollama")
        .eq("is_active", true)
        .maybeSingle();
      if (!row) return { connected: false, endpoint: "", models: [] };
      const cfg = (row.config ?? {}) as { endpoint?: string };
      const probe = await probeOllama(cfg.endpoint || DEFAULT_ENDPOINT);
      return { connected: true, endpoint: probe.endpoint, models: probe.models };
    },
  );
