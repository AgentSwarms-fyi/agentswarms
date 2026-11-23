import { PageHeader, TitleCount } from "@/components/PageHeader";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { getRealTemplate, TEMPLATE_ID_COLUMN, templateAgentName } from "@/lib/realTemplates";
import { reportFailure } from "@/lib/silentFailureNet";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { IdentityTile } from "@/components/IdentityTile";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePageIntent } from "@/hooks/use-page-intent";
import { readPageIntent } from "@/lib/pageIntent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { moveToTrash } from "@/hooks/use-trash";
import { RESTORE_HINT } from "@/lib/trash";
import {
  AlertTriangle,
  Bot,
  Plus,
  Pencil,
  Trash2,
  Play,
  Shield,
  Download,
  Share2,
  Upload,
  MoreHorizontal,
  History,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { listState } from "@/lib/listState";
import { AgentForm, type Agent } from "@/components/agents/AgentForm";
import { useLangChainExportAnnouncement } from "@/hooks/use-langchain-export-announcement";
import { ExportAgentDialog } from "@/components/agents/ExportAgentDialog";
import { ShareAgentDialog } from "@/components/agents/ShareAgentDialog";
import { ImportAgentDialog } from "@/components/agents/ImportAgentDialog";
import { AgentVersionsDialog } from "@/components/agents/AgentVersionsDialog";
import { agentIsGuarded } from "@/lib/agentGuarded";
import { StarButton } from "@/components/StarButton";
import { FavouritesFilter } from "@/components/FavouritesFilter";
import { useFavouritesFilter } from "@/hooks/use-favourites-filter";
import { useRecordOpened } from "@/hooks/use-object-marks";

export const Route = createFileRoute("/_authenticated/agents")({
  component: AgentsPage,
  head: () => ({ meta: [{ title: "Agent Builder — AgentSwarms" }] }),
  // `?new=1` starts a new agent and `?open=<id>` opens one — how search
  // results and the "New" menu link here (src/lib/pageIntent.ts).
  validateSearch: (s: Record<string, unknown>) => readPageIntent(s),
});

const PROVIDERS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "grok", label: "Grok (xAI)" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "oci_genai", label: "OCI Generative AI" },
  { value: "claude_aws", label: "Claude Platform on AWS" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Google Vertex AI" },
  { value: "anthropic", label: "Anthropic (direct)" },
  { value: "azure_openai", label: "Azure OpenAI" },
];

function AgentsPage() {
  const { user, session } = useAuth();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  // "No agents yet" and "not fetched yet" are different facts and this page
  // had no way to tell them apart, so the first paint always showed the empty
  // state — a "Create your first agent" call to action, on an account with
  // seven agents. The obvious response to that screen is to make another one.
  const [loaded, setLoaded] = useState(false);
  /** Why the last load failed. An error is never "No agents yet". */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [exportFor, setExportFor] = useState<Agent | null>(null);
  const [shareFor, setShareFor] = useState<Agent | null>(null);
  // Deleting an agent cascades to its conversations, memory and embed keys, so
  // it goes through an explicit confirmation rather than a one-click menu item.
  const [versionsFor, setVersionsFor] = useState<Agent | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadAgents();
  }, []);
  useLangChainExportAnnouncement();
  useRecordOpened("agent", dialogOpen ? (editing?.id ?? null) : null);
  const favourites = useFavouritesFilter(
    "agent",
    agents.map((a) => a.id),
  );

  /**
   * An agent template from the gallery (R530). It makes rows (the agent, a
   * knowledge base, an example approval), so it asks first, and a template
   * already used opens the agent made from it instead of making another.
   */
  const startFromTemplate = async (templateId: string) => {
    const t = getRealTemplate(templateId);
    if (!t || !user?.id) return;
    const { data: mine, error } = await supabase
      .from("agents")
      .select("id, name")
      .eq("user_id", user.id)
      .eq(TEMPLATE_ID_COLUMN as "id", t.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return reportFailure("look for an agent made from this template", error);
    if (mine) {
      const open = await confirmAsk({
        title: `You already have “${mine.name}”`,
        body: "It was made from this template before. Open it to chat with, as you left it.",
        actionLabel: "Open it",
      });
      if (open) void navigate({ to: "/playground", search: { agentId: mine.id } as never });
      return;
    }
    const docs = t.seedDocuments.length;
    const ok = await confirmAsk({
      title: `Make “${templateAgentName(t)}”?`,
      body: [
        docs
          ? `This makes the agent in your workspace, with a knowledge base of its ${docs} document${docs === 1 ? "" : "s"}.`
          : "This makes the agent in your workspace.",
        t.approvalSeed
          ? "One example request also waits in your approvals inbox, to approve or refuse; deciding it changes nothing outside the app."
          : "",
        `It answers with ${t.modelId}, which you can change afterwards.`,
      ]
        .filter(Boolean)
        .join(" "),
      actionLabel: "Make the agent",
    });
    if (!ok) return;
    const toastId = `agent-template-${t.id}`;
    toast.loading(`Making “${templateAgentName(t)}”…`, { id: toastId });
    try {
      const res = await fetch("/api/templates/provision", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ templateId: t.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { agentId?: string; error?: string };
      if (!res.ok || !body.agentId) throw new Error(body.error || `HTTP ${res.status}`);
      toast.success(`Made “${templateAgentName(t)}”`, { id: toastId });
      void navigate({ to: "/playground", search: { agentId: body.agentId } as never });
    } catch (e) {
      reportFailure("make the agent", e, { id: toastId });
    }
  };

  // A link here can ask for a new agent or for one agent to be opened.
  usePageIntent(search, {
    // A list that failed to load is not a list the agent is missing from: the
    // request waits, and is answered once a retry succeeds.
    ready: loaded && !loadError,
    noun: "agent",
    onNew: (from) => {
      if (from) {
        if (!getRealTemplate(from)) return false;
        void startFromTemplate(from);
        return;
      }
      setEditing(null);
      setDialogOpen(true);
    },
    onOpen: (id) => {
      const agent = agents.find((a) => a.id === id);
      if (!agent) return false;
      setEditing(agent);
      setDialogOpen(true);
    },
  });

  async function loadAgents() {
    const { data, error } = await supabase
      .from("agents")
      .select("*")
      .order("created_at", { ascending: false });
    // FOUND FROM THE UI. This dropped `error`, so a read that failed left the
    // list empty and the page said "No agents yet" with a "New Agent" call to
    // action — over the agents it could not read.
    setLoadError(error ? error.message : null);
    if (data) setAgents(data as Agent[]);
    setLoaded(true);
  }

  async function deleteAgent(agent: Agent) {
    setDeleting(true);
    try {
      // Surface failures instead of reporting a false success: a refusal comes
      // back as a result, not a throw, and moveToTrash says it itself.
      const r = await moveToTrash({
        kind: "agent",
        id: agent.id,
        name: agent.name,
        onRestored: () => void loadAgents(),
      });
      if (!r.ok) return;
      setConfirmDelete(null);
      await loadAgents();
    } finally {
      setDeleting(false);
    }
  }

  // What the search box and the Favourites chip leave to draw.
  const needle = query.trim().toLowerCase();
  const shownAgents = agents.filter(
    (a) =>
      favourites.keep(a.id) &&
      (!needle ||
        a.name.toLowerCase().includes(needle) ||
        (a.description ?? "").toLowerCase().includes(needle) ||
        a.llm_model.toLowerCase().includes(needle) ||
        a.llm_provider.toLowerCase().includes(needle)),
  );

  // "Guarded" when the enforcer would act on its guardrails (agentGuarded.ts).
  function hasGuardrails(agent: Agent): boolean {
    return agentIsGuarded(agent.tools);
  }

  return (
    <div className="flex">
      <div className="min-w-0 flex-1 space-y-6 p-6">
        <PageHeader
          title="Agent Builder"
          description="Create and manage the agents you chat with and use in swarms."
          meta={
            agents.length > 0 ? (
              <TitleCount>
                {agents.length} {agents.length === 1 ? "agent" : "agents"}
              </TitleCount>
            ) : null
          }
          actions={
            <>
              <ImportAgentDialog
                userId={user?.id || ""}
                onImported={loadAgents}
                trigger={
                  <Button variant="outline">
                    <Upload className="h-4 w-4 mr-2" /> Import agent
                  </Button>
                }
              />
              <Dialog
                open={dialogOpen}
                onOpenChange={(o) => {
                  setDialogOpen(o);
                  if (!o) setEditing(null);
                }}
              >
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="h-4 w-4 mr-2" /> New agent
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>{editing ? "Edit agent" : "Create agent"}</DialogTitle>
                  </DialogHeader>
                  <AgentForm
                    // One form per agent: it loads that agent's memory settings on mount (R323).
                    key={editing?.id ?? "new"}
                    agent={editing}
                    userId={user?.id || ""}
                    onSaved={() => {
                      setDialogOpen(false);
                      setEditing(null);
                      loadAgents();
                    }}
                  />
                </DialogContent>
              </Dialog>
            </>
          }
        />

        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 max-w-sm flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents by name, description, or model…"
                className="h-9 pl-8"
              />
            </div>
            <FavouritesFilter filter={favourites} />
          </div>
        )}

        {!loaded ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : listState({ loaded, error: loadError, count: agents.length }) === "error" ? (
          <EmptyState
            icon={AlertTriangle}
            title="Could not load your agents"
            description={loadError ?? ""}
            action={
              <Button variant="outline" onClick={() => void loadAgents()}>
                Try again
              </Button>
            }
          />
        ) : agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first agent to get started — pick a model, write a system prompt, and add tools as you go."
            action={
              <Button
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4 mr-2" /> New agent
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {/* An empty grid said nothing: a search that matched no agent looked
                like a page still loading. */}
            {shownAgents.length === 0 && (
              <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
                {favourites.on
                  ? `None of your favourites matches “${query.trim()}”.`
                  : `No agents match “${query.trim()}”.`}
              </p>
            )}
            {shownAgents.map((agent) => (
              <Card key={agent.id} className="glow-card group flex flex-col border-border/50">
                <CardHeader className="p-4 pb-2.5">
                  <div className="flex items-start gap-2.5">
                    <IdentityTile name={agent.name} icon={Bot} />
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate text-base leading-tight">
                        {agent.name}
                      </CardTitle>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${agent.is_active ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                          />
                          {agent.is_active ? "Active" : "Inactive"}
                        </span>
                        {hasGuardrails(agent) && (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <Shield className="h-3 w-3" /> Guarded
                          </span>
                        )}
                      </div>
                    </div>
                    <StarButton
                      kind="agent"
                      id={agent.id}
                      name={agent.name}
                      className="-mr-1.5 -mt-1"
                    />
                  </div>
                  {agent.description && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                      {agent.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="mt-auto p-4 pt-0">
                  <div className="mb-2.5 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5">
                      {PROVIDERS.find((p) => p.value === agent.llm_provider)?.label ??
                        agent.llm_provider}
                    </span>
                    <span className="truncate rounded-md bg-muted px-1.5 py-0.5">
                      {agent.llm_model}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 border-t border-border/60 pt-2.5">
                    <Button size="sm" variant="outline" className="h-7 gap-1 px-3 text-xs" asChild>
                      <Link to="/playground" search={{ agentId: agent.id }}>
                        <Play className="h-3 w-3" /> Chat
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(agent);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-3 w-3 mr-1" /> Edit
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          aria-label="More actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => setExportFor(agent)}>
                          <Download className="h-3.5 w-3.5 mr-2" /> Export code
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setShareFor(agent)}>
                          <Share2 className="h-3.5 w-3.5 mr-2" /> Share
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setVersionsFor(agent)}>
                          <History className="h-3.5 w-3.5 mr-2" /> Version history
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => setConfirmDelete(agent)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {exportFor && (
          <ExportAgentDialog
            agent={exportFor}
            open
            onOpenChange={(o) => {
              if (!o) setExportFor(null);
            }}
          />
        )}
        {shareFor && (
          <ShareAgentDialog
            agent={shareFor}
            open
            onOpenChange={(o) => {
              if (!o) setShareFor(null);
            }}
          />
        )}

        {versionsFor && user && (
          <AgentVersionsDialog
            agentId={versionsFor.id}
            agentName={versionsFor.name}
            userId={user.id}
            open
            onOpenChange={(o) => {
              if (!o) setVersionsFor(null);
            }}
            onRestored={() => void loadAgents()}
          />
        )}

        <AlertDialog
          open={!!confirmDelete}
          onOpenChange={(o) => !o && !deleting && setConfirmDelete(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Move “{confirmDelete?.name}” to the trash?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>Sites embedding this agent and API calls that reference it stop working.</p>
                  <p>{RESTORE_HINT}</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleting}
                onClick={(e) => {
                  e.preventDefault(); // keep the dialog open while the delete runs
                  if (confirmDelete) void deleteAgent(confirmDelete);
                }}
              >
                {deleting ? "Moving…" : "Move to trash"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
