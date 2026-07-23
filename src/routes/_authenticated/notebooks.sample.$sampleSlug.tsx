// Read-only viewer for a shipped sample notebook. Cells can be RUN (Pyodide,
// same runtime as the editor) but not edited — "Fork to my notebooks" copies
// the cells into an editable notebook owned by the signed-in user.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import { ChevronsRight, GitFork, Loader2, Lock, Play, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { runPythonCell, type CellRunResult } from "@/lib/pythonRuntime";
import { getSampleNotebook } from "@/lib/sampleNotebooks";
import type { PyCell } from "@/lib/pythonNotebookTemplate";

export const Route = createFileRoute("/_authenticated/notebooks/sample/$sampleSlug")({
  component: SampleNotebookPage,
});

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "13px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "hsl(var(--muted-foreground))",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "10px 0",
  },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  "&.cm-focused": { outline: "none" },
});

type CellOutput = CellRunResult | "running";

function SampleNotebookPage() {
  const { sampleSlug } = Route.useParams();
  const navigate = useNavigate();
  const { user, session } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const sample = getSampleNotebook(sampleSlug);
  const [outputs, setOutputs] = useState<Record<string, CellOutput>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [forking, setForking] = useState(false);

  const runCell = useCallback(
    async (cell: PyCell) => {
      setOutputs((o) => ({ ...o, [cell.id]: "running" }));
      const res = await runPythonCell(cell.source, session?.access_token ?? null);
      setOutputs((o) => ({ ...o, [cell.id]: res }));
      return res;
    },
    [session?.access_token],
  );

  const runAll = async () => {
    if (!sample) return;
    setRunningAll(true);
    try {
      for (const c of sample.cells) {
        if (c.type !== "code") continue;
        const res = await runCell(c);
        if (res.error) break;
      }
    } finally {
      setRunningAll(false);
    }
  };

  const fork = async () => {
    if (!sample || !user || forking) return;
    setForking(true);
    try {
      const { data, error } = await supabase
        .from("user_python_notebooks")
        .insert({
          user_id: user.id,
          title: sample.title,
          description: sample.description,
          cells: sample.cells as unknown as Json,
        })
        .select("id")
        .single();
      if (error || !data) return toast.error(error?.message ?? "Failed to fork notebook");
      toast.success("Forked — this copy is yours to edit");
      void navigate({ to: "/notebooks/py/$pyNotebookId", params: { pyNotebookId: data.id } });
    } finally {
      setForking(false);
    }
  };

  if (!sample) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        Sample not found.{" "}
        <Link to="/notebooks" className="text-primary underline">
          Back to the Developer workspace
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl p-4 lg:p-6">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Sparkles className="h-5 w-5 shrink-0 text-primary" />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{sample.title}</h1>
        <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
          <Lock className="h-3 w-3" /> Sample · read-only
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {sample.framework}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={runAll}
            disabled={runningAll}
          >
            {runningAll ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ChevronsRight className="h-3.5 w-3.5" />
            )}
            Run all
          </Button>
          <Button size="sm" className="gap-1.5" onClick={fork} disabled={forking || !user}>
            {forking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitFork className="h-3.5 w-3.5" />
            )}
            Fork to my notebooks
          </Button>
        </div>
      </div>
      <p className="mb-5 text-xs text-muted-foreground">
        {sample.description} You can run cells here (Pyodide loads on first run), but edits aren't
        saved — <strong>Fork</strong> to get an editable copy in your account.
      </p>

      {/* Cells */}
      <div className="space-y-4">
        {sample.cells.map((cell, idx) => {
          const output = outputs[cell.id];
          if (cell.type === "markdown") {
            return (
              <div
                key={cell.id}
                className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-transparent px-1"
              >
                <MarkdownMessage content={cell.source} />
              </div>
            );
          }
          return (
            <div key={cell.id} className="group rounded-lg border border-border bg-card/50">
              <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1">
                <Badge variant="secondary" className="text-[10px] uppercase">
                  Python
                </Badge>
                <span className="text-[10px] text-muted-foreground">#{idx + 1}</span>
              </div>
              <div className="flex items-start gap-1 px-2 py-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 h-7 w-7 shrink-0 p-0 text-primary"
                  title="Run cell"
                  disabled={output === "running"}
                  onClick={() => void runCell(cell)}
                >
                  {output === "running" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>
                <div className="min-w-0 flex-1">
                  <CodeMirror
                    value={cell.source}
                    editable={false}
                    extensions={[python(), editorTheme, EditorView.lineWrapping]}
                    theme={isDark ? vscodeDark : vscodeLight}
                    basicSetup={{ lineNumbers: true, foldGutter: false }}
                  />
                </div>
              </div>
              {output && output !== "running" ? (
                <div className="border-t border-border/60 px-4 py-2.5 text-xs">
                  {output.stdout ? (
                    <pre className="whitespace-pre-wrap font-mono text-foreground/90">
                      {output.stdout}
                    </pre>
                  ) : null}
                  {output.result ? (
                    <pre className="whitespace-pre-wrap font-mono text-primary">{output.result}</pre>
                  ) : null}
                  {output.error ? (
                    <pre className="whitespace-pre-wrap font-mono text-destructive">
                      {output.error}
                    </pre>
                  ) : null}
                  {!output.stdout && !output.result && !output.error ? (
                    <span className="text-muted-foreground">No output.</span>
                  ) : null}
                  <div className="mt-1 text-[10px] text-muted-foreground">{output.durationMs} ms</div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex items-center justify-center gap-3 border-t border-border/40 pt-6">
        <p className="text-xs text-muted-foreground">Want to change it and keep your edits?</p>
        <Button size="sm" className="gap-1.5" onClick={fork} disabled={forking || !user}>
          {forking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitFork className="h-3.5 w-3.5" />
          )}
          Fork to my notebooks
        </Button>
      </div>
    </div>
  );
}
