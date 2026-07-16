import { useState, useEffect, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import { Play, Loader2, ChevronsRight, Copy, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotebookCodeCell, CellRunResult } from "@/lib/notebooks/types";

import { useTheme } from "@/hooks/use-theme";

type Props = {
  notebookId: string;
  cell: NotebookCodeCell;
  active: boolean;
  onFocus: () => void;
  executionCount: number | null;
  onExecuted: () => number;
};

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** Pulls inline image URLs out of a result string for preview rendering.
 *  Matches data:image/* URLs (base64) and image URLs in JSON string values. */
function extractImageUrls(s: string): string[] {
  const out = new Set<string>();
  const dataRe = /data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g;
  for (const m of s.match(dataRe) ?? []) out.add(m);
  const urlRe = /"(https?:\/\/[^"\s]+?\.(?:png|jpe?g|gif|webp|svg))(?:\?[^"]*)?"/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(s)) !== null) out.add(m[1]);
  return Array.from(out).slice(0, 6);
}

/** Replace long base64 data URLs with a short stub so the JSON pre stays readable. */
function truncateDataUrls(s: string): string {
  return s.replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g, (m) =>
    `${m.slice(0, 48)}… [${m.length} chars, rendered above]`
  );
}

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "13px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "hsl(var(--muted-foreground))" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: "10px 0" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  "&.cm-focused": { outline: "none" },
});

export function CodeCell({ notebookId, cell, active, onFocus, executionCount, onExecuted }: Props) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [source, setSource] = useState(cell.source);
  const [running, setRunning] = useState(false);
  const [localCount, setLocalCount] = useState<number | null>(executionCount);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [hidden, setHidden] = useState(false);

  const [result, setResult] = useState<CellRunResult | null>(
    cell.sampleOutput
      ? {
          ok: true,
          logs: cell.sampleOutput.logs ?? [],
          result: cell.sampleOutput.result !== undefined ? safeStringify(cell.sampleOutput.result) : undefined,
          durationMs: 0,
        }
      : null
  );

  const run = useCallback(async () => {
    setRunning(true);
    setLocalCount(null);
    try {
      let mod: typeof import("@/lib/notebooks/runCellBrowser");
      try {
        mod = await import("@/lib/notebooks/runCellBrowser");
      } catch (importErr) {
        // Stale chunk after a new deploy — hashed filename no longer exists.
        // Reload once to pick up the new asset manifest.
        const msg = importErr instanceof Error ? importErr.message : String(importErr);
        if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) {
          if (typeof window !== "undefined" && !sessionStorage.getItem("__notebook_reloaded__")) {
            sessionStorage.setItem("__notebook_reloaded__", "1");
            window.location.reload();
            return;
          }
        }
        throw importErr;
      }
      sessionStorage.removeItem("__notebook_reloaded__");
      const out = await mod.runCellInBrowser(notebookId, source);
      setResult(out);
      setLocalCount(onExecuted());
    } catch (e) {
      setResult({ ok: false, logs: [], error: e instanceof Error ? e.message : String(e), durationMs: 0 });
      setLocalCount(onExecuted());
    } finally {
      setRunning(false);
    }
  }, [notebookId, source, onExecuted]);

  if (hidden) return null;

  const promptLabel = running ? "*" : localCount !== null ? String(localCount) : " ";
  const resultImageUrls = result?.result ? extractImageUrls(result.result) : [];

  return (
    <div
      className={cn(
        "group relative my-3 flex w-full border-l-2 transition-colors",
        active ? "border-l-primary" : "border-l-transparent hover:border-l-border"
      )}
      onClick={onFocus}
    >
      {/* Prompt rail */}
      <div className="flex w-14 shrink-0 flex-col items-end pt-3 pr-2 font-mono text-[11px] text-blue-400 select-none">
        <button
          onClick={(e) => { e.stopPropagation(); void run(); }}
          className="mb-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Run cell (Shift+Enter)"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-current" />}
        </button>
        <div>[{promptLabel}]:</div>
      </div>

      <div className="flex-1 min-w-0">
        {/* Editor */}
        <div className={cn(
          "relative rounded-md border overflow-hidden",
          isDark ? "bg-[#1e1e1e] border-[#2d2d2d]" : "bg-[#fafafa] border-border"
        )}>
          {/* action icons */}
          <div className="absolute right-2 top-1.5 z-10 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
            <button
              title="Run from here"
              onClick={(e) => { e.stopPropagation(); void run(); }}
              className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </button>
            <button
              title="Run cell"
              onClick={(e) => { e.stopPropagation(); void run(); }}
              className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
            <button
              title="Copy"
              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(source); }}
              className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button
              title="Clear output"
              onClick={(e) => { e.stopPropagation(); setResult(null); setLocalCount(null); }}
              className="h-6 w-6 flex items-center justify-center rounded text-red-500 hover:text-red-400 hover:bg-muted"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {mounted ? (
            <CodeMirror
              value={source}
              onChange={(v) => setSource(v)}
              onFocus={onFocus}
              theme={isDark ? vscodeDark : vscodeLight}
              extensions={[javascript({ jsx: false, typescript: false }), editorTheme]}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                indentOnInput: true,
              }}
              onKeyDown={(e) => {
                if ((e.shiftKey || e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void run();
                }
              }}
            />
          ) : (
            <pre className="m-0 px-3 py-2 font-mono text-[13px] leading-5 text-foreground whitespace-pre-wrap">{source}</pre>
          )}

        </div>

        {/* Output */}
        {(running || result) && (
          <div className={cn(
            "mt-1 rounded-md border px-4 py-3 font-mono text-[12px] leading-5 text-foreground",
            isDark ? "bg-[#0f0f0f] border-[#2d2d2d]" : "bg-muted/40 border-border"
          )}>
            {running && !result && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Running…
              </div>
            )}
            {result?.logs && result.logs.length > 0 && (
              <pre className="whitespace-pre-wrap break-words text-foreground/90">
                {result.logs.join("\n")}
              </pre>
            )}
            {result?.error && (
              <pre className="mt-1 whitespace-pre-wrap break-words text-red-500">
                {result.error}
              </pre>
            )}
            {result?.result !== undefined && (
              <>
                {resultImageUrls.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-3">
                    {resultImageUrls.map((src: string, i: number) => (
                      <img
                        key={i}
                        src={src}
                        alt={`Cell output preview ${i + 1}`}
                        className="h-auto max-h-[70vh] w-auto max-w-full rounded border border-border bg-background/40 object-contain"
                      />
                    ))}
                  </div>
                )}
                <pre className={cn(
                  "mt-1 whitespace-pre-wrap break-words max-h-96 overflow-auto",
                  isDark ? "text-emerald-300" : "text-emerald-700"
                )}>
                  {truncateDataUrls(result.result)}
                </pre>
              </>
            )}
            {result && result.durationMs > 0 && (
              <div className="mt-2 text-[10px] text-muted-foreground">
                {result.ok ? "✓ completed" : "✗ failed"} in {result.durationMs}ms · {cell.runtime}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
