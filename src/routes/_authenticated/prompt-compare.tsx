import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useCallback } from "react";
import { comparisonCaveat, winnerIndex } from "@/lib/compareWinner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ModelCombobox } from "@/components/models/ModelCombobox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { toast } from "sonner";
import { Send, Loader2, RotateCcw, Lightbulb, Clock, Coins, FileText, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/prompt-compare")({
  component: PromptComparePage,
});

/* ── Available models (instance default via OpenRouter) ── */
const MODELS = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter" },
  { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", provider: "openrouter" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "openrouter" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "openrouter" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash", provider: "openrouter" },
  { id: "openai/gpt-5-mini", label: "GPT-5 Mini", provider: "openrouter" },
  { id: "openai/gpt-5-nano", label: "GPT-5 Nano", provider: "openrouter" },
  { id: "openai/gpt-5", label: "GPT-5", provider: "openrouter" },
  { id: "openai/gpt-5.2", label: "GPT-5.2", provider: "openrouter" },
];

const SUGGESTED_PROMPTS = [
  {
    label: "Conciseness test",
    prompt: "Explain quantum computing in exactly 3 sentences. No more, no less.",
    tip: "Watch which model follows the constraint precisely vs. which rambles.",
  },
  {
    label: "Code + reasoning",
    prompt:
      "Write a Python function to check if a string is a palindrome. Then intentionally introduce a subtle bug and explain what it is.",
    tip: "Compare code quality, bug creativity, and explanation depth.",
  },
  {
    label: "Empathy & tone",
    prompt: "I just failed an important exam and I'm feeling really down. What should I do?",
    tip: "Notice the difference in warmth, structure, and actionability.",
  },
  {
    label: "Balanced analysis",
    prompt: "What are the pros and cons of microservices vs monoliths? Give me a table.",
    tip: "Check for bias, completeness, and formatting quality.",
  },
  {
    label: "Multilingual nuance",
    prompt:
      "Translate 'It's raining cats and dogs' to French, Japanese, and German. Explain the cultural nuances of each translation.",
    tip: "Tests multilingual capability and cultural awareness.",
  },
  {
    label: "Structured output",
    prompt:
      'Analyze this sentence for sentiment and return ONLY valid JSON: {"text": "I absolutely love this product but the shipping was terrible", "sentiment": ..., "confidence": ...}',
    tip: "See which model follows the JSON-only constraint without extra text.",
  },
];

type PanelState = {
  modelId: string;
  content: string;
  loading: boolean;
  error: string | null;
  startedAt: number | null;
  durationMs: number | null;
  tokenEstimate: number | null;
  // Real cost + token counts from the server's `event: cost` frame (falls back
  // to a client-side ~chars/4 estimate when the frame is absent).
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
};

const INITIAL_PANEL: PanelState = {
  modelId: "",
  content: "",
  loading: false,
  error: null,
  startedAt: null,
  durationMs: null,
  tokenEstimate: null,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
};

function PromptComparePage() {
  const { user } = useAuth();
  const [prompt, setPrompt] = useState("");
  const [panelA, setPanelA] = useState<PanelState>({ ...INITIAL_PANEL, modelId: MODELS[0].id });
  const [panelB, setPanelB] = useState<PanelState>({ ...INITIAL_PANEL, modelId: MODELS[5].id });
  // Optional 3rd model — null until the user adds it.
  const [panelC, setPanelC] = useState<PanelState | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const streamToPanel = useCallback(
    async (
      modelId: string,
      promptText: string,
      setPanel: React.Dispatch<React.SetStateAction<PanelState>>,
      signal: AbortSignal,
    ) => {
      const model = MODELS.find((m) => m.id === modelId);
      if (!model) return;

      const startedAt = Date.now();
      setPanel((p) => ({
        ...p,
        content: "",
        loading: true,
        error: null,
        startedAt,
        durationMs: null,
        tokenEstimate: null,
      }));

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (sessionData.session?.access_token) {
          headers.Authorization = `Bearer ${sessionData.session.access_token}`;
        }

        const resp = await fetch("/api/chat", {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            provider: model.provider,
            model: model.id,
            messages: [{ role: "user", content: promptText }],
          }),
        });

        if (!resp.ok || !resp.body) {
          const errText = await resp.text();
          let errMsg = `Error (${resp.status})`;
          try {
            const j = JSON.parse(errText);
            if (j?.error) errMsg = j.error;
          } catch {
            /* ignore */
          }
          setPanel((p) => ({
            ...p,
            loading: false,
            error: errMsg,
            durationMs: Date.now() - startedAt,
          }));
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let textBuffer = "";
        let fullContent = "";
        let currentEvent: string | null = null;
        let cost: { costUsd: number; tokensIn: number; tokensOut: number } | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          textBuffer += decoder.decode(value, { stream: true });

          let newlineIndex: number;
          while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
            let line = textBuffer.slice(0, newlineIndex);
            textBuffer = textBuffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line.startsWith(":")) continue;
            if (line.trim() === "") {
              currentEvent = null;
              continue;
            }
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === "[DONE]") break;
            // The server emits a final `event: cost` with real $ + token counts.
            if (currentEvent === "cost") {
              try {
                const c = JSON.parse(jsonStr);
                cost = {
                  costUsd: Number(c.costUsd) || 0,
                  tokensIn: Number(c.tokensIn) || 0,
                  tokensOut: Number(c.tokensOut) || 0,
                };
              } catch {
                /* ignore */
              }
              continue;
            }
            if (currentEvent && currentEvent !== "message") continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content as string | undefined;
              if (delta) {
                fullContent += delta;
                setPanel((p) => ({ ...p, content: fullContent }));
              }
            } catch {
              /* skip */
            }
          }
        }

        const durationMs = Date.now() - startedAt;
        const tokenEstimate = cost
          ? cost.tokensIn + cost.tokensOut
          : Math.ceil(fullContent.length / 4);
        setPanel((p) => ({
          ...p,
          loading: false,
          durationMs,
          tokenEstimate,
          costUsd: cost?.costUsd ?? null,
          tokensIn: cost?.tokensIn ?? null,
          tokensOut: cost?.tokensOut ?? null,
        }));
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
          setPanel((p) => ({ ...p, loading: false, error: "Cancelled" }));
          return;
        }
        setPanel((p) => ({
          ...p,
          loading: false,
          error: (err as Error).message,
          durationMs: Date.now() - startedAt,
        }));
      }
    },
    [],
  );

  const handleSend = useCallback(() => {
    if (!prompt.trim()) return;
    const activeModels = [panelA.modelId, panelB.modelId, ...(panelC ? [panelC.modelId] : [])];
    if (new Set(activeModels).size !== activeModels.length) {
      toast.error("Pick a different model for each panel to compare.");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setHasRun(true);
    streamToPanel(panelA.modelId, prompt, setPanelA, controller.signal);
    streamToPanel(panelB.modelId, prompt, setPanelB, controller.signal);
    if (panelC) {
      streamToPanel(
        panelC.modelId,
        prompt,
        setPanelC as React.Dispatch<React.SetStateAction<PanelState>>,
        controller.signal,
      );
    }
  }, [prompt, panelA.modelId, panelB.modelId, panelC, streamToPanel]);

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setPrompt("");
    setPanelA((p) => ({ ...INITIAL_PANEL, modelId: p.modelId }));
    setPanelB((p) => ({ ...INITIAL_PANEL, modelId: p.modelId }));
    setPanelC((p) => (p ? { ...INITIAL_PANEL, modelId: p.modelId } : null));
    setHasRun(false);
  }, []);

  function addThirdModel() {
    // Default to the first model not already chosen.
    const used = new Set([panelA.modelId, panelB.modelId]);
    const free = MODELS.find((m) => !used.has(m.id)) ?? MODELS[0];
    setPanelC({ ...INITIAL_PANEL, modelId: free.id });
  }

  const isRunning = panelA.loading || panelB.loading || !!panelC?.loading;

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col h-full">
        {/* Header */}
        <div className="shrink-0 border-b border-border bg-card/40 px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-display text-lg font-semibold tracking-tight">
                Prompt Comparison Lab
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Send the same prompt to two models — see how they differ in quality, speed, and
                style.
              </p>
            </div>
            {hasRun && (
              <Button variant="outline" size="sm" onClick={handleReset} disabled={isRunning}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Reset
              </Button>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Model selectors */}
          <div
            className={cn(
              "shrink-0 grid grid-cols-1 gap-3 px-4 sm:px-6 py-3 border-b border-border bg-muted/20",
              panelC ? "md:grid-cols-3" : "md:grid-cols-2",
            )}
          >
            <ModelSelector
              label="Model A"
              value={panelA.modelId}
              onChange={(v) => setPanelA((p) => ({ ...p, modelId: v }))}
              disabled={isRunning}
            />
            <ModelSelector
              label="Model B"
              value={panelB.modelId}
              onChange={(v) => setPanelB((p) => ({ ...p, modelId: v }))}
              disabled={isRunning}
            />
            {panelC ? (
              <div className="flex items-center gap-2">
                <ModelSelector
                  label="Model C"
                  value={panelC.modelId}
                  onChange={(v) => setPanelC((p) => (p ? { ...p, modelId: v } : p))}
                  disabled={isRunning}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-muted-foreground"
                  onClick={() => setPanelC(null)}
                  disabled={isRunning}
                  title="Remove third model"
                >
                  Remove
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 self-center text-xs md:col-span-2"
                onClick={addThirdModel}
                disabled={isRunning}
              >
                + Add a third model
              </Button>
            )}
          </div>

          {/* Input bar — above panels so it's visible immediately */}
          <div className="shrink-0 border-b border-border bg-card/40 px-4 sm:px-6 py-3">
            <div className="flex gap-2 items-end max-w-4xl mx-auto">
              <Textarea
                placeholder="Type a prompt to send to both models…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                className="min-h-[44px] max-h-32 resize-none text-sm"
                rows={1}
                disabled={isRunning}
              />
              <Button
                onClick={handleSend}
                disabled={!prompt.trim() || isRunning}
                size="icon"
                className="shrink-0 h-10 w-10"
              >
                {isRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Suggested prompts (before first run) */}
          {!hasRun && (
            <div className="shrink-0 border-b border-border bg-card/30 px-4 sm:px-6 py-4">
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Try these comparison prompts</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {SUGGESTED_PROMPTS.map((sp) => (
                  <button
                    key={sp.label}
                    onClick={() => setPrompt(sp.prompt)}
                    className="text-left rounded-lg border border-border bg-card/60 p-3 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  >
                    <p className="text-xs font-semibold text-foreground">{sp.label}</p>
                    <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                      {sp.prompt}
                    </p>
                    <p className="text-[10px] text-primary/70 mt-1 italic">💡 {sp.tip}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Response panels */}
          <div
            className={cn(
              "flex-1 grid grid-cols-1 divide-y md:divide-y-0 md:divide-x divide-border overflow-hidden",
              panelC ? "md:grid-cols-3" : "md:grid-cols-2",
            )}
          >
            <ResponsePanel panel={panelA} label="A" />
            <ResponsePanel panel={panelB} label="B" />
            {panelC && <ResponsePanel panel={panelC} label="C" />}
          </div>

          {/* Comparison stats */}
          {hasRun && !isRunning && panelA.content && panelB.content && (
            <div className="shrink-0 border-t border-border bg-muted/20 px-4 sm:px-6 py-3">
              <ComparisonStats panels={[panelA, panelB, ...(panelC ? [panelC] : [])]} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function ModelSelector({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="shrink-0 text-[10px]">
        {label}
      </Badge>
      {/* The whole OpenRouter catalogue, searchable. MODELS below is a curated
          nine — fine as a starting point, but comparing anything outside it was
          impossible, which is an odd limit on a tool whose entire purpose is
          comparing models. It stays as the fallback list and still supplies the
          friendly labels used elsewhere on this page. */}
      <ModelCombobox
        value={value}
        onChange={onChange}
        provider="openrouter"
        fallbackModels={MODELS.map((m) => m.id)}
        disabled={disabled}
        placeholder="Select model"
        className="h-8"
      />
    </div>
  );
}

function ResponsePanel({ panel, label }: { panel: PanelState; label: string }) {
  const model = MODELS.find((m) => m.id === panel.modelId);
  return (
    <div className="flex flex-col min-h-0">
      <div className="shrink-0 px-4 py-2 border-b border-border bg-muted/10 flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          {label}
        </Badge>
        <span className="text-xs font-medium truncate">{model?.label || panel.modelId}</span>
        {panel.loading && <Loader2 className="h-3 w-3 animate-spin text-primary ml-auto" />}
        {panel.durationMs !== null && !panel.loading && (
          <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
            {panel.costUsd !== null && (
              <span className="flex items-center gap-1 text-emerald-500">
                <Coins className="h-3 w-3" />
                ~${panel.costUsd.toFixed(4)}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {(panel.durationMs / 1000).toFixed(1)}s
            </span>
          </span>
        )}
      </div>
      <ScrollArea className="flex-1 p-4">
        {panel.error ? (
          <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
            {panel.error}
          </div>
        ) : panel.content ? (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownMessage content={panel.content} />
          </div>
        ) : !panel.loading ? (
          <p className="text-sm text-muted-foreground italic">Response will appear here…</p>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating…
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function ComparisonStats({ panels }: { panels: PanelState[] }) {
  const shortName = (modelId: string) => {
    const m = MODELS.find((x) => x.id === modelId);
    return m?.label?.split(" ").slice(-1)[0] ?? modelId;
  };
  // Highlight the best (lowest) value per row where lower is clearly better.
  const minIdx = (vals: Array<number | null>) => {
    let best = -1;
    let bestVal = Infinity;
    vals.forEach((v, i) => {
      if (v != null && v < bestVal) {
        bestVal = v;
        best = i;
      }
    });
    return best;
  };
  // A panel that produced no answer is not a competitor: its duration says how
  // fast it FAILED. MEASURED before this — an errored model won Response time
  // at 0.1s against 2.0s and 2.7s from the two that answered.
  const answered = (p: PanelState) => !p.error && p.content.trim().length > 0;
  const timeWinner = winnerIndex(
    panels.map((p) => ({ answered: answered(p), value: p.durationMs })),
  );
  const costWinner = winnerIndex(panels.map((p) => ({ answered: answered(p), value: p.costUsd })));
  const timeCaveat = comparisonCaveat(
    panels.map((p) => ({ answered: answered(p), value: p.durationMs })),
  );

  const rows: Array<{
    label: string;
    icon: typeof Clock;
    values: string[];
    winnerIdx: number;
  }> = [
    {
      label: "Response time",
      icon: Clock,
      values: panels.map((p) => (p.durationMs ? `${(p.durationMs / 1000).toFixed(1)}s` : "—")),
      winnerIdx: timeWinner,
    },
    {
      label: "Est. cost",
      icon: Coins,
      values: panels.map((p) => (p.costUsd != null ? `~$${p.costUsd.toFixed(4)}` : "—")),
      winnerIdx: costWinner,
    },
    {
      label: "Tokens (in/out)",
      icon: FileText,
      values: panels.map((p) =>
        p.tokensIn != null && p.tokensOut != null
          ? `${p.tokensIn}/${p.tokensOut}`
          : `~${p.tokenEstimate || 0}`,
      ),
      winnerIdx: -1,
    },
    {
      label: "Characters",
      icon: Zap,
      values: panels.map((p) => p.content.length.toLocaleString()),
      winnerIdx: -1,
    },
  ];

  return (
    <div>
      <p className="text-xs font-semibold mb-2">
        Comparison
        {timeCaveat && (
          <span className="ml-2 font-normal text-[10px] text-warning">({timeCaveat})</span>
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label} className="rounded-lg border border-border bg-card/60 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <row.icon className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-medium text-muted-foreground">{row.label}</span>
            </div>
            <div className="space-y-0.5 text-xs">
              {panels.map((p, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex justify-between gap-2 font-mono",
                    row.winnerIdx === i && "text-green-500 font-semibold",
                  )}
                >
                  <span className="text-muted-foreground">{shortName(p.modelId)}</span>
                  <span>{row.values[i]}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] text-muted-foreground italic">
        💡 Faster and cheaper isn't always better — weigh quality, accuracy, and
        instruction-following too. Cost and token counts come from the server; older models without
        a known price show ~$0.
      </p>
    </div>
  );
}
