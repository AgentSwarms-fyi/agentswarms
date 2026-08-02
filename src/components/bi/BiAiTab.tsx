// The BI Workspace's "AI analyst" tab: ask a question, read the SQL it wrote,
// insert the answer as a widget.
//
// Split out of BiBuilderPane, which was 2,700 lines. This tab is 230 of them
// and touches twenty of the parent's values, so it pays for its prop list —
// unlike the standard chart editor, which needs eighty and is deliberately
// left where it is.
//
// EVERY HOOK STAYS IN THE PARENT. This component owns no state; it receives
// values and setters. That is what makes the split a refactor rather than a
// rewrite: hook order and effect timing are untouched.
import type React from "react";
import { toast } from "sonner";
import { ChevronsUpDown, Loader2, Plus, Send, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { BiChatMessage } from "@/components/data-sql/BiChatMessage";
import type { BiDataContext } from "@/components/bi/biDataContext";
import type { BiTurn } from "@/lib/biAgent";
import { cn } from "@/lib/utils";

/** How many knowledge-base documents the analyst may be given at once. */
export const MAX_AI_DOCS = 6;

export type KbDocOption = { id: string; name: string; kbName: string };
/** One table the active source exposes. Shaped by the parent's SourceTable. */
export type AiSourceTable = { name: string };

export type BiAiTabProps = {
  ctx: BiDataContext;
  title: string;
  question: string;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  turns: BiTurn[];
  turnsScrollRef: React.RefObject<HTMLDivElement | null>;
  aiBusy: boolean;
  aiTables: string[];
  setAiTables: React.Dispatch<React.SetStateAction<string[]>>;
  aiDocs: string[];
  setAiDocs: React.Dispatch<React.SetStateAction<string[]>>;
  /** [kbName, docs] pairs — the parent groups them with a Map. */
  docGroups: [string, KbDocOption[]][];
  /**
   * The loaded documents, or a sentinel. `null` means "not fetched yet" and is
   * what makes the popover fetch on first open rather than on mount.
   */
  kbDocOptions: KbDocOption[] | "loading" | "error" | null;
  loadKbDocs: () => void;
  insertTurn: (turn: BiTurn, index: number) => void;
  /** Indices already inserted as widgets, so the button can say so. */
  insertedIdx: Set<number>;
  sendQuestion: () => void;
  /** The source picker, rendered by the parent and shared with the build tab. */
  sourceSelect: React.ReactNode;
  sourceTables: AiSourceTable[];
  schemaLoading: boolean;
};

export function BiAiTab({
  ctx,
  title,
  question,
  setQuestion,
  turns,
  turnsScrollRef,
  aiBusy,
  aiTables,
  setAiTables,
  aiDocs,
  setAiDocs,
  docGroups,
  kbDocOptions,
  loadKbDocs,
  insertTurn,
  insertedIdx,
  sendQuestion,
  sourceSelect,
  sourceTables,
  schemaLoading,
}: BiAiTabProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 p-3 pb-2">
        {sourceSelect}
        {ctx.onModelChange && (
          <div className="space-y-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              AI model
            </Label>
            <BiModelSelect
              value={ctx.model ?? null}
              onChange={ctx.onModelChange}
              className="w-full"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tables to analyse
          </Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-full justify-between gap-1.5 text-xs font-normal"
                title="Limit which tables the analyst may use"
              >
                <span className="truncate">
                  {aiTables.length === 0
                    ? "All tables"
                    : aiTables.length === 1
                      ? aiTables[0]
                      : `${aiTables.length} tables selected`}
                </span>
                <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {sourceTables.length === 0 && (
                  <p className="px-1 py-2 text-[11px] text-muted-foreground">
                    {schemaLoading ? "Loading tables…" : "No tables for this source."}
                  </p>
                )}
                {sourceTables.map((t) => {
                  const checked = aiTables.includes(t.name);
                  return (
                    <Label
                      key={t.name}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-[11px] font-normal hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(on) =>
                          setAiTables((prev) =>
                            on ? [...prev, t.name] : prev.filter((x) => x !== t.name),
                          )
                        }
                      />
                      <span className="truncate">{t.name}</span>
                    </Label>
                  );
                })}
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-border/50 pt-1.5">
                <p className="text-[10px] text-muted-foreground">Empty = analyse all tables</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setAiTables([])}
                >
                  Clear
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Knowledge documents
          </Label>
          <Popover onOpenChange={(open) => open && void loadKbDocs()}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-full justify-between gap-1.5 text-xs font-normal"
                title="Blend unstructured context from your knowledge bases into the analysis"
              >
                <span className="truncate">
                  {aiDocs.length === 0
                    ? "None — structured data only"
                    : aiDocs.length === 1
                      ? ((Array.isArray(kbDocOptions)
                          ? kbDocOptions.find((o) => o.id === aiDocs[0])?.name
                          : undefined) ?? "1 document selected")
                      : `${aiDocs.length} documents selected`}
                </span>
                <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {kbDocOptions === "loading" && (
                  <p className="flex items-center gap-1.5 px-1 py-2 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading documents…
                  </p>
                )}
                {kbDocOptions === "error" && (
                  <p className="px-1 py-2 text-[11px] text-destructive">
                    Couldn't load your knowledge documents — close and reopen to retry.
                  </p>
                )}
                {Array.isArray(kbDocOptions) && kbDocOptions.length === 0 && (
                  <p className="px-1 py-2 text-[11px] text-muted-foreground">
                    No documents with text content — add some on the Knowledge page first.
                  </p>
                )}
                {docGroups.map(([kb, docs]) => (
                  <div key={kb}>
                    <p className="px-1.5 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                      {kb}
                    </p>
                    {docs.map((d) => {
                      const checked = aiDocs.includes(d.id);
                      return (
                        <Label
                          key={d.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] font-normal hover:bg-muted/60"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(on) =>
                              setAiDocs((prev) => {
                                if (!on) return prev.filter((x) => x !== d.id);
                                if (prev.length >= MAX_AI_DOCS) {
                                  toast.info(
                                    `Up to ${MAX_AI_DOCS} documents per question — deselect one first.`,
                                  );
                                  return prev;
                                }
                                return [...prev, d.id];
                              })
                            }
                          />
                          <span className="truncate">{d.name}</span>
                        </Label>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-border/50 pt-1.5">
                <p className="text-[10px] text-muted-foreground">
                  The analyst cross-references docs with your data
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => setAiDocs([])}
                >
                  Clear
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {schemaLoading && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> loading schema…
          </span>
        )}
      </div>
      <div
        ref={turnsScrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-border/50 bg-muted/20 p-3"
      >
        {turns.length === 0 && (
          <p className="py-10 text-center text-xs text-muted-foreground">
            Ask a business question — the analyst writes and runs the SQL, picks a chart, and
            explains the result. Select knowledge documents to blend unstructured context into the
            insight. Insert any answer as a widget.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-1.5">
            <BiChatMessage turn={t} />
            {t.status === "done" && t.result && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  variant={insertedIdx.has(i) ? "secondary" : "default"}
                  onClick={() => insertTurn(t, i)}
                >
                  <Plus className="h-3 w-3" />
                  {insertedIdx.has(i) ? "Insert again" : "Insert into dashboard"}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 border-t border-border p-3">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendQuestion();
            }
          }}
          placeholder="Ask a business question…"
          className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-xs focus:border-primary focus:outline-none"
          disabled={aiBusy}
        />
        <Button
          size="icon"
          className="h-9 w-9"
          onClick={() => void sendQuestion()}
          disabled={aiBusy || !question.trim() || schemaLoading}
        >
          {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
