import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NOTEBOOKS } from "@/lib/notebooks/catalog";
import type { NotebookSummary } from "@/lib/notebooks/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Notebook as NotebookIcon,
  ChevronRight,
  BookOpen,
  Bot,
  Sparkles,
  Network,
  ShieldCheck,
  Database,
  Gauge,
  Cpu,
  Zap,
  AlertTriangle,
  FlaskConical,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useAuth } from "@/hooks/use-auth";
import { newPythonNotebookCells } from "@/lib/pythonNotebookTemplate";

export const Route = createFileRoute("/_authenticated/notebooks")({
  head: () => ({
    meta: [
      { title: "Notebooks — AgentSwarms" },
      {
        name: "description",
        content:
          "Interactive TypeScript notebooks for learning agentic AI — run cells, edit code, see real LLM and tool outputs.",
      },
    ],
  }),
  component: NotebooksLayout,
});

type Group = {
  id: string;
  label: string;
  icon: typeof BookOpen;
  match: (nb: NotebookSummary) => boolean;
};

const GROUPS: Group[] = [
  {
    id: "foundations",
    label: "Foundations Lab",
    icon: Sparkles,
    match: (nb) => nb.id.startsWith("fnd-"),
  },
  {
    id: "evals",
    label: "Agentic Evals",
    icon: Gauge,
    match: (nb) => nb.id.startsWith("eval-"),
  },
  {
    id: "langchain",
    label: "LangChain Course",
    icon: BookOpen,
    match: (nb) => nb.id.startsWith("lc-"),
  },
  {
    id: "llamaindex",
    label: "LlamaIndex.ts Track",
    icon: Database,
    match: (nb) => nb.id.startsWith("li-"),
  },
  {
    id: "google-adk",
    label: "Google ADK (Agent Development Kit)",
    icon: Bot,
    match: (nb) => nb.id.startsWith("adk-"),
  },
  {
    id: "openai-agents",
    label: "OpenAI Agents SDK",
    icon: Cpu,
    match: (nb) => nb.id.startsWith("oai-"),
  },
  {
    id: "vercel-ai",
    label: "Vercel AI SDK",
    icon: Zap,
    match: (nb) => nb.id.startsWith("vai-"),
  },
  {
    id: "mastra",
    label: "Mastra Framework",
    icon: Sparkles,
    match: (nb) => nb.id.startsWith("mst-"),
  },
  {
    id: "voltagent",
    label: "VoltAgent Framework",
    icon: Zap,
    match: (nb) => nb.id.startsWith("volt-"),
  },
  {
    id: "standalone",
    label: "Standalone Agents",
    icon: Bot,
    match: (nb) => nb.id.startsWith("sa-"),
  },
  {
    id: "multi-agent",
    label: "Multi-Agent Systems (LangGraph.js)",
    icon: Network,
    match: (nb) => nb.id.startsWith("mas-"),
  },
  {
    id: "enterprise",
    label: "Enterprise Ops & Safety",
    icon: ShieldCheck,
    match: (nb) => nb.id.startsWith("ent-"),
  },
  {
    id: "examples",
    label: "Real-world Examples",
    icon: Sparkles,
    match: (nb) =>
      !nb.id.startsWith("fnd-") &&
      !nb.id.startsWith("fail-") &&
      !nb.id.startsWith("eval-") &&
      !nb.id.startsWith("lc-") &&
      !nb.id.startsWith("li-") &&
      !nb.id.startsWith("oai-") &&
      !nb.id.startsWith("vai-") &&
      !nb.id.startsWith("sa-") &&
      !nb.id.startsWith("mas-") &&
      !nb.id.startsWith("ent-") &&
      !nb.id.startsWith("adk-") &&
      !nb.id.startsWith("mst-") &&
      !nb.id.startsWith("volt-"),
  },
  {
    id: "failure-modes",
    label: "⚠️ Failure Modes (Must Read)",
    icon: AlertTriangle,
    match: (nb) => nb.id.startsWith("fail-"),
  },
];

type SubgroupedItems = { subgroup: string | null; items: NotebookSummary[] }[];

function subgroupItems(items: NotebookSummary[]): SubgroupedItems {
  const order: string[] = [];
  const map = new Map<string, NotebookSummary[]>();
  for (const nb of items) {
    const key = nb.subgroup ?? "__none__";
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(nb);
  }
  return order.map((k) => ({ subgroup: k === "__none__" ? null : k, items: map.get(k)! }));
}

function groupedNotebooks() {
  return GROUPS.map((g) => ({ ...g, items: NOTEBOOKS.filter(g.match) })).filter(
    (g) => g.items.length > 0,
  );
}

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
  const hasNotebookSelected = pathname.startsWith("/notebooks/") && pathname !== "/notebooks/";
  const groups = groupedNotebooks();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, false])),
  );
  const { pyNotebooks, createNotebook, deleteNotebook, creating } = usePyNotebooks(pathname);

  return (
    <div className="flex h-[calc(100vh-3rem)] w-full min-w-0">
      <aside className="w-72 min-w-[16rem] max-w-[20rem] shrink-0 border-r border-border bg-card/30 flex flex-col">
        <div className="px-3 py-3 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <NotebookIcon className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold tracking-tight">Notebooks</h2>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              {NOTEBOOKS.length}
            </Badge>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 space-y-1">
          {/* User-authored Python notebooks */}
          <div className="pb-1">
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <FlaskConical className="h-3.5 w-3.5 text-primary" />
              <span className="flex-1 text-left">My Python Lab</span>
              <button
                type="button"
                onClick={() => void createNotebook()}
                disabled={creating}
                title="New Python notebook"
                className="rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {pyNotebooks.length > 0 && (
              <ul className="ml-2 border-l border-border/60 pl-1">
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
            )}
          </div>
          {groups.map((group) => {
            const Icon = group.icon;
            const open = openGroups[group.id] ?? false;
            return (
              <div key={group.id}>
                <button
                  type="button"
                  onClick={() => setOpenGroups((s) => ({ ...s, [group.id]: !open }))}
                  className={cn(
                    "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wide hover:bg-muted/50",
                    group.id === "failure-modes"
                      ? "text-amber-500 hover:text-amber-400"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
                  />
                  <Icon className="h-3.5 w-3.5" />
                  <span className="flex-1 text-left">{group.label}</span>
                  <span className="text-[10px] font-normal text-muted-foreground/70">
                    {group.items.length}
                  </span>
                </button>
                {open && (
                  <div className="mt-0.5 ml-2 border-l border-border/60 pl-1 space-y-1">
                    {subgroupItems(group.items).map((sg, sgIdx) => {
                      let counter = subgroupItems(group.items)
                        .slice(0, sgIdx)
                        .reduce((acc, s) => acc + s.items.length, 0);
                      return (
                        <div key={sg.subgroup ?? "_"}>
                          {sg.subgroup && (
                            <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                              {sg.subgroup}
                            </div>
                          )}
                          <ul>
                            {sg.items.map((nb) => {
                              const idx = counter++;
                              const href = `/notebooks/${nb.id}`;
                              const active = pathname === href;
                              return (
                                <li key={nb.id}>
                                  <Link
                                    to="/notebooks/$notebookId"
                                    params={{ notebookId: nb.id }}
                                    className={cn(
                                      "block rounded-md px-2 py-1.5 text-[13px] leading-snug transition-colors",
                                      active
                                        ? "bg-primary/10 text-foreground font-medium"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                    )}
                                    title={nb.description}
                                  >
                                    <span className="line-clamp-2">
                                      <span className="text-muted-foreground/70 tabular-nums">
                                        {idx + 1}.
                                      </span>{" "}
                                      {nb.title}
                                    </span>
                                  </Link>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>
      <main data-notebooks-main className="flex-1 min-w-0 overflow-y-auto">
        {hasNotebookSelected ? (
          <Outlet />
        ) : (
          <NotebookCatalog
            pyNotebooks={pyNotebooks}
            onCreatePy={() => void createNotebook()}
            onDeletePy={(id) => void deleteNotebook(id)}
            creatingPy={creating}
          />
        )}
      </main>
    </div>
  );
}

function NotebookCatalog({
  pyNotebooks,
  onCreatePy,
  onDeletePy,
  creatingPy,
}: {
  pyNotebooks: PyNotebookSummary[];
  onCreatePy: () => void;
  onDeletePy: (id: string) => void;
  creatingPy: boolean;
}) {
  const groups = groupedNotebooks();
  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto w-full max-w-none">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <NotebookIcon className="mt-1 h-7 w-7 shrink-0 text-primary" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">All notebooks</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Choose any notebook below. Every example is runnable — edit the code, re-run cells,
                see real outputs.
              </p>
            </div>
          </div>
          <Badge variant="secondary" className="shrink-0">
            {NOTEBOOKS.length} available
          </Badge>
        </div>

        {/* My Python Lab — user-authored, in-browser Python notebooks */}
        <section className="mb-8">
          <div className="mb-3 flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
              My Python Lab
            </h2>
            <span className="text-xs text-muted-foreground">· {pyNotebooks.length}</span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto gap-1.5"
              onClick={onCreatePy}
              disabled={creatingPy}
            >
              <Plus className="h-3.5 w-3.5" /> New Python notebook
            </Button>
          </div>
          <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
            Your own Python notebooks — experiment with code and frameworks right in the browser.
            Each one starts with notes on calling models through your connected providers and a
            runnable sample.
          </p>
          {pyNotebooks.length === 0 ? (
            <button
              type="button"
              onClick={onCreatePy}
              disabled={creatingPy}
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
                    onClick={() => onDeletePy(nb.id)}
                    className="absolute bottom-3 right-3 rounded p-1 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="space-y-8">
          {groups.map((group) => {
            const Icon = group.icon;
            return (
              <section key={group.id}>
                <div className="mb-3 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
                    {group.label}
                  </h2>
                  <span className="text-xs text-muted-foreground">· {group.items.length}</span>
                </div>
                {subgroupItems(group.items).map((sg, sgIdx) => {
                  let counter = subgroupItems(group.items)
                    .slice(0, sgIdx)
                    .reduce((acc, s) => acc + s.items.length, 0);
                  return (
                    <div key={sg.subgroup ?? "_"} className="mb-4">
                      {sg.subgroup && (
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">
                          {sg.subgroup}
                        </h3>
                      )}
                      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                        {sg.items.map((notebook) => {
                          const index = counter++;
                          return (
                            <Link
                              key={notebook.id}
                              to="/notebooks/$notebookId"
                              params={{ notebookId: notebook.id }}
                              className="block rounded-md border border-border bg-card/50 p-4 transition hover:border-primary/60 hover:bg-card"
                            >
                              <div className="mb-3 flex items-start justify-between gap-3">
                                <h4 className="min-w-0 text-base font-semibold leading-snug break-words">
                                  {index + 1} · {notebook.title}
                                </h4>
                                <Badge variant="secondary" className="shrink-0 text-[10px]">
                                  {notebook.difficulty}
                                </Badge>
                              </div>
                              <p className="text-sm leading-relaxed text-muted-foreground">
                                {notebook.description}
                              </p>
                              <div className="mt-4 flex flex-wrap gap-1.5">
                                {notebook.tags.map((tag) => (
                                  <Badge key={tag} variant="outline" className="text-[10px]">
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
