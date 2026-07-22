// Provider + model picker for the BI generative features, sourced ONLY from
// the caller's connected integrations (/integrations):
//
//   [ Provider ▾ ]  [ Model ▾ ]
//
// The provider dropdown lists connected OpenAI-compatible integrations; the
// model dropdown lists that integration's configured default model first,
// plus the full searchable catalog when the provider is OpenRouter (one key
// serves the whole catalog). Entries are filtered by IAM model rules. When
// nothing is connected, the picker says so and points at Integrations — it
// never invents entries.
//
// Selections encode provider + model ("provider::model", see modelChoice)
// so /api/bi executes against the right integration.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Cpu, Plug, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { isModelAllowedByRules, useMyModelRules } from "@/hooks/use-iam";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { listProviderModels, type ProviderModelInfo } from "@/utils/providerModels.functions";
import {
  encodeModelChoice,
  isBiCompatProvider,
  isTextModelId,
  parseModelChoice,
} from "@/utils/providers/modelChoice";
import { PROVIDER_LABELS, type ProviderId } from "@/utils/providers/types";

/** Shown for OpenRouter when the live /models fetch is empty or fails. */
const OPENROUTER_FALLBACK_MODELS = [
  "openrouter/auto",
  "openai/gpt-5",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3.5-haiku",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "meta-llama/llama-3.3-70b-instruct",
  "deepseek/deepseek-chat",
  "mistralai/mistral-large",
  "x-ai/grok-2-1212",
  "qwen/qwen-2.5-72b-instruct",
];

export const BI_MODEL_STORAGE_KEY = "agentswarms.bi_model";

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

export type ConnectedIntegration = { provider: string; default_model: string | null };

// Session caches shared by every picker instance. Provider model lists are
// fetched live from each integration's /models endpoint once per session.
const providerModelsCache = new Map<string, ProviderModelInfo[]>();
let integrationsCache: ConnectedIntegration[] | null = null;
let integrationsPromise: Promise<ConnectedIntegration[]> | null = null;

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
  ]).then(([legacy, creds]) => {
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
    integrationsCache = [...byProvider.values()];
    return integrationsCache;
  });
  return integrationsPromise;
}

export function BiModelSelect({
  value,
  onChange,
  className,
  disabled = false,
  allowUnset = false,
}: {
  /** Encoded "provider::model" choice, or null when nothing is selected. */
  value: string | null;
  onChange: (model: string | null) => void;
  className?: string;
  disabled?: boolean;
  /** Offer an explicit "Server default" entry mapping to null (publish dialog). */
  allowUnset?: boolean;
}) {
  const { session } = useAuth();
  const token = session?.access_token;
  const rules = useMyModelRules();
  const listModelsFn = useServerFn(listProviderModels);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ProviderModelInfo[] | null>(null);
  const [integrations, setIntegrations] = useState<ConnectedIntegration[] | null>(
    integrationsCache,
  );
  const [providerSel, setProviderSel] = useState<string | null>(null);

  useEffect(() => {
    if (!integrationsCache) {
      fetchConnectedIntegrations()
        .then(setIntegrations)
        .catch(() => setIntegrations([]));
    }
  }, []);

  const parsedValue = parseModelChoice(value);
  const connectedProviders = integrations ?? [];
  const preferredProvider =
    connectedProviders.find((i) => i.provider === "openrouter")?.provider ??
    connectedProviders[0]?.provider ??
    null;
  const provider =
    (parsedValue && connectedProviders.some((i) => i.provider === parsedValue.provider)
      ? parsedValue.provider
      : null) ??
    (providerSel && connectedProviders.some((i) => i.provider === providerSel)
      ? providerSel
      : null) ??
    preferredProvider;
  const integration = connectedProviders.find((i) => i.provider === provider) ?? null;

  const allowed = (p: string, m: string) => !rules || isModelAllowedByRules(rules, p, m);

  // Auto-select the integration's default model so pickers never show a
  // hardcoded instance model (publish dialog opts out via allowUnset).
  useEffect(() => {
    if (allowUnset || value !== null || !integrations) return;
    const p = preferredProvider;
    const d = integrations.find((i) => i.provider === p)?.default_model;
    if (p && d && allowed(p, d)) onChange(encodeModelChoice(p, d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrations, value, allowUnset]);

  // Live model discovery for the selected provider (its /models endpoint,
  // called with the caller's own credentials). Cached per session.
  useEffect(() => {
    if (!provider || !token) return;
    const cached = providerModelsCache.get(provider);
    if (cached) {
      setModels(cached);
      return;
    }
    setModels(null);
    let cancelled = false;
    listModelsFn({ data: { access_token: token, provider } })
      .then((res) => {
        if (cancelled) return;
        const list = res.ok ? res.models : [];
        providerModelsCache.set(provider, list);
        setModels(list);
      })
      .catch(() => {
        if (!cancelled) {
          providerModelsCache.set(provider, []);
          setModels([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider, token, listModelsFn]);

  const entries = useMemo(() => {
    if (!integration) return [];
    const out: { value: string; display: string; sub: string }[] = [];
    const seen = new Set<string>();
    if (
      integration.default_model &&
      isTextModelId(integration.default_model) &&
      allowed(integration.provider, integration.default_model)
    ) {
      seen.add(integration.default_model);
      out.push({
        value: encodeModelChoice(integration.provider, integration.default_model),
        display: integration.default_model,
        sub: "integration default",
      });
    }
    // Live list from the provider's /models endpoint; curated fallback for
    // OpenRouter when the fetch failed or came back empty.
    const live: ProviderModelInfo[] =
      models === null
        ? []
        : models.length > 0
          ? models
          : integration.provider === "openrouter"
            ? OPENROUTER_FALLBACK_MODELS.map((id) => ({ id, name: null }))
            : [];
    for (const m of live) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (!isTextModelId(m.id)) continue;
      if (!allowed(integration.provider, m.id)) continue;
      out.push({
        value: encodeModelChoice(integration.provider, m.id),
        display: m.name ?? m.id,
        sub: m.id,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integration, models, rules]);

  // No connected integrations: say so instead of inventing entries.
  if (integrations !== null && connectedProviders.length === 0) {
    return (
      <Button
        asChild
        variant="outline"
        size="sm"
        className={cn("h-8 justify-start gap-1.5 text-xs font-normal", className)}
      >
        <Link to="/integrations">
          <Plug className="h-3.5 w-3.5 text-muted-foreground" />
          Connect a model provider in Integrations
        </Link>
      </Button>
    );
  }

  const selectedEntry = value ? entries.find((e) => e.value === value) : null;
  const modelLabel = value
    ? (selectedEntry?.display ?? parsedValue?.model ?? value)
    : allowUnset
      ? "Server default"
      : "Select model…";

  const q = query.trim().toLowerCase();
  const filteredEntries = q
    ? entries.filter((e) => `${e.display} ${e.sub}`.toLowerCase().includes(q))
    : entries;
  const showUnset = allowUnset && (!q || "server default".includes(q));

  return (
    <div className={cn("flex min-w-0 gap-1.5", className)}>
      <Select
        value={provider ?? undefined}
        onValueChange={(p) => {
          setProviderSel(p);
          if (parsedValue && parsedValue.provider !== p) {
            const d = connectedProviders.find((i) => i.provider === p)?.default_model;
            onChange(d && allowed(p, d) ? encodeModelChoice(p, d) : null);
          }
        }}
        disabled={disabled || integrations === null}
      >
        <SelectTrigger className="h-8 w-[45%] min-w-0 shrink-0 text-xs">
          <SelectValue placeholder={integrations === null ? "Loading…" : "Provider"} />
        </SelectTrigger>
        <SelectContent>
          {connectedProviders.map((i) => (
            <SelectItem key={i.provider} value={i.provider} className="text-xs">
              {PROVIDER_LABELS[i.provider as ProviderId] ?? i.provider}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || !provider}
            className="h-8 min-w-0 flex-1 justify-between gap-1.5 text-xs font-normal"
            title={
              parsedValue
                ? `${parsedValue.model} via ${PROVIDER_LABELS[parsedValue.provider as ProviderId] ?? parsedValue.provider}`
                : "Model used for generation"
            }
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{modelLabel}</span>
            </span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          {/* Plain search + list (no cmdk): the Command component pulls a
              separately-optimized copy of React in dev, which crashes the
              picker with "Cannot read properties of null (reading 'useRef')". */}
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              autoFocus
              className="h-9 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {provider && (
              <p className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground">
                {PROVIDER_LABELS[provider as ProviderId] ?? provider}
              </p>
            )}
            {models === null ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                Loading models from your integration…
              </p>
            ) : filteredEntries.length === 0 && !showUnset ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {entries.length === 0
                  ? "No models found — set a default model for this integration under Integrations."
                  : "No model matches."}
              </p>
            ) : (
              <>
                {showUnset && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <Check
                      className={cn("mr-2 h-3.5 w-3.5", value ? "opacity-0" : "opacity-100")}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">Server default</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        whatever the instance falls back to
                      </span>
                    </span>
                  </button>
                )}
                {filteredEntries.map((e) => (
                  <button
                    key={e.value}
                    type="button"
                    onClick={() => {
                      onChange(e.value);
                      setOpen(false);
                    }}
                    className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <Check
                      className={cn(
                        "mr-2 h-3.5 w-3.5",
                        value === e.value ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{e.display}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {e.sub}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
