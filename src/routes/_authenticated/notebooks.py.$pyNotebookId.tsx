// Editor + runner for user-authored Python notebooks. Cells execute on a real
// server kernel (container): full CPython, pip install, and the actual agentic
// frameworks. The kernel starts lazily on the first run and shares one
// interpreter across cells; model/KB calls go through the injected
// `agentswarms` helper and stay governed by IAM rules and budgets.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView } from "@codemirror/view";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsRight,
  Code2,
  GitBranch,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  Server,
  Trash2,
  Type,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { ServerRuntime, type CellRunResult, type ServerStatus } from "@/lib/serverRuntime";
import { RuntimeRequired } from "@/components/notebooks/RuntimeRequired";
import { PublishNotebookDialog } from "@/components/notebooks/PublishNotebookDialog";
import { NotebookGitDialog } from "@/components/notebooks/NotebookGitDialog";
import type { PyCell } from "@/lib/pythonNotebookTemplate";

export const Route = createFileRoute("/_authenticated/notebooks/py/$pyNotebookId")({
  component: PyNotebookPage,
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

function parseCells(raw: Json): PyCell[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is PyCell =>
      !!c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      typeof (c as { id?: unknown }).id === "string" &&
      ((c as { type?: unknown }).type === "markdown" ||
        (c as { type?: unknown }).type === "code") &&
      typeof (c as { source?: unknown }).source === "string",
  );
}

function PyNotebookPage() {
  const { pyNotebookId } = Route.useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const [title, setTitle] = useState("");
  const [cells, setCells] = useState<PyCell[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [publishOpen, setPublishOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [outputs, setOutputs] = useState<Record<string, CellOutput>>({});
  const [editingMd, setEditingMd] = useState<Record<string, boolean>>({});
  const [runningAll, setRunningAll] = useState(false);
  const loadedRef = useRef(false);

  // The server kernel is the only runtime. It starts lazily on first run.
  const [runtimeEnabled, setRuntimeEnabled] = useState<boolean | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus>("idle");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const serverRef = useRef<ServerRuntime | null>(null);

  useEffect(() => {
    supabase
      .from("notebook_runtime_settings")
      .select("server_runtime_enabled")
      .maybeSingle()
      .then(({ data }) => setRuntimeEnabled(!!data?.server_runtime_enabled));
  }, []);

  // Tear the kernel down when leaving the notebook.
  useEffect(() => {
    return () => {
      void serverRef.current?.stop();
      serverRef.current = null;
    };
  }, [pyNotebookId]);

  /** Start the kernel on demand; reused for every subsequent cell. */
  const ensureKernel = useCallback(async (): Promise<ServerRuntime | null> => {
    if (serverRef.current) return serverRef.current;
    const rt = new ServerRuntime(() => session?.access_token ?? null, pyNotebookId);
    rt.onStatus = (s, msg) => {
      setServerStatus(s);
      if (s === "error" && msg) setRuntimeError(msg);
    };
    serverRef.current = rt;
    setRuntimeError(null);
    try {
      await rt.start();
      return rt;
    } catch (e) {
      serverRef.current = null;
      setRuntimeError(e instanceof Error ? e.message : "Failed to start the kernel");
      return null;
    }
  }, [session?.access_token, pyNotebookId]);

  const stopKernel = useCallback(async () => {
    const rt = serverRef.current;
    serverRef.current = null;
    setServerStatus("idle");
    await rt?.stop();
  }, []);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadedRef.current = false;
    setCells(null);
    setNotFound(false);
    setOutputs({});
    supabase
      .from("user_python_notebooks")
      .select("id, title, cells")
      .eq("id", pyNotebookId)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) {
          setNotFound(true);
          return;
        }
        setTitle(data.title);
        setCells(parseCells(data.cells));
        setSaveState("saved");
        // Let the autosave effect skip the initial hydration.
        setTimeout(() => {
          loadedRef.current = true;
        }, 0);
      });
  }, [pyNotebookId]);

  // ── Autosave (debounced) ──────────────────────────────────────────────────
  useEffect(() => {
    if (!loadedRef.current || cells === null) return;
    setSaveState("dirty");
    const t = setTimeout(() => {
      setSaveState("saving");
      supabase
        .from("user_python_notebooks")
        .update({ title: title.trim() || "Untitled notebook", cells: cells as unknown as Json })
        .eq("id", pyNotebookId)
        .then(({ error }) => {
          if (error) {
            toast.error(`Save failed: ${error.message}`);
            setSaveState("dirty");
          } else {
            setSaveState("saved");
          }
        });
    }, 1200);
    return () => clearTimeout(t);
  }, [cells, title, pyNotebookId]);

  // ── Cell operations ───────────────────────────────────────────────────────
  const updateCell = useCallback((id: string, source: string) => {
    setCells((prev) => prev?.map((c) => (c.id === id ? { ...c, source } : c)) ?? prev);
  }, []);

  const addCell = (type: PyCell["type"], afterId?: string) => {
    const fresh: PyCell = {
      id: crypto.randomUUID(),
      type,
      source: type === "code" ? "" : "## Notes\n",
    };
    setCells((prev) => {
      if (!prev) return prev;
      if (!afterId) return [...prev, fresh];
      const idx = prev.findIndex((c) => c.id === afterId);
      return [...prev.slice(0, idx + 1), fresh, ...prev.slice(idx + 1)];
    });
    if (type === "markdown") setEditingMd((s) => ({ ...s, [fresh.id]: true }));
  };

  const deleteCell = (id: string) =>
    setCells((prev) => (prev && prev.length > 1 ? prev.filter((c) => c.id !== id) : prev));

  const moveCell = (id: string, dir: -1 | 1) =>
    setCells((prev) => {
      if (!prev) return prev;
      const idx = prev.findIndex((c) => c.id === id);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });

  // ── Execution ─────────────────────────────────────────────────────────────
  const runCell = useCallback(
    async (cell: PyCell) => {
      setOutputs((o) => ({ ...o, [cell.id]: "running" }));
      const rt = await ensureKernel();
      const res = rt
        ? await rt.run(cell.source)
        : {
            stdout: "",
            result: null,
            error: runtimeError ?? "The server runtime is unavailable.",
            durationMs: 0,
          };
      setOutputs((o) => ({ ...o, [cell.id]: res }));
      return res;
    },
    [ensureKernel, runtimeError],
  );

  const runAll = async () => {
    if (!cells) return;
    setRunningAll(true);
    try {
      for (const c of cells) {
        if (c.type !== "code") continue;
        const res = await runCell(c);
        if (res.error) break; // stop the cascade on first failure, like Jupyter
      }
    } finally {
      setRunningAll(false);
    }
  };

  const deleteNotebook = async () => {
    if (!window.confirm("Delete this notebook? This cannot be undone.")) return;
    const { error } = await supabase.from("user_python_notebooks").delete().eq("id", pyNotebookId);
    if (error) return toast.error(error.message);
    toast.success("Notebook deleted");
    void navigate({ to: "/notebooks" });
  };

  if (notFound) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        Notebook not found (it may belong to another account).
      </div>
    );
  }

  if (runtimeEnabled === false) {
    return (
      <div className="p-6 lg:p-10">
        <RuntimeRequired />
      </div>
    );
  }

  if (cells === null) {
    return (
      <div className="p-6 space-y-4 max-w-4xl mx-auto">
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl p-4 lg:p-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-9 max-w-md flex-1 text-base font-semibold"
          aria-label="Notebook title"
        />
        <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
          <Server className="h-3 w-3" /> Python · server kernel
        </Badge>
        <span className="text-xs text-muted-foreground">
          {saveState === "saved" ? (
            <span className="inline-flex items-center gap-1">
              <Check className="h-3 w-3 text-emerald-500" /> Saved
            </span>
          ) : saveState === "saving" ? (
            "Saving…"
          ) : (
            "Unsaved changes"
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {serverStatus !== "idle" && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
              {serverStatus === "ready" ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-emerald-500" /> Kernel ready
                  <button
                    type="button"
                    className="ml-1 text-muted-foreground hover:text-destructive"
                    onClick={() => void stopKernel()}
                    title="Stop the kernel"
                  >
                    Stop
                  </button>
                </>
              ) : serverStatus === "starting" ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Starting kernel…
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-muted-foreground" /> Kernel{" "}
                  {serverStatus}
                </>
              )}
            </span>
          )}
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
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setPublishOpen(true)}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Publish
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setGitOpen(true)}>
            <GitBranch className="h-3.5 w-3.5" />
            Version
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={deleteNotebook}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p className="mb-5 text-xs text-muted-foreground">
        Cells run on a sandboxed server kernel — full CPython with <code>pip install</code> and the
        real frameworks (LangChain, LangGraph, LlamaIndex). The kernel starts on your first run and
        keeps state between cells; model and knowledge-base calls stay governed by your IAM rules,
        budgets, and Traces.
      </p>

      {runtimeError ? (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <strong>Kernel error:</strong> {runtimeError}
        </div>
      ) : null}

      {/* Cells */}
      <div className="space-y-4">
        {cells.map((cell, idx) => {
          const output = outputs[cell.id];
          return (
            <div key={cell.id} className="group rounded-lg border border-border bg-card/50">
              {/* Cell toolbar */}
              <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1">
                <Badge variant="secondary" className="text-[10px] uppercase">
                  {cell.type === "code" ? "Python" : "Markdown"}
                </Badge>
                <span className="text-[10px] text-muted-foreground">#{idx + 1}</span>
                <div className="ml-auto flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  {cell.type === "markdown" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      title={editingMd[cell.id] ? "Preview" : "Edit"}
                      onClick={() => setEditingMd((s) => ({ ...s, [cell.id]: !s[cell.id] }))}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    title="Move up"
                    onClick={() => moveCell(cell.id, -1)}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    title="Move down"
                    onClick={() => moveCell(cell.id, 1)}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                    title="Delete cell"
                    onClick={() => deleteCell(cell.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              {/* Cell body */}
              {cell.type === "markdown" ? (
                editingMd[cell.id] ? (
                  <Textarea
                    value={cell.source}
                    onChange={(e) => updateCell(cell.id, e.target.value)}
                    onBlur={() => setEditingMd((s) => ({ ...s, [cell.id]: false }))}
                    rows={Math.min(18, Math.max(4, cell.source.split("\n").length + 1))}
                    className="rounded-none border-0 font-mono text-xs focus-visible:ring-0"
                    autoFocus
                  />
                ) : (
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none cursor-text px-4 py-3"
                    onDoubleClick={() => setEditingMd((s) => ({ ...s, [cell.id]: true }))}
                    title="Double-click to edit"
                  >
                    <MarkdownMessage content={cell.source} />
                  </div>
                )
              ) : (
                <>
                  <div className="flex items-start gap-1 px-2 py-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1 h-7 w-7 shrink-0 p-0 text-primary"
                      title="Run cell (Shift+Enter)"
                      disabled={output === "running"}
                      onClick={() => void runCell(cell)}
                    >
                      {output === "running" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>
                    <div
                      className="min-w-0 flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && e.shiftKey) {
                          e.preventDefault();
                          void runCell(cell);
                        }
                      }}
                    >
                      <CodeMirror
                        value={cell.source}
                        onChange={(v) => updateCell(cell.id, v)}
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
                        <pre className="whitespace-pre-wrap font-mono text-primary">
                          {output.result}
                        </pre>
                      ) : null}
                      {output.error ? (
                        <pre className="whitespace-pre-wrap font-mono text-destructive">
                          {output.error}
                        </pre>
                      ) : null}
                      {!output.stdout && !output.result && !output.error ? (
                        <span className="text-muted-foreground">No output.</span>
                      ) : null}
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {output.durationMs} ms
                      </div>
                    </div>
                  ) : null}
                </>
              )}

              {/* Add-below strip */}
              <div className="flex justify-center gap-2 border-t border-border/40 py-1 opacity-0 transition group-hover:opacity-100">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => addCell("code", cell.id)}
                >
                  <Plus className="h-3 w-3" /> Code
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => addCell("markdown", cell.id)}
                >
                  <Type className="h-3 w-3" /> Markdown
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex justify-center gap-3">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => addCell("code")}>
          <Plus className="h-3.5 w-3.5" /> Code cell
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => addCell("markdown")}>
          <Type className="h-3.5 w-3.5" /> Markdown cell
        </Button>
      </div>

      <PublishNotebookDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        notebookId={pyNotebookId}
        token={session?.access_token ?? ""}
      />
      <NotebookGitDialog
        open={gitOpen}
        onOpenChange={setGitOpen}
        notebookId={pyNotebookId}
        token={session?.access_token ?? ""}
        // A restore rewrites the stored cells; the editor is holding the old
        // ones, and autosave would push them straight back over the restore.
        onRestored={() => window.location.reload()}
      />
    </div>
  );
}
