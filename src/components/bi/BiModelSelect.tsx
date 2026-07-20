// Searchable model picker for the BI generative features. Lists TEXT models
// from the model registry that are routable through the BI gateway
// (OpenRouter source), filtered down to what the current user's IAM model
// rules allow. Selection is optional — "Default" uses the server's default
// BI model.
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

/** Instance-level fallback (an OpenRouter route id) — used only when the
 * caller's OpenRouter integration has no default_model of its own. */
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

// One fetch per session shared by every picker instance.
let modelCache: RegistryModel[] | null = null;
let modelCachePromise: Promise<RegistryModel[]> | null = null;

// The caller's own OpenRouter integration default (RLS-scoped read).
// undefined = not loaded yet; null = integration has no default_model.
let userDefaultCache: string | null | undefined;
let userDefaultPromise: Promise<string | null> | null = null;

function fetchUserDefaultModel(): Promise<string | null> {
  userDefaultPromise ??= Promise.resolve(
    supabase
      .from("provider_credentials")
      .select("default_model")
      .eq("provider", "openrouter")
      .maybeSingle(),
  ).then(({ data }) => {
    userDefaultCache = data?.default_model ?? null;
    return userDefaultCache;
  });
  return userDefaultPromise;
}

export function BiModelSelect({
  value,
  onChange,
  className,
  disabled = false,
}: {
  /** OpenRouter model id, or null for the server default. */
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
  const [userDefault, setUserDefault] = useState<string | null>(userDefaultCache ?? null);

  useEffect(() => {
    if (userDefaultCache === undefined) {
      fetchUserDefaultModel()
        .then(setUserDefault)
        .catch(() => {});
    }
    if (modelCache || !token) return;
    modelCachePromise ??= getRegistryFn({ data: { access_token: token } }).then((res) => {
      modelCache = res.models;
      return res.models;
    });
    modelCachePromise.then(setModels).catch(() => setModels([]));
  }, [token, getRegistryFn]);

  // Text models only, routable via the BI gateway, allowed by IAM rules.
  const options = useMemo(() => {
    const seen = new Set<string>();
    return (models ?? []).filter((m) => {
      if (m.modality !== "text" || m.source !== "openrouter") return false;
      if (seen.has(m.model_id)) return false;
      seen.add(m.model_id);
      if (rules && !isModelAllowedByRules(rules, "openrouter", m.model_id)) return false;
      return true;
    });
  }, [models, rules]);

  const selected = value ? options.find((m) => m.model_id === value) : null;
  const effectiveDefault = userDefault ?? DEFAULT_BI_MODEL;
  const label = value
    ? (selected?.display_name ?? value)
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
          title="AI model used for generation"
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
          <CommandInput placeholder="Search text models…" className="h-9 text-xs" />
          <CommandList className="max-h-64">
            <CommandEmpty>
              {models === null ? "Loading models…" : "No text model matches."}
            </CommandEmpty>
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
                    {effectiveDefault} ·{" "}
                    {userDefault ? "your OpenRouter integration" : "instance default"}
                  </span>
                </span>
              </CommandItem>
              {options.map((m) => (
                <CommandItem
                  key={m.id}
                  value={`${m.display_name} ${m.model_id}`}
                  onSelect={() => {
                    onChange(m.model_id);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <Check
                    className={cn(
                      "mr-2 h-3.5 w-3.5",
                      value === m.model_id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{m.display_name}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {m.model_id}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
