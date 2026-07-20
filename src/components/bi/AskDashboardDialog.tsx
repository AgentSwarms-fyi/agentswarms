// "Ask AI" for dashboard viewers: question-answering over the dashboard's
// stored widget snapshots, using the reader model the publisher selected.
// Works for read-only (shared) viewers — no data-source access is needed.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Send, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { askDashboardQuestion } from "@/lib/biAgent";
import type { BiWidget } from "@/lib/biDashboards";

type Turn = { question: string; answer?: string; error?: string };

export function AskDashboardDialog({
  open,
  onOpenChange,
  dashboardName,
  widgets,
  model,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dashboardName: string;
  widgets: BiWidget[];
  /** Reader model chosen by the publisher (null = server default). */
  model: string | null;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTurns([]);
      setQuestion("");
    }
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function send() {
    const q = question.trim();
    if (!q || busy) return;
    if (!widgets.some((w) => (w.rows?.length ?? 0) > 0 || w.kind === "text")) {
      return toast.error("This dashboard has no data to ask about yet.");
    }
    setQuestion("");
    setBusy(true);
    setTurns((prev) => [...prev, { question: q }]);
    try {
      const answer = await askDashboardQuestion({
        question: q,
        model: model ?? undefined,
        widgets: widgets.map((w) => ({
          title: w.title,
          kind: w.kind,
          columns: w.columns,
          rows: w.rows?.slice(0, 15),
          text: w.text,
        })),
      });
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Ask AI about “{dashboardName}”
          </DialogTitle>
          <DialogDescription>
            Answers come from the dashboard's saved data snapshots
            {model ? (
              <>
                {" "}
                using <code className="text-[11px]">{model}</code>
              </>
            ) : (
              " using the default model"
            )}
            .
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollRef}
          className="min-h-40 flex-1 space-y-3 overflow-y-auto rounded-md border border-border/50 bg-muted/20 p-3"
        >
          {turns.length === 0 && (
            <p className="py-10 text-center text-xs text-muted-foreground">
              e.g. “Which region is underperforming?” or “Summarise the key trends.”
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-xs">
                  {t.question}
                </div>
              </div>
              {t.answer ? (
                <div className="rounded-lg border border-border/50 bg-card px-3 py-2">
                  <MarkdownMessage content={t.answer} />
                </div>
              ) : t.error ? (
                <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                  {t.error}
                </p>
              ) : (
                <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Analysing the dashboard data…
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-1.5">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask a question about this dashboard…"
            className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-xs focus:border-primary focus:outline-none"
            disabled={busy}
          />
          <Button
            size="icon"
            className="h-9 w-9"
            onClick={() => void send()}
            disabled={busy || !question.trim()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
