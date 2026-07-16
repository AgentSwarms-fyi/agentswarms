import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, Sparkles, Zap, KeyRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PROVIDER_LABELS, PROVIDER_MODELS } from "@/utils/providers/types";
import type { ProviderId } from "@/utils/providers/types";

export type FallbackChoice = {
  provider: ProviderId;
  model: string;
  label: string;
};

type Reason = "rate_limit" | "credits" | "error";

type Props = {
  open: boolean;
  onClose: () => void;
  reason: Reason;
  errorMessage?: string;
  // The model that just failed, so we can hide it from the list.
  failedProvider?: string;
  failedModel?: string;
  // Called when the user picks a replacement model and confirms.
  // The playground will then re-run the same conversation history with this model.
  onPickModel: (choice: FallbackChoice) => void;
};

// Curated fallbacks for the default OpenRouter provider. These use the
// server's OPENROUTER_API_KEY (or the user's own OpenRouter key, if
// connected), so they need no extra setup and are always offered as a quick
// recovery path.
const OPENROUTER_QUICK_FALLBACKS: { id: string; label: string; tag: string }[] = [
  { id: "openrouter/free", label: "Free Models Router", tag: "$0, 200K ctx" },
  { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", tag: "Cheapest" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", tag: "Balanced" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", tag: "Most capable" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", tag: "Fast" },
  { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", tag: "Balanced" },
];

export function ModelFallbackDialog({
  open,
  onClose,
  reason,
  errorMessage,
  failedProvider,
  failedModel,
  onPickModel,
}: Props) {
  const [connectedProviders, setConnectedProviders] = useState<Set<ProviderId>>(new Set());
  const [selected, setSelected] = useState<FallbackChoice | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    (async () => {
      const { data } = await supabase.from("provider_credentials").select("provider, is_active");
      const set = new Set<ProviderId>();
      (data || []).forEach((row) => {
        if (row.is_active) set.add(row.provider as ProviderId);
      });
      setConnectedProviders(set);
    })();
  }, [open]);

  const quickFallbackOptions = useMemo(
    () =>
      OPENROUTER_QUICK_FALLBACKS.filter(
        (m) => !(failedProvider === "openrouter" && failedModel === m.id),
      ),
    [failedProvider, failedModel],
  );

  const externalOptions = useMemo(() => {
    const out: { provider: ProviderId; model: string; label: string }[] = [];
    (Object.keys(PROVIDER_MODELS) as Array<keyof typeof PROVIDER_MODELS>).forEach((p) => {
      if (!connectedProviders.has(p as ProviderId)) return;
      PROVIDER_MODELS[p].forEach((m) => {
        if (failedProvider === p && failedModel === m.id) return;
        out.push({ provider: p as ProviderId, model: m.id, label: m.label });
      });
    });
    return out;
  }, [connectedProviders, failedProvider, failedModel]);

  const title =
    reason === "credits"
      ? "AI credits exhausted"
      : reason === "rate_limit"
        ? "Rate limit reached"
        : "Model unavailable";

  const description =
    reason === "credits"
      ? "This model can't be used right now because the AI credits are exhausted. Pick another model and we'll continue this chat with full context."
      : reason === "rate_limit"
        ? "This model is temporarily rate-limited. Pick another model below and we'll resend the conversation so you can keep going."
        : errorMessage ||
          "Pick a different model to retry this message with full conversation context.";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="mt-1">{description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[55vh] pr-2">
          <div className="space-y-5">
            <section>
              <div className="mb-2 flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                <h4 className="text-sm font-semibold">OpenRouter (default)</h4>
                <Badge variant="secondary" className="text-[10px]">
                  No setup
                </Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {quickFallbackOptions.map((m) => {
                  const isSelected =
                    selected?.provider === "openrouter" && selected?.model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() =>
                        setSelected({ provider: "openrouter", model: m.id, label: m.label })
                      }
                      className={`text-left rounded-lg border p-3 transition-colors hover:border-primary ${
                        isSelected ? "border-primary bg-primary/5" : "border-border"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{m.label}</p>
                        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">{m.id}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{m.tag}</p>
                    </button>
                  );
                })}
              </div>
            </section>

            {externalOptions.length > 0 && (
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-primary" />
                  <h4 className="text-sm font-semibold">Your connected providers</h4>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {externalOptions.map((m) => {
                    const isSelected =
                      selected?.provider === m.provider && selected?.model === m.model;
                    return (
                      <button
                        key={`${m.provider}:${m.model}`}
                        type="button"
                        onClick={() =>
                          setSelected({
                            provider: m.provider,
                            model: m.model,
                            label: m.label,
                          })
                        }
                        className={`text-left rounded-lg border p-3 transition-colors hover:border-primary ${
                          isSelected ? "border-primary bg-primary/5" : "border-border"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium truncate">{m.label}</p>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground truncate">
                          {PROVIDER_LABELS[m.provider]}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground truncate">{m.model}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {externalOptions.length === 0 && (
              <div className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs space-y-2">
                <p className="text-muted-foreground">
                  Tip: connect more providers in Provider Integrations to unlock more fallback
                  options.
                </p>
                <Button asChild size="sm" variant="outline">
                  <a href="/integrations">Open Integrations</a>
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            onClick={() => {
              if (selected) onPickModel(selected);
            }}
          >
            Continue with {selected?.label || "selected model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
