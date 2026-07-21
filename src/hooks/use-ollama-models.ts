// Live model list for a connected Ollama integration, shared by every
// provider/model picker. Fetched once per session (module cache) — the
// server probes the user's saved Ollama endpoint and returns the tags that
// are actually installed, so pickers can offer real models instead of the
// static fallback suggestions.
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { listOllamaModels } from "@/utils/providers/ollama.functions";

type OllamaModelsState = { connected: boolean; models: string[] };

let cache: OllamaModelsState | null = null;
let inflight: Promise<OllamaModelsState> | null = null;

async function fetchOllamaModels(): Promise<OllamaModelsState> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { connected: false, models: [] };
  try {
    const res = await listOllamaModels({ data: { access_token: token } });
    return { connected: res.connected, models: res.models };
  } catch {
    return { connected: false, models: [] };
  }
}

/** Invalidate after connect/disconnect so pickers refetch. */
export function invalidateOllamaModels(): void {
  cache = null;
  inflight = null;
}

export function useOllamaModels(active: boolean): OllamaModelsState & { loading: boolean } {
  const [state, setState] = useState<OllamaModelsState | null>(cache);

  useEffect(() => {
    if (!active || cache) return;
    let cancelled = false;
    inflight ??= fetchOllamaModels().then((res) => {
      cache = res;
      return res;
    });
    void inflight.then((res) => {
      if (!cancelled) setState(res);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return {
    connected: state?.connected ?? false,
    models: state?.models ?? [],
    loading: active && state === null,
  };
}
