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
import { Check, ChevronsUpDown, Cpu, Plug } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import { getModelRegistry, type RegistryModel } from "@/utils/modelRegistry.functions";
import {
  encodeModelChoice,
  isBiCompatProvider,
  parseModelChoice,
} from "@/utils/providers/modelChoice";
import { PROVIDER_LABELS, type ProviderId } from "@/utils/providers/types";

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

type ConnectedIntegration = { provider: string; default_model: string | null };

// Session caches shared by every picker instance.
let modelCache: RegistryModel[] | null = null;
let modelCachePromise: Promise<RegistryModel[]> | null = null;
let integrationsCache: ConnectedIntegration[] | null = null;
let integrationsPromise: Promise<ConnectedIntegration[]> | null = null;

function fetchIntegrations(): Promise<ConnectedIntegration[]> {
  integrationsPromise ??= Promise.resolve(
    supabase.from("provider_credentials").select("provider, default_model, is_active"),
  ).then(({ data }) => {
    integrationsCache = (data ?? [])
      .filter((r) => r.is_active !== false && isBiCompatProvider(r.provider))
      .map((r) => ({ provider: r.provider, default_model: r.default_model }));
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
  const getRegistryFn = useServerFn(getModelRegistry);

  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<RegistryModel[] | null>(modelCache);
  const [integrations, setIntegrations] = useState<ConnectedIntegration[] | null>(
    integrationsCache,
  );
  const [providerSel, setProviderSel] = useState<string | null>(null);

  useEffect(() => {
    if (!integrationsCache) {
      fetchIntegrations()
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

  // Catalog only matters for OpenRouter.
  useEffect(() => {
    if (modelCache || !token || provider !== "openrouter") return;
    modelCachePromise ??= getRegistryFn({ data: { access_token: token } }).then((res) => {
      modelCache = res.models;
      return res.models;
    });
    modelCachePromise.then(setModels).catch(() => setModels([]));
  }, [token, getRegistryFn, provider]);

  const entries = useMemo(() => {
    if (!integration) return [];
    const out: { value: string; display: string; sub: string }[] = [];
    if (integration.default_model && allowed(integration.provider, integration.default_model)) {
      out.push({
        value: encodeModelChoice(integration.provider, integration.default_model),
        display: integration.default_model,
        sub: "integration default",
      });
    }
    if (integration.provider === "openrouter") {
      const seen = new Set<string>();
      for (const m of models ?? []) {
        if (m.modality !== "text" || m.source !== "openrouter") continue;
        if (m.model_id === integration.default_model || seen.has(m.model_id)) continue;
        seen.add(m.model_id);
        if (!allowed("openrouter", m.model_id)) continue;
        out.push({
          value: encodeModelChoice("openrouter", m.model_id),
          display: m.display_name,
          sub: m.model_id,
        });
      }
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

      <Popover open={open} onOpenChange={setOpen}>
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
          <Command>
            <CommandInput placeholder="Search models…" className="h-9 text-xs" />
            <CommandList className="max-h-64">
              <CommandEmpty>
                {provider === "openrouter" && models === null
                  ? "Loading the catalog…"
                  : entries.length === 0
                    ? "No models for this integration — set its default model under Integrations."
                    : "No model matches."}
              </CommandEmpty>
              <CommandGroup
                heading={provider ? (PROVIDER_LABELS[provider as ProviderId] ?? provider) : ""}
              >
                {allowUnset && (
                  <CommandItem
                    value="__server_default__"
                    onSelect={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    className="text-xs"
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
                  </CommandItem>
                )}
                {entries.map((e) => (
                  <CommandItem
                    key={e.value}
                    value={`${e.display} ${e.sub}`}
                    onSelect={() => {
                      onChange(e.value);
                      setOpen(false);
                    }}
                    className="text-xs"
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
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
