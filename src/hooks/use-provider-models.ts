// Live model catalogue for connected providers, fetched once per app session.
//
// Provider catalogues move — OpenRouter in particular adds and removes free
// models continuously — so a hard-coded list is wrong within weeks. This
// refreshes on app open instead: one call per provider, cached in memory for
// the session and mirrored to sessionStorage so a page navigation or reload
// doesn't re-fetch.
import { useCallback, useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { listProviderModels, type ProviderModelInfo } from "@/utils/providerModels.functions";

const CACHE_PREFIX = "as:provider-models:";

/** In-flight requests, so concurrent mounts share one fetch per provider. */
const inflight = new Map<string, Promise<ProviderModelInfo[]>>();
const memory = new Map<string, ProviderModelInfo[]>();

function readSession(provider: string): ProviderModelInfo[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + provider);
    return raw ? (JSON.parse(raw) as ProviderModelInfo[]) : null;
  } catch {
    return null;
  }
}

function writeSession(provider: string, models: ProviderModelInfo[]): void {
  try {
    sessionStorage.setItem(CACHE_PREFIX + provider, JSON.stringify(models));
  } catch {
    /* private mode / quota — the in-memory cache still works */
  }
}

/**
 * Fetch a provider's models, deduped across callers and cached for the session.
 *
 * Failure caches an empty list rather than retrying on every mount: a provider
 * that isn't connected, or whose key is rejected, would otherwise fire a
 * request from every picker on every render pass.
 */
export async function loadProviderModels(
  provider: string,
  opts: { force?: boolean } = {},
): Promise<ProviderModelInfo[]> {
  if (!opts.force) {
    const mem = memory.get(provider);
    if (mem) return mem;
    const cached = readSession(provider);
    if (cached) {
      memory.set(provider, cached);
      return cached;
    }
    const pending = inflight.get(provider);
    if (pending) return pending;
  }

  const run = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return [];
      const res = await listProviderModels({ data: { access_token: token, provider } });
      const models = res.ok ? res.models : [];
      memory.set(provider, models);
      writeSession(provider, models);
      return models;
    } catch {
      memory.set(provider, []);
      return [];
    } finally {
      inflight.delete(provider);
    }
  })();
  inflight.set(provider, run);
  return run;
}

/** Drop the cache so the next read re-fetches (after connecting a provider). */
export function invalidateProviderModels(provider?: string): void {
  if (provider) {
    memory.delete(provider);
    try {
      sessionStorage.removeItem(CACHE_PREFIX + provider);
    } catch {
      /* ignore */
    }
    return;
  }
  memory.clear();
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(CACHE_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Warm the catalogue for every connected provider, once per app session.
 *
 * Called from the authenticated layout so pickers open with a current list
 * instead of fetching (or showing something stale) on first use. Providers
 * already cached are skipped, so this costs nothing after the first mount.
 */
export function usePrefetchProviderModels(): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.from("integrations").select("provider, type, is_active");
      if (cancelled || !data) return;
      const providers = Array.from(
        new Set(
          data
            .filter((r) => r.is_active !== false && (r.type === "llm" || r.type === null))
            .map((r) => r.provider)
            .filter((p): p is string => Boolean(p)),
        ),
      );
      // Sequential, not parallel: this runs in the background behind whatever
      // the user is actually doing, and a burst of provider calls on every app
      // open is rude to both the browser and the providers.
      for (const p of providers) {
        if (cancelled) return;
        if (memory.has(p)) continue;
        await loadProviderModels(p);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

/** The live catalogue for one provider. `null` while the first load is in flight. */
export function useProviderModels(provider: string | null | undefined): {
  models: ProviderModelInfo[] | null;
  free: ProviderModelInfo[];
  refresh: () => void;
} {
  const [models, setModels] = useState<ProviderModelInfo[] | null>(() =>
    provider ? (memory.get(provider) ?? null) : [],
  );

  const load = useCallback(
    (force = false) => {
      if (!provider) {
        setModels([]);
        return;
      }
      let cancelled = false;
      void loadProviderModels(provider, { force }).then((m) => {
        if (!cancelled) setModels(m);
      });
      return () => {
        cancelled = true;
      };
    },
    [provider],
  );

  useEffect(() => load(), [load]);

  return {
    models,
    free: (models ?? []).filter((m) => m.free),
    refresh: () => {
      if (provider) invalidateProviderModels(provider);
      load(true);
    },
  };
}
