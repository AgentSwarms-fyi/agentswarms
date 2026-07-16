import { useState, useCallback, useEffect } from "react";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { CodeCell } from "./CodeCell";
import type { Notebook } from "@/lib/notebooks/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FastForward, RotateCcw } from "lucide-react";

export function NotebookViewer({ notebook }: { notebook: Notebook }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [counter, setCounter] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    const main = document.querySelector("[data-notebooks-main]");
    if (main) main.scrollTo({ top: 0, left: 0 });
    else window.scrollTo({ top: 0, left: 0 });
  }, [notebook.id]);

  const bumpExecution = useCallback((cellId: string) => {
    let next = 0;
    setCounter((c) => { next = c + 1; return next; });
    setCounts((m) => ({ ...m, [cellId]: next + 1 }));
    return next + 1;
  }, []);

  return (
    <div key={resetKey} className="w-full bg-background text-foreground min-h-full">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 backdrop-blur px-6 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono">
          <span>{notebook.id}.ipynb</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs"
            onClick={() => { setCounter(0); setCounts({}); setResetKey((k) => k + 1); }}>
            <RotateCcw className="h-3 w-3" /> Restart
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" disabled>
            <FastForward className="h-3 w-3" /> Run all
          </Button>
        </div>
      </div>

      {/* Header */}
      <header className="space-y-3 px-8 pt-6 pb-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{notebook.difficulty}</Badge>
          {notebook.tags.map((t) => (
            <Badge key={t} variant="outline">{t}</Badge>
          ))}
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{notebook.title}</h1>
        <p className="text-muted-foreground">{notebook.description}</p>
      </header>

      <div className="px-6 pb-32 pt-4">
        {notebook.cells.map((cell) => {
          if (cell.kind === "markdown") {
            return (
              <div
                key={cell.id}
                onClick={() => setActiveId(cell.id)}
                className={`group relative border-l-2 px-4 py-3 transition-colors ${
                  activeId === cell.id ? "border-l-primary" : "border-l-transparent hover:border-l-border"
                }`}
              >
                <div className="pl-14 prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownMessage content={cell.source} />
                </div>
              </div>
            );
          }
          return (
            <CodeCell
              key={cell.id}
              notebookId={notebook.id}
              cell={cell}
              active={activeId === cell.id}
              onFocus={() => setActiveId(cell.id)}
              executionCount={counts[cell.id] ?? null}
              onExecuted={() => bumpExecution(cell.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

