// /notebooks — the Python Lab: user-authored Python notebooks that run
// entirely in the browser (Pyodide). Each notebook starts from a template
// with notes on calling models through the user's connected providers.
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FlaskConical, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useAuth } from "@/hooks/use-auth";
import { newPythonNotebookCells } from "@/lib/pythonNotebookTemplate";

export const Route = createFileRoute("/_authenticated/notebooks")({
  head: () => ({
    meta: [
      { title: "Python Notebooks — AgentSwarms" },
      {
        name: "description",
        content:
          "Your own Python notebooks, running in the browser — experiment with code and frameworks, and call your connected models straight from Python.",
      },
    ],
  }),
  component: NotebooksLayout,
});

type PyNotebookSummary = { id: string; title: string; updated_at: string };

/** Load + mutate the current user's Python notebooks (RLS-scoped). */
function usePyNotebooks(pathname: string) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [pyNotebooks, setPyNotebooks] = useState<PyNotebookSummary[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("user_python_notebooks")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false })
      .then(({ data }) => setPyNotebooks(data ?? []));
    // Re-fetch on navigation so renames/creations from the editor show up.
  }, [user, pathname]);

  const createNotebook = async () => {
    if (!user || creating) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from("user_python_notebooks")
        .insert({
          user_id: user.id,
          title: "My Python notebook",
          cells: newPythonNotebookCells() as unknown as Json,
        })
        .select("id")
        .single();
      if (error || !data) return toast.error(error?.message ?? "Failed to create notebook");
      void navigate({ to: "/notebooks/py/$pyNotebookId", params: { pyNotebookId: data.id } });
    } finally {
      setCreating(false);
    }
  };

  const deleteNotebook = async (id: string) => {
    if (!window.confirm("Delete this notebook? This cannot be undone.")) return;
    const { error } = await supabase.from("user_python_notebooks").delete().eq("id", id);
    if (error) return toast.error(error.message);
    setPyNotebooks((prev) => prev.filter((n) => n.id !== id));
  };

  return { pyNotebooks, createNotebook, deleteNotebook, creating };
}

function NotebooksLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hasNotebookSelected = pathname.startsWith("/notebooks/py/");
  const { pyNotebooks, createNotebook, deleteNotebook, creating } = usePyNotebooks(pathname);

  return (
    <div className="flex h-[calc(100vh-3rem)] w-full min-w-0">
      <aside className="w-72 min-w-[16rem] max-w-[20rem] shrink-0 border-r border-border bg-card/30 flex flex-col">
        <div className="px-3 py-3 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold tracking-tight">Python Lab</h2>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              {pyNotebooks.length}
            </Badge>
          </div>
        </div>
        <div className="p-2">
          <Button
            size="sm"
            className="w-full gap-1.5"
            onClick={() => void createNotebook()}
            disabled={creating}
          >
            <Plus className="h-3.5 w-3.5" /> New notebook
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          <ul className="space-y-0.5">
            {pyNotebooks.map((nb) => {
              const active = pathname === `/notebooks/py/${nb.id}`;
              return (
                <li key={nb.id}>
                  <Link
                    to="/notebooks/py/$pyNotebookId"
                    params={{ pyNotebookId: nb.id }}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-[13px] leading-snug transition-colors",
                      active
                        ? "bg-primary/10 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span className="line-clamp-1">{nb.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {pyNotebooks.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No notebooks yet — create one to start experimenting.
            </p>
          )}
        </nav>
      </aside>
      <main data-notebooks-main className="flex-1 min-w-0 overflow-y-auto">
        {hasNotebookSelected ? (
          <Outlet />
        ) : (
          <PythonLabCatalog
            pyNotebooks={pyNotebooks}
            onCreate={() => void createNotebook()}
            onDelete={(id) => void deleteNotebook(id)}
            creating={creating}
          />
        )}
      </main>
    </div>
  );
}

function PythonLabCatalog({
  pyNotebooks,
  onCreate,
  onDelete,
  creating,
}: {
  pyNotebooks: PyNotebookSummary[];
  onCreate: () => void;
  onDelete: (id: string) => void;
  creating: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <FlaskConical className="mt-1 h-7 w-7 shrink-0 text-primary" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Python Lab</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Your own Python notebooks, running entirely in the browser — no install, no kernel
                to manage. Experiment with code and frameworks, and call your connected models
                straight from Python.
              </p>
            </div>
          </div>
          <Button className="shrink-0 gap-1.5" onClick={onCreate} disabled={creating}>
            <Plus className="h-4 w-4" /> New Python notebook
          </Button>
        </div>

        <div className="mb-8 grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-card/50 p-4">
            <h3 className="text-sm font-semibold">Real CPython, zero setup</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Powered by Pyodide (WebAssembly). Cells share one interpreter, top-level{" "}
              <code>await</code> works, and bundled packages like numpy and pandas load on import.
            </p>
          </div>
          <div className="rounded-md border border-border bg-card/50 p-4">
            <h3 className="text-sm font-semibold">Your models, from Python</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              The built-in <code>agentswarms.chat()</code> helper calls any provider you've
              connected (or the instance default OpenRouter). Calls respect IAM model rules and show
              up in Traces.
            </p>
          </div>
          <div className="rounded-md border border-border bg-card/50 p-4">
            <h3 className="text-sm font-semibold">Guided from the first cell</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Every new notebook opens with notes on model usage and runnable samples — a chat call,
              structured JSON output, and a pure-Python experiment.
            </p>
          </div>
        </div>

        {pyNotebooks.length === 0 ? (
          <button
            type="button"
            onClick={onCreate}
            disabled={creating}
            className="flex w-full max-w-md items-center gap-3 rounded-md border border-dashed border-border p-4 text-left transition hover:border-primary/60 hover:bg-card"
          >
            <Plus className="h-5 w-5 text-primary" />
            <span>
              <span className="block text-sm font-medium">Create your first Python notebook</span>
              <span className="block text-xs text-muted-foreground">
                Pre-loaded with model-usage notes and runnable sample cells.
              </span>
            </span>
          </button>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {pyNotebooks.map((nb) => (
              <div
                key={nb.id}
                className="group relative rounded-md border border-border bg-card/50 transition hover:border-primary/60 hover:bg-card"
              >
                <Link
                  to="/notebooks/py/$pyNotebookId"
                  params={{ pyNotebookId: nb.id }}
                  className="block p-4"
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <h4 className="min-w-0 text-base font-semibold leading-snug break-words">
                      {nb.title}
                    </h4>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      Python
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Updated {new Date(nb.updated_at).toLocaleDateString()}
                  </p>
                </Link>
                <button
                  type="button"
                  title="Delete notebook"
                  onClick={() => onDelete(nb.id)}
                  className="absolute bottom-3 right-3 rounded p-1 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
