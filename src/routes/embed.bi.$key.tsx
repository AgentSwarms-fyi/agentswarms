// Public iframe embed: BI dashboard at /embed/bi/<key>, with an optional
// "Ask AI" analyst when the embed key enables it. Rendering matches the
// public share page (snapshots + filters + cross-filtering); the analyst
// answers server-side from the stored dashboard using the owner's
// credentials and the publisher's reader model.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { BiFilterBar } from "@/components/bi/BiFilterBar";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { DashboardGrid } from "@/components/bi/DashboardGrid";
import {
  dashSurfaceStyle,
  defaultFilterState,
  filterWidgetRows,
  parseDashTheme,
  parseFilters,
  parseLayout,
  parsePages,
  parseWidgets,
  type BiCrossFilter,
  type BiFilterState,
} from "@/lib/biDashboards";
import { cn } from "@/lib/utils";
import type { Json } from "@/integrations/supabase/types";
import { EmbedErrorCard } from "@/routes/embed.agent.$key";
import { askEmbedDashboard, resolveEmbed, type EmbedResolve } from "@/lib/embedClient";

export const Route = createFileRoute("/embed/bi/$key")({
  head: () => ({ meta: [{ title: "Dashboard — AgentSwarms embed" }] }),
  validateSearch: (s: Record<string, unknown>) => ({
    preview: s.preview === "1" || s.preview === 1 ? ("1" as const) : undefined,
  }),
  component: EmbedBiPage,
});

type AskTurn = { question: string; answer?: string; error?: string };

function EmbedBiPage() {
  const { key } = Route.useParams();
  const { preview } = Route.useSearch();
  const isPreview = preview === "1";
  const [cfg, setCfg] = useState<Extract<EmbedResolve, { type: "bi_dashboard" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterState, setFilterState] = useState<BiFilterState>({});
  const [cross, setCross] = useState<BiCrossFilter>(null);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [askOpen, setAskOpen] = useState(false);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    resolveEmbed(key, isPreview).then((r) => {
      if (!r.ok) setError(r.error);
      else if (r.data.type !== "bi_dashboard") setError("This embed key is not for a dashboard.");
      else {
        setCfg(r.data);
        setFilterState(defaultFilterState(parseFilters(r.data.filters as Json)));
      }
    });
  }, [key, isPreview]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setQuestion("");
    setBusy(true);
    setTurns((prev) => [...prev, { question: q }]);
    try {
      const answer = await askEmbedDashboard({ key, preview: isPreview, question: q });
      setTurns((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { question: q, answer };
        return copy;
      });
    } catch (e) {
      setTurns((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { question: q, error: (e as Error).message };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  if (error) return <EmbedErrorCard error={error} />;
  if (!cfg) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const theme = parseDashTheme(cfg.theme as Json);
  const filterConfigs = parseFilters(cfg.filters as Json);
  const topWidgets = parseWidgets(cfg.widgets as Json);
  const pages = parsePages(
    cfg.pages as Json,
    topWidgets,
    parseLayout(cfg.layout as Json, topWidgets),
  );
  const activePage = pages[Math.min(activePageIndex, pages.length - 1)] ?? pages[0];
  const widgets = activePage.widgets;
  const layout = activePage.layout;
  const widgetById = new Map(
    widgets.map((w) => [
      w.id,
      w.kind === "chart" && (w.rows?.length ?? 0) > 0
        ? { ...w, rows: filterWidgetRows(w, filterConfigs, filterState, cross) }
        : w,
    ]),
  );

  return (
    <div className="min-h-screen bg-background">
      <main className="p-3" style={dashSurfaceStyle(theme)}>
        {pages.length > 1 && (
          <div className="mb-3 flex items-center gap-1 overflow-x-auto pb-1">
            {pages.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setActivePageIndex(i);
                  setCross(null);
                }}
                className={cn(
                  "h-8 shrink-0 rounded-md px-3 text-xs",
                  i === activePageIndex
                    ? "border border-border bg-background font-medium shadow-sm"
                    : "text-muted-foreground hover:bg-background/60",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <BiFilterBar
          configs={filterConfigs}
          widgets={widgets}
          state={filterState}
          onStateChange={setFilterState}
          cross={cross}
          onClearCross={() => setCross(null)}
        />
        <DashboardGrid
          layout={layout}
          editable={false}
          emptyState={
            <p className="py-20 text-center text-sm text-muted-foreground">
              This dashboard has no widgets yet.
            </p>
          }
          renderItem={(id) => {
            const w = widgetById.get(id);
            return w ? (
              <BiWidgetCard
                widget={w}
                onElementClick={(column, value) =>
                  setCross((prev) =>
                    prev && prev.column === column && prev.value === value
                      ? null
                      : { widgetId: id, column, value },
                  )
                }
              />
            ) : null;
          }}
        />
      </main>

      {cfg.allowAi && (
        <>
          {!askOpen && (
            <Button
              className="fixed bottom-4 right-4 z-40 shadow-lg"
              size="sm"
              onClick={() => setAskOpen(true)}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Ask AI
            </Button>
          )}
          {askOpen && (
            <div className="fixed bottom-4 right-4 z-40 flex max-h-[70vh] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> Ask AI · {cfg.name}
                </p>
                <button
                  type="button"
                  onClick={() => setAskOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div ref={scrollRef} className="min-h-32 flex-1 space-y-2.5 overflow-y-auto p-3">
                {turns.length === 0 && (
                  <p className="py-6 text-center text-[11px] text-muted-foreground">
                    e.g. “Which region is underperforming?” — answers come from this dashboard's
                    data.
                  </p>
                )}
                {turns.map((t, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs">
                        {t.question}
                      </div>
                    </div>
                    {t.answer ? (
                      <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs">
                        <MarkdownMessage content={t.answer} />
                      </div>
                    ) : t.error ? (
                      <p className="text-[11px] text-destructive">{t.error}</p>
                    ) : (
                      <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Analysing…
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-1.5 border-t border-border/60 p-2">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void ask();
                    }
                  }}
                  placeholder="Ask about this dashboard…"
                  className="h-8 flex-1 rounded-md border border-border bg-background px-2.5 text-xs focus:border-primary focus:outline-none"
                  disabled={busy}
                />
                <Button
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => void ask()}
                  disabled={busy || !question.trim()}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
