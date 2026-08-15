// Public iframe embed: an AI Analyst at /embed/analyst/<key>.
//
// The visitor types a question and gets the analyst's full reasoning — the
// stated approach, each step's result and chart, the findings, and what to
// ask next. The loop runs SERVER-side as the analyst's owner (see
// utils/analyst/run.server.ts); this page sends a question and renders the
// finished trace.
//
// WHAT IS DELIBERATELY MISSING, compared with the signed-in screen:
//
//   • The SQL. The app shows it because the reader is the owner and being
//     able to re-run it is the point. Here it would publish internal table
//     and column names to anyone who loads the page — the same reason the
//     dashboard embed sanitises `sql` out of every widget.
//   • Edit-and-re-run, pin-to-dashboard, verify, and what-if scenarios. Each
//     writes to the owner's workspace or asserts a human verdict, and an
//     anonymous visitor is not a principal that can do either.
//
// What remains is the analysis itself, which is what the reader came for.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BiChartRender } from "@/components/bi/BiChartRender";
import { WidgetDataTable } from "@/components/bi/BiWidgetCard";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import type { AnalystStep, AnalystTurn } from "@/lib/aiAnalyst";
import { EmbedErrorCard } from "@/routes/embed.agent.$key";
import { analyzeEmbed, resolveEmbed, type EmbedResolve } from "@/lib/embedClient";

export const Route = createFileRoute("/embed/analyst/$key")({
  head: () => ({ meta: [{ title: "AI Analyst — AgentSwarms embed" }] }),
  validateSearch: (s: Record<string, unknown>) => ({
    preview: s.preview === "1" || s.preview === 1 ? ("1" as const) : undefined,
  }),
  component: EmbedAnalystPage,
});

/**
 * What the analyst is doing right now, named.
 *
 * A generic "working…" for 95 seconds is indistinguishable from a hang. Each
 * label is the stage the loop is actually in, so the wait is legible and a
 * reader can tell a slow plan from a slow query.
 */
const STAGE_LABEL: Record<string, string> = {
  planning: "Planning the approach…",
  working: "Writing and running the queries…",
  checking: "Checking the results against each step's goal…",
  synthesizing: "Writing up the findings…",
  clarifying: "Asking for a clarification…",
  done: "Finishing up…",
  error: "Something went wrong.",
};

function StepView({ step, n }: { step: AnalystStep; n: number }) {
  const rows = Array.isArray(step.rows) ? step.rows : [];
  const columns = step.columns ?? [];
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="mb-2 text-xs font-medium">
        <span className="mr-1.5 text-muted-foreground">{n}.</span>
        {step.goal}
      </p>
      {step.error ? (
        // Shown, not swallowed: an analysis with a failed step reached its
        // findings without that step, and the reader should know which.
        <p className="text-[11px] text-destructive">This step could not run.</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No rows matched.</p>
      ) : step.chart && step.chart.type !== "table" ? (
        <div className="h-56">
          <BiChartRender chart={step.chart} rows={rows} fill />
        </div>
      ) : (
        <div className="max-h-56 overflow-auto">
          <WidgetDataTable columns={columns} rows={rows} />
        </div>
      )}
      {typeof step.rowCount === "number" && step.rowCount > rows.length && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          Showing {rows.length} of {step.rowCount.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}

function TurnCard({
  turn,
  onAsk,
  live,
}: {
  turn: AnalystTurn;
  onAsk: (q: string) => void;
  /** Still being produced — suppress affordances that need a finished turn. */
  live?: boolean;
}) {
  return (
    <div className={live ? "space-y-2.5 opacity-95" : "space-y-2.5"}>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-1.5 text-sm">
          {turn.question}
        </div>
      </div>
      {turn.approach && (
        <p className="text-xs italic leading-relaxed text-muted-foreground">{turn.approach}</p>
      )}
      {turn.clarify ? (
        // The analyst stopped rather than guessing. Offer the assumption as a
        // click so the visitor is not left retyping the question.
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
          <p className="text-xs">{turn.clarify}</p>
          {turn.assumption && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 text-xs"
              onClick={() => onAsk(`${turn.question} — assume ${turn.assumption}`)}
            >
              Assume {turn.assumption}
            </Button>
          )}
        </div>
      ) : (
        <>
          {turn.steps.map((s, i) => (
            <StepView key={i} step={s} n={i + 1} />
          ))}
          {turn.answer && (
            <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-sm">
              <MarkdownMessage content={turn.answer} />
            </div>
          )}
          {!live && (turn.followUps ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {turn.followUps!.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => onAsk(q)}
                  className="rounded-full border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmbedAnalystPage() {
  const { key } = Route.useParams();
  const { preview } = Route.useSearch();
  const isPreview = preview === "1";
  const [cfg, setCfg] = useState<Extract<EmbedResolve, { type: "ai_analyst" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<AnalystTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  // The turn currently being produced, rendered live. The analyst takes
  // 30–95s and its reasoning IS the product, so it unfolds rather than
  // appearing all at once when the connection closes.
  const [liveTurn, setLiveTurn] = useState<AnalystTurn | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    resolveEmbed(key, isPreview).then((r) => {
      if (!r.ok) setError(r.error);
      else if (r.data.type !== "ai_analyst") setError("This embed key is not for an AI analyst.");
      else setCfg(r.data);
    });
  }, [key, isPreview]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setQuestion("");
    setBusy(true);
    setTurnError(null);
    const res = await analyzeEmbed({
      key,
      preview: isPreview,
      question: q,
      priorTurns: turns,
      onTurn: (t) => setLiveTurn(t as AnalystTurn),
    });
    setBusy(false);
    setLiveTurn(null);
    if (!res.ok) {
      // The reason, verbatim — "no credits", "rate limited", "the analyst's
      // data source is unavailable" each send the reader somewhere different.
      setTurnError(res.error);
      return;
    }
    setTurns((prev) => [...prev, res.turn as AnalystTurn]);
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
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <BrainCircuit className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold">{cfg.name}</p>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto p-4">
        {turns.length === 0 && !busy && (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">Ask a question about the data.</p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {cfg.starters.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void ask(q)}
                  className="rounded-full border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <TurnCard key={i} turn={t} onAsk={(q) => void ask(q)} />
        ))}
        {liveTurn && <TurnCard turn={liveTurn} onAsk={() => {}} live />}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {STAGE_LABEL[liveTurn?.status ?? "planning"]}
          </div>
        )}
        {turnError && <p className="text-xs text-destructive">{turnError}</p>}
      </div>

      <div className="flex gap-2 border-t border-border/60 p-3">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(question);
            }
          }}
          placeholder="Ask about the data…"
          className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm focus:border-primary focus:outline-none"
          disabled={busy}
        />
        <Button
          size="icon"
          className="h-9 w-9"
          onClick={() => void ask(question)}
          disabled={busy || !question.trim()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
