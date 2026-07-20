// Model picker for the BI generative features, driven by the CALLER'S
// CONNECTED INTEGRATIONS (/integrations): one group per connected
// OpenAI-compatible provider, its configured default model first. OpenRouter
// additionally contributes its full text-model catalog (one key serves the
// whole catalog). Entries are filtered by the user's IAM model rules.
//
// Selections encode provider + model ("provider::model", see modelChoice)
// so /api/bi executes against the right integration.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronsUpDown, Cpu } from "lucide-react";

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

/** Instance-level fallback (an OpenRouter route id) — used only when no
 * integration default applies. */
export const DEFAULT_BI_MODEL = "google/gemini-2.5-flash";
export const BI_MODEL_STORAGE_KEY = "agentswarms.bi_model";

/** Session-wide preferred BI model (null = server default), persisted. */
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

type Entry = { value: string; display: string; sub: string };
type Group = { provider: string; label: string; entries: Entry[] };

export function BiModelSelect({
  value,
  onChange,
  className,
  disabled = false,
}: {
  /** Encoded "provider::model" choice, or null for the server default. */
  value: string | null;
  onChange: (model: string | null) => void;
  className?: string;
  disabled?: boolean;
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

  useEffect(() => {
    if (!integrationsCache) {
      fetchIntegrations()
        .then(setIntegrations)
        .catch(() => setIntegrations([]));
    }
  }, []);

  // The OpenRouter catalog is only relevant when OpenRouter is connected
  // (or nothing is — the instance fallback also routes through OpenRouter).
  const openrouterAvailable =
    integrations !== null &&
    (integrations.length === 0 || integrations.some((i) => i.provider === "openrouter"));

  useEffect(() => {
    if (modelCache || !token || !openrouterAvailable) return;
    modelCachePromise ??= getRegistryFn({ data: { access_token: token } }).then((res) => {
      modelCache = res.models;
      return res.models;
    });
    modelCachePromise.then(setModels).catch(() => setModels([]));
  }, [token, getRegistryFn, openrouterAvailable]);

  const allowed = (provider: string, model: string) =>
    !rules || isModelAllowedByRules(rules, provider, model);

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    for (const int of integrations ?? []) {
      const entries: Entry[] = [];
      if (int.default_model && allowed(int.provider, int.default_model)) {
        entries.push({
          value: encodeModelChoice(int.provider, int.default_model),
          display: int.default_model,
          sub: "integration default",
        });
      }
      if (int.provider === "openrouter") {
        const seen = new Set<string>();
        for (const m of models ?? []) {
          if (m.modality !== "text" || m.source !== "openrouter") continue;
          if (m.model_id === int.default_model || seen.has(m.model_id)) continue;
          seen.add(m.model_id);
          if (!allowed("openrouter", m.model_id)) continue;
          entries.push({
            value: encodeModelChoice("openrouter", m.model_id),
            display: m.display_name,
            sub: m.model_id,
          });
        }
      }
      if (entries.length > 0) {
        out.push({
          provider: int.provider,
          label: PROVIDER_LABELS[int.provider as ProviderId] ?? int.provider,
          entries,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrations, models, rules]);

  const openrouterInt = integrations?.find((i) => i.provider === "openrouter") ?? null;
  const effectiveDefault = openrouterInt?.default_model ?? DEFAULT_BI_MODEL;
  const defaultSub = openrouterInt
    ? openrouterInt.default_model
      ? "your OpenRouter integration"
      : "instance default, via your OpenRouter key"
    : "instance default (OpenRouter)";
  const showDefaultEntry = openrouterAvailable;

  const parsedValue = parseModelChoice(value);
  const selectedEntry = value
    ? groups.flatMap((g) => g.entries).find((e) => e.value === value)
    : null;
  const label = value
    ? (selectedEntry?.display ?? parsedValue?.model ?? value)
    : `Default (${effectiveDefault.split("/").pop() ?? effectiveDefault})`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("h-8 justify-between gap-1.5 text-xs font-normal", className)}
          title={
            value && parsedValue
              ? `${parsedValue.model} via ${PROVIDER_LABELS[parsedValue.provider as ProviderId] ?? parsedValue.provider}`
              : "AI model used for generation"
          }
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Search your connected models…" className="h-9 text-xs" />
          <CommandList className="max-h-64">
            <CommandEmpty>
              {integrations === null
                ? "Loading your integrations…"
                : groups.length === 0 && !showDefaultEntry
                  ? "No connected text-model integrations — add one under Integrations."
                  : "No model matches."}
            </CommandEmpty>
            {showDefaultEntry && (
              <CommandGroup>
                <CommandItem
                  value="__default__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <Check className={cn("mr-2 h-3.5 w-3.5", value ? "opacity-0" : "opacity-100")} />
                  <span className="min-w-0">
                    <span className="block truncate">Default</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {effectiveDefault} · {defaultSub}
                    </span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {groups.map((g) => (
              <CommandGroup key={g.provider} heading={g.label}>
                {g.entries.map((e) => (
                  <CommandItem
                    key={e.value}
                    value={`${g.label} ${e.display} ${e.sub}`}
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
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
