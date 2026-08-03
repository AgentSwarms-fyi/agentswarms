// Public iframe embed: standalone chat agent at /embed/agent/<key>.
// No sign-in — the embed key (validated server-side against the embedding
// page's domain) is the only credential. The agent's prompt, model, KB and
// guardrails all stay server-side; this page only exchanges messages.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { parseWidgets, type BiWidget } from "@/lib/biDashboards";
import { historyForModel, settleTurns, withNotice, type EmbedTurn } from "@/lib/embedTurns";
import {
  resolveEmbed,
  streamEmbedChat,
  type EmbedChatMessage,
  type EmbedResolve,
} from "@/lib/embedClient";
import type { Citation } from "@/utils/tools/kb.server";

export const Route = createFileRoute("/embed/agent/$key")({
  head: () => ({ meta: [{ title: "Chat — AgentSwarms embed" }] }),
  validateSearch: (s: Record<string, unknown>) => ({
    preview: s.preview === "1" || s.preview === 1 ? ("1" as const) : undefined,
  }),
  component: EmbedAgentPage,
});

type Turn = EmbedTurn & { citations?: Citation[]; widgets?: BiWidget[] };

export function EmbedErrorCard({ error }: { error: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center">
      <ShieldAlert className="h-8 w-8 text-muted-foreground" />
      <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
    </div>
  );
}

export function EmbedFooter() {
  return (
    <div className="border-t border-border/50 px-3 py-1.5 text-center">
      <a
        href="/"
        target="_blank"
        rel="noreferrer"
        className="text-[10px] text-muted-foreground hover:text-foreground"
      >
        Powered by <span className="font-semibold">AgentSwarms</span>
      </a>
    </div>
  );
}

function EmbedAgentPage() {
  const { key } = Route.useParams();
  const { preview } = Route.useSearch();
  const isPreview = preview === "1";
  const [cfg, setCfg] = useState<Extract<EmbedResolve, { type: "agent" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    resolveEmbed(key, isPreview).then((r) => {
      if (!r.ok) setError(r.error);
      else if (r.data.type !== "agent") setError("This embed key is not for a chat agent.");
      else setCfg(r.data);
    });
  }, [key, isPreview]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const history = historyForModel(turns, q);
    setTurns((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content: "" }]);
    try {
      let citations: Citation[] = [];
      let widgets: BiWidget[] = [];
      await streamEmbedChat({
        key,
        preview: isPreview,
        messages: history,
        onCitations: (c) => {
          citations = c;
        },
        // Accumulates. The server sends at most one widget per answer today
        // (one generateEmbedWidget call on each of the two response paths), so
        // replacing was not a live bug — but it made the handler depend on
        // that, silently, from the other side of an SSE stream.
        onWidget: (w) => {
          widgets = [
            ...widgets,
            ...parseWidgets([w] as unknown as Parameters<typeof parseWidgets>[0]),
          ];
        },
        onToken: (t) =>
          setTurns((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, content: last.content + t };
            return copy;
          }),
      });
      if (citations.length > 0 || widgets.length > 0) {
        setTurns((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            ...(citations.length > 0 ? { citations } : {}),
            ...(widgets.length > 0 ? { widgets } : {}),
          };
          return copy;
        });
      }
    } catch (e) {
      setTurns((prev) => withNotice(prev, `⚠️ ${(e as Error).message}`));
    } finally {
      // An answer that produced no tokens leaves an assistant turn with empty
      // content, and empty content renders as a spinner — which would then
      // spin forever with busy already false.
      setTurns(settleTurns);
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

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">{cfg.name}</p>
          {cfg.description && (
            <p className="truncate text-[11px] text-muted-foreground">{cfg.description}</p>
          )}
        </div>
        {isPreview && (
          <span className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
            Preview
          </span>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && (
          <p className="py-12 text-center text-xs text-muted-foreground">
            Ask {cfg.name} anything to get started.
          </p>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                {t.content}
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-border/60 bg-card px-3.5 py-2 text-sm">
                {t.content ? (
                  <MarkdownMessage content={t.content} />
                ) : (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                {t.widgets && t.widgets.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {t.widgets
                      .filter((w) => w.kind === "chart" && (w.rows?.length ?? 0) > 0)
                      .map((w) => (
                        <div key={w.id} className="h-56">
                          <BiWidgetCard widget={w} />
                        </div>
                      ))}
                  </div>
                )}
                {t.citations && t.citations.length > 0 && (
                  <p className="mt-1.5 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground">
                    Sources: {t.citations.map((c) => `[${c.index}] ${c.documentName}`).join(" · ")}
                  </p>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      <div className="flex gap-1.5 border-t border-border/60 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${cfg.name}…`}
          className="h-10 flex-1 rounded-lg border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none"
          disabled={busy}
        />
        <Button
          size="icon"
          className="h-10 w-10"
          onClick={() => void send()}
          disabled={busy || !input.trim()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      <EmbedFooter />
    </div>
  );
}
