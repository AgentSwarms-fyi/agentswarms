// Searchable model picker.
//
// WHY THIS EXISTS. Swarm nodes picked a model from `MODEL_SUGGESTIONS` — a
// bundled, hand-maintained list of about a dozen ids per provider — with a
// free-text box underneath for anything else. So choosing one of OpenRouter's
// several hundred models meant knowing its exact id and typing it from memory,
// even though the app already fetches the provider's real catalogue for the
// agent editor. This shows that catalogue, and lets you type to filter it.
//
// The free-text escape hatch is kept, not replaced: a private deployment, a
// brand-new release, or a provider that publishes no catalogue all need an id
// the list will never contain. Typing one that isn't listed is offered as an
// explicit "use this id" row rather than being silently discarded.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { useProviderModels } from "@/hooks/use-provider-models";

export type ModelComboboxProps = {
  /** Currently selected model id. May be an id absent from the catalogue. */
  value: string;
  onChange: (modelId: string) => void;
  /** Which provider's catalogue to load. */
  provider: string;
  /**
   * Ids to show when the live catalogue is empty or still loading — the
   * caller's bundled suggestions. Also unioned in so a curated id stays
   * reachable even if the provider stops listing it.
   */
  fallbackModels?: string[];
  /** Returns false for ids an IAM rule forbids this user. */
  isAllowed?: (modelId: string) => boolean;
  /** Rendered after the id on a row — e.g. an "Image" badge. */
  renderBadge?: (modelId: string) => React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

type Entry = { id: string; free?: boolean };

export function ModelCombobox({
  value,
  onChange,
  provider,
  fallbackModels = [],
  isAllowed,
  renderBadge,
  placeholder = "Select a model…",
  disabled,
  className,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const live = useProviderModels(provider);
  // `models` is null until the first fetch lands. Distinguishing that from an
  // empty catalogue is what lets the list say "loading" instead of "no models",
  // which otherwise reads as "this provider has none".
  const loading = live.models === null;

  const entries = useMemo<Entry[]>(() => {
    const fromLive: Entry[] = (live.models ?? []).map((m) => ({ id: m.id, free: m.free }));
    const seen = new Set(fromLive.map((m) => m.id));
    const merged = [...fromLive];
    for (const id of fallbackModels) {
      if (!seen.has(id)) {
        merged.push({ id });
        seen.add(id);
      }
    }
    // The saved value is always reachable, even if the provider dropped it or
    // it was typed by hand — otherwise the field would render as if nothing
    // were selected and the next save would quietly clear it.
    if (value && !seen.has(value)) merged.unshift({ id: value });
    return isAllowed ? merged.filter((m) => isAllowed(m.id)) : merged;
  }, [live.models, fallbackModels, value, isAllowed]);

  const trimmed = query.trim();
  const filtered = useMemo(() => {
    if (!trimmed) return entries;
    const q = trimmed.toLowerCase();
    return entries.filter((m) => m.id.toLowerCase().includes(q));
  }, [entries, trimmed]);

  /**
   * A typed id that matches nothing — offered rather than dropped.
   *
   * Only when NOTHING matches. Offering it alongside real matches put it top
   * of the list, so typing a partial like "sonnet" (which matches three real
   * models) and pressing Enter selected the literal string "sonnet" as the
   * model id. Someone mid-search is searching, not entering a custom id.
   */
  const customId =
    trimmed &&
    filtered.length === 0 &&
    !entries.some((m) => m.id.toLowerCase() === trimmed.toLowerCase())
      ? trimmed
      : null;

  // Reset the query when the popover closes so reopening starts clean rather
  // than showing whatever was last filtered.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) setQuery("");
    wasOpen.current = open;
  }, [open]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className={cn("truncate font-mono text-xs", !value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        {/* shouldFilter={false}: cmdk's built-in fuzzy match reorders results,
            which is disorienting on ids that share long prefixes
            (openai/gpt-4o vs openai/gpt-4o-mini). Plain substring, original
            order, is easier to scan. */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search models…"
            value={query}
            onValueChange={setQuery}
            autoFocus
          />
          <CommandList className="max-h-64">
            {loading && entries.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading {provider} models…
              </div>
            ) : (
              <>
                {filtered.length === 0 && !customId && (
                  <CommandEmpty>No model matches “{trimmed}”.</CommandEmpty>
                )}
                {customId && (
                  <CommandGroup heading="Use this id">
                    <CommandItem value={customId} onSelect={() => pick(customId)}>
                      <span className="font-mono text-xs">{customId}</span>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        not in {provider}&apos;s catalogue
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}
                {filtered.length > 0 && (
                  <CommandGroup
                    heading={
                      trimmed
                        ? `${filtered.length} of ${entries.length}`
                        : `${entries.length} models`
                    }
                  >
                    {filtered.map((m) => (
                      <CommandItem key={m.id} value={m.id} onSelect={() => pick(m.id)}>
                        <Check
                          className={cn(
                            "mr-2 h-3.5 w-3.5 shrink-0",
                            m.id === value ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="truncate font-mono text-xs">{m.id}</span>
                        {m.free && (
                          <span className="ml-2 shrink-0 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1 text-[9px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            Free
                          </span>
                        )}
                        {renderBadge?.(m.id)}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
