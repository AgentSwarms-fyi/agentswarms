// The Sheets assistant, beside the grid: ask in plain words; it reads the
// workbook (as the steps show), answers with numbers it computed, and
// proposes changes (a formula filled down, a chart, a highlight, a summary
// sheet) that apply with one click and undo with Ctrl+Z.

import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, Send, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  describeAction,
  EXPLAIN_HINT,
  FIX_HINT,
  MAX_TOOL_ROUNDS,
  type AssistAction,
  type AssistMessage,
  type AssistTool,
} from "@/lib/sheets/assist";
import { proposalProblems } from "@/lib/sheets/assistApply";
import { runTool, workbookContext, type TableColumns } from "@/lib/sheets/assistRuntime";
import type { WorkbookEngine } from "@/lib/sheets/engine";
import { cn } from "@/lib/utils";
import { sheetsAssist } from "@/utils/sheetsAssist.functions";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { DEFAULT_COL_W, ROW_H } from "./SheetGrid";

type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      steps: string[];
      actions: { action: AssistAction; state: "new" | "applied" | "failed"; note?: string }[];
      cost?: number | null;
      /** The model that answered, as provider/model. */
      model?: string;
    }
  | { role: "error"; text: string };

function stepText(t: AssistTool): string {
  const on = (s?: string) => (s ? `${s}!` : "");
  switch (t.tool) {
    case "read_range":
      return `Read ${on(t.sheet)}${t.range}`;
    case "evaluate":
      return `Computed ${t.formula}${t.sheet ? ` on ${t.sheet}` : ""}`;
    case "describe_sheet":
      return `Looked at the columns of ${t.sheet}`;
    case "find":
      return `Searched for "${t.text}"${t.sheet ? ` in ${t.sheet}` : ""}`;
  }
}

export function AssistPanel({
  engine,
  workbookId,
  workbookName,
  token,
  activeSheetId,
  selection,
  focus,
  tableColumns,
  asShare = null,
  readOnly = false,
  settle,
  apply,
  onFill,
  onClose,
  model = null,
  onModel,
  defaultModel = null,
}: {
  engine: WorkbookEngine;
  workbookId: string;
  workbookName: string;
  token: string | undefined;
  activeSheetId: string;
  selection: string;
  focus: { row: number; col: number };
  tableColumns?: TableColumns;
  /** The owner looking at the workbook as this share sees it. */
  asShare?: string | null;
  /** Shared to view: it answers, and proposes nothing to apply here. */
  readOnly?: boolean;
  settle?: () => Promise<void>;
  /** Carry out one proposed change; a sentence when it could not be done. */
  apply: (a: AssistAction) => Promise<string | null>;
  /** Open Fill with AI on the selection. */
  onFill: () => void;
  onClose: () => void;
  /** The model picked ("provider::model"), or null for the admin's (R158). */
  model?: string | null;
  onModel?: (m: string | null) => void;
  /** The admin's model, to name the default. */
  defaultModel?: string | null;
}) {
  const assistFn = useServerFn(sheetsAssist);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const history = useRef<AssistMessage[]>([]);
  const stop = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);
  useEffect(() => inputRef.current?.focus(), []);

  const activeInput = engine.getInput(activeSheetId, focus.row, focus.col)?.i ?? "";
  const activeValue = engine.getValue(activeSheetId, focus.row, focus.col);
  const activeError = activeValue !== null && typeof activeValue === "object";

  const ask = async (question: string, hint?: string) => {
    const q = question.trim();
    if (!q || busy) return;
    if (!token) {
      setTurns((t) => [...t, { role: "error", text: "Not signed in." }]);
      return;
    }
    stop.current = false;
    setInput("");
    setTurns((t) => [...t, { role: "user", text: q }]);
    history.current.push({ role: "user", content: hint ? `${q}\n\n(${hint})` : q });
    const steps: string[] = [];
    let cost = 0;
    let answeredBy: string | undefined;
    // Proposals that cannot be carried out go back to the model once (R132).
    let rechecked = false;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (stop.current) throw new Error("Stopped.");
        setBusy(round === 0 ? "Thinking…" : `Reading the workbook (step ${round})…`);
        const context = workbookContext({
          engine,
          workbookName,
          activeSheetId,
          selection,
          focus,
          tableColumns,
        });
        const r = await assistFn({
          data: {
            access_token: token,
            workbook_id: workbookId,
            as_share: asShare,
            context,
            messages: history.current,
            ...(model ? { model } : {}),
          },
        });
        if (!r.ok) throw new Error(r.error);
        cost += r.cost ?? 0;
        answeredBy = r.model;
        const reply = r.reply;
        if (reply.type === "tools" && round < MAX_TOOL_ROUNDS) {
          history.current.push({ role: "assistant", content: JSON.stringify(reply) });
          const results: string[] = [];
          for (const call of reply.calls) {
            steps.push(stepText(call));
            setBusy(stepText(call));
            results.push(
              `${stepText(call)} → ${await runTool(call, { engine, activeSheetId, tableColumns, settle })}`,
            );
          }
          history.current.push({ role: "tool", content: results.join("\n\n") });
          continue;
        }
        const text =
          reply.type === "answer"
            ? reply.text
            : "I could not finish looking things up in the steps allowed; ask again more narrowly.";
        const actions = reply.type === "answer" ? (reply.actions ?? []) : [];
        history.current.push({ role: "assistant", content: JSON.stringify(reply) });
        if (actions.length && !rechecked && round < MAX_TOOL_ROUNDS) {
          const problems = proposalProblems(actions, {
            engine,
            activeSheetId,
            colWidth: DEFAULT_COL_W,
            rowHeight: ROW_H,
          });
          if (problems.length) {
            rechecked = true;
            steps.push(
              `Checked the proposals: ${problems.length} could not be done as given; asked again`,
            );
            history.current.push({
              role: "tool",
              content: [
                "These proposals cannot be carried out as given:",
                ...problems.map((p) => `- ${describeAction(p.action)}: ${p.reason}`),
                "Reply again with your answer and proposals that avoid these problems. Nothing has been applied: say what the proposals will do.",
              ].join("\n"),
            });
            continue;
          }
        }
        setTurns((t) => [
          ...t,
          {
            role: "assistant",
            text,
            steps: [...steps],
            actions: actions.map((action) => ({ action, state: "new" as const })),
            cost,
            model: answeredBy,
          },
        ]);
        return;
      }
    } catch (e) {
      setTurns((t) => [...t, { role: "error", text: (e as Error).message }]);
      // Keep the conversation answerable: the failed question stays in it.
      history.current.push({ role: "assistant", content: `(failed: ${(e as Error).message})` });
    } finally {
      setBusy(null);
    }
  };

  const applyOne = async (turn: number, k: number) => {
    const t = turns[turn];
    if (t?.role !== "assistant") return;
    const problem = await apply(t.actions[k].action);
    setTurns((all) =>
      all.map((x, i) =>
        i === turn && x.role === "assistant"
          ? {
              ...x,
              actions: x.actions.map((a, j) =>
                j === k
                  ? { ...a, state: problem ? "failed" : "applied", note: problem ?? undefined }
                  : a,
              ),
            }
          : x,
      ),
    );
  };

  const chips: { label: string; run: () => void }[] = [
    ...(activeInput.startsWith("=")
      ? [
          {
            label: "Explain this formula",
            run: () => void ask("Explain the formula in the active cell.", EXPLAIN_HINT),
          },
        ]
      : []),
    ...(activeError
      ? [
          {
            label: "Fix this error",
            run: () =>
              void ask("Why does the active cell show an error, and how do I fix it?", FIX_HINT),
          },
        ]
      : []),
    {
      label: "Summarize this sheet",
      run: () => void ask("Summarize what this sheet holds and its key numbers."),
    },
    // These make changes: not offered where nothing can change.
    ...(readOnly
      ? []
      : [
          { label: "Build a summary sheet", run: () => setInput("Build a summary sheet of ") },
          { label: "Chart this", run: () => setInput("Chart ") },
          { label: "Highlight…", run: () => setInput("Highlight the rows where ") },
          {
            label: "Write a formula…",
            run: () => setInput(`In ${selection}, write a formula that `),
          },
        ]),
  ];

  return (
    <aside
      className="flex h-full w-[22rem] shrink-0 flex-col border-l border-border bg-background"
      aria-label="Sheets assistant"
      data-testid="assist-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Assistant</span>
        <span className="ml-1 truncate text-xs text-muted-foreground">
          reads this workbook as you see it
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-7 w-7"
          aria-label="Close the assistant"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {onModel && (
        <div
          className="flex items-center gap-2 border-b border-border px-3 py-1.5"
          data-testid="assist-model"
        >
          <span className="shrink-0 text-xs text-muted-foreground">Model</span>
          <BiModelSelect
            className="min-w-0 flex-1"
            value={model}
            onChange={onModel}
            allowUnset
            unsetLabel={defaultModel ? `Default · ${defaultModel}` : "Default"}
            unsetSub="the assistant's model, set by an admin"
            disabled={!!busy}
          />
        </div>
      )}
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        data-testid="assist-thread"
      >
        {turns.length === 0 && (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Ask about the data (&ldquo;total revenue for West in March&rdquo;), for a formula, a
              chart, a highlight or a summary sheet. Answers are computed by this workbook, and
              changes wait for your click.
            </p>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div
              key={i}
              className="ml-8 rounded-lg bg-primary/10 px-3 py-2 text-sm"
              data-testid="assist-question"
            >
              {t.text}
            </div>
          ) : t.role === "error" ? (
            <div
              key={i}
              className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {t.text}
            </div>
          ) : (
            <div key={i} className="space-y-2" data-testid="assist-answer">
              {t.steps.length > 0 && (
                <ul
                  className="space-y-0.5 text-[11px] text-muted-foreground"
                  data-testid="assist-steps"
                >
                  {t.steps.map((s, k) => (
                    <li key={k} className="truncate font-mono" title={s}>
                      · {s}
                    </li>
                  ))}
                </ul>
              )}
              <div className="whitespace-pre-wrap rounded-lg border border-border px-3 py-2 text-sm">
                {t.text}
              </div>
              {/* FOUND IN R131: the model wrote "I've added a Revenue column" over
                  proposals nothing had applied. Whatever it says, this says
                  where the workbook stands. */}
              {t.actions.some((a) => a.state !== "applied") && (
                <p className="text-[11px] text-muted-foreground" data-testid="assist-pending-note">
                  {readOnly
                    ? "These would change the workbook; it is shared with you to view."
                    : "Nothing has changed yet. Apply what you want (each one undoes with Ctrl+Z):"}
                </p>
              )}
              {t.actions.map((a, k) => (
                <div
                  key={k}
                  className={cn(
                    "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                    a.state === "applied"
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : "border-border",
                  )}
                  data-testid="assist-action"
                  data-state={a.state}
                >
                  <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 break-words">
                    {describeAction(a.action)}
                    {a.note && <span className="block text-destructive">{a.note}</span>}
                  </span>
                  {a.state === "applied" ? (
                    <span className="flex items-center gap-1 text-emerald-600">
                      <Check className="h-3.5 w-3.5" /> Applied
                    </span>
                  ) : readOnly ? (
                    <span className="text-muted-foreground">View only</span>
                  ) : (
                    <Button
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => void applyOne(i, k)}
                    >
                      Apply
                    </Button>
                  )}
                </div>
              ))}
              {(t.model || (typeof t.cost === "number" && t.cost > 0)) && (
                <p className="text-[10px] text-muted-foreground" data-testid="assist-meta">
                  {t.model && <span className="font-mono">{t.model}</span>}
                  {t.model && typeof t.cost === "number" && t.cost > 0 && " · "}
                  {typeof t.cost === "number" && t.cost > 0 && `Cost $${t.cost.toFixed(4)}`}
                </p>
              )}
            </div>
          ),
        )}
        {busy && (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="assist-busy"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {busy}
            <button
              type="button"
              className="ml-auto underline"
              onClick={() => (stop.current = true)}
            >
              Stop
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="space-y-2 border-t border-border p-3">
        <div className="flex flex-wrap gap-1">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              className="rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
              disabled={!!busy}
              onClick={() => {
                c.run();
                inputRef.current?.focus();
              }}
            >
              {c.label}
            </button>
          ))}
          {!readOnly && (
            <button
              type="button"
              className="rounded-full border border-primary/40 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10"
              onClick={onFill}
              data-testid="assist-fill"
            >
              Fill with AI…
            </button>
          )}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            rows={2}
            placeholder={`Ask about ${engine.sheet(activeSheetId)?.name ?? "this sheet"}…`}
            aria-label="Ask the assistant"
            className="min-h-0 resize-none text-sm"
            disabled={!!busy}
          />
          <Button
            type="submit"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={!!busy || !input.trim()}
            aria-label="Ask"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </aside>
  );
}
