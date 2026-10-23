import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import {
  getInstanceProviderStatus,
  type InstanceProviderStatus,
} from "@/utils/providers/instanceProviders.functions";

/** Session-wide preferred BI model choice, persisted. */
export function useBiModelPref(): [string | null, (m: string | null) => void] {
  const [model, setModel] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(BI_MODEL_STORAGE_KEY) || null;
    } catch {
      return null;
    }
  });
  const update = (m: string | null) => {
    setModel(m);
    try {
      if (m) window.localStorage.setItem(BI_MODEL_STORAGE_KEY, m);
      else window.localStorage.removeItem(BI_MODEL_STORAGE_KEY);
    } catch {
      /* private mode */
    }
  };
  return [model, update];
}

/**
 * Connected LLM providers, merged from both stores.
 *
 * MEASURED: this used to `?? []` both reads and resolve successfully on
 * failure, so a 403 produced an empty list rather than an error — and every
 * caller then said the user had connected nothing. Worse, `integrationsPromise
 * ??=` MEMOISED that empty result: a second call returned the same empty list
 * without touching the network, so one transient failure claimed "no providers
 * connected" for the rest of the session, with a reload the only way out.
 *
 * Now the reads' errors are thrown, and a rejected attempt clears the memo so
 * the next caller retries. Only a SUCCESSFUL result is cached.
 */
export function fetchConnectedIntegrations(): Promise<ConnectedIntegration[]> {
  // Provider connections live in TWO stores (mirroring /integrations):
  // the legacy `integrations` table (type llm_provider, config jsonb) and
  // the newer `provider_credentials` table. Merge both, RLS-scoped.
  integrationsPromise ??= Promise.all([
    Promise.resolve(
      supabase
        .from("integrations")
        .select("provider, config, is_active")
        .eq("type", "llm_provider"),
    ),
    Promise.resolve(
      supabase.from("provider_credentials").select("provider, default_model, is_active"),
    ),
    // The instance-wide key is a THIRD source, and the one these pickers used
    // to miss. An operator who sets OPENROUTER_API_KEY expects OpenRouter to
    // work everywhere without anyone connecting anything; agent chat and
    // swarms already behave that way. A failure here is not fatal — it just
    // means we fall back to whatever the two tables hold.
    getInstanceProviderStatus().catch(
      () => ({ openrouter: false, openrouterDefaultModel: null }) as InstanceProviderStatus,
    ),
  ])
    .then(([legacy, creds, instance]) => {
      // A failed read is not an account without providers. Throwing here is
      // what lets callers tell "you have none" from "we could not find out".
      if (legacy.error) throw new Error(legacy.error.message);
      if (creds.error) throw new Error(creds.error.message);
      return [legacy, creds, instance] as const;
    })
    .then(([legacy, creds, instance]) => {
      const byProvider = new Map<string, ConnectedIntegration>();
      for (const r of legacy.data ?? []) {
        if (r.is_active === false || !r.provider || !isBiCompatProvider(r.provider)) continue;
        const cfg = (r.config ?? {}) as Record<string, unknown>;
        const dm =
          (typeof cfg.default_model === "string" && cfg.default_model) ||
          (typeof cfg.model === "string" && cfg.model) ||
          null;
        const prev = byProvider.get(r.provider);
        byProvider.set(r.provider, {
          provider: r.provider,
          default_model: prev?.default_model ?? dm,
        });
      }
      for (const r of creds.data ?? []) {
        if (r.is_active === false || !isBiCompatProvider(r.provider)) continue;
        const prev = byProvider.get(r.provider);
        byProvider.set(r.provider, {
          provider: r.provider,
          default_model: r.default_model ?? prev?.default_model ?? null,
        });
      }
      // Added last and only when absent, so a user's own OpenRouter key --
      // with their own default model and billing -- always takes precedence
      // over the instance one.
      if (instance.openrouter && !byProvider.has("openrouter")) {
        byProvider.set("openrouter", {
          provider: "openrouter",
          default_model: instance.openrouterDefaultModel,
        });
      }
      integrationsCache = [...byProvider.values()];
      return integrationsCache;
    })
    .catch((e: unknown) => {
      // Never leave a failure memoised — the next caller must be able to try
      // again without a page reload.
      integrationsPromise = null;
      throw e;
    });
  return integrationsPromise;
}

export const BI_MODEL_STORAGE_KEY = "agentswarms.bi_model";

export type ConnectedIntegration = { provider: string; default_model: string | null };

let integrationsCache: ConnectedIntegration[] | null = null;

/** The integrations a fetch already found, or null before one has finished. */
export function cachedIntegrations(): ConnectedIntegration[] | null {
  return integrationsCache;
}

let integrationsPromise: Promise<ConnectedIntegration[]> | null = null;
