import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
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
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { AgentForm, type Agent } from "@/components/agents/AgentForm";
import { useLangChainExportAnnouncement } from "@/hooks/use-langchain-export-announcement";
import { ExportAgentDialog } from "@/components/agents/ExportAgentDialog";
import { ShareAgentDialog } from "@/components/agents/ShareAgentDialog";
import { ImportAgentDialog } from "@/components/agents/ImportAgentDialog";
import { LearnPanel } from "@/components/LearnPanel";
import { learnAgents } from "@/lib/learnContent";

export const Route = createFileRoute("/_authenticated/agents")({
  component: AgentsPage,
  validateSearch: (s: Record<string, unknown>) => {
    const out: { new?: 1 } = {};
    if (s.new === 1 || s.new === "1") out.new = 1;
    return out;
  },
});

const PROVIDERS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "grok", label: "Grok (xAI)" },
  { value: "ollama", label: "Custom Ollama" },
  { value: "oci_genai", label: "OCI Generative AI" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Google Vertex AI" },
  { value: "anthropic", label: "Anthropic (direct)" },
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "oci_genai", label: "OCI Generative AI" },
];

function AgentsPage() {
  const { user } = useAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [exportFor, setExportFor] = useState<Agent | null>(null);
  const [shareFor, setShareFor] = useState<Agent | null>(null);

  useEffect(() => {
    loadAgents();
  }, []);
  useLangChainExportAnnouncement();

  // Open the New Agent dialog when navigated to with ?new=1 (Global "+" menu).
  useEffect(() => {
    if (search.new === 1) {
      setEditing(null);
      setDialogOpen(true);
      navigate({ search: {}, replace: true });
    }
  }, [search.new, navigate]);

  async function loadAgents() {
    const { data } = await supabase
      .from("agents")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setAgents(data as Agent[]);
  }

  async function deleteAgent(id: string) {
    await supabase.from("agents").delete().eq("id", id);
    toast.success("Agent deleted");
    loadAgents();
  }

  function hasGuardrails(agent: Agent): boolean {
    const tools = agent.tools as any;
    if (!tools?.guardrails) return false;
    const g = tools.guardrails;
    return (
      g.enableInputFilters || g.enableOutputFilters || g.blockPII || g.contentSafetyLevel !== "off"
    );
  }

  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Agent Builder</h1>
            <p className="text-muted-foreground mt-1">Create and manage your AI agents.</p>
          </div>
          <div className="flex gap-2">
            <ImportAgentDialog
              userId={user?.id || ""}
              onImported={loadAgents}
              trigger={
                <Button variant="outline">
                  <Upload className="h-4 w-4 mr-2" /> Import Agent
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
                  <Plus className="h-4 w-4 mr-2" /> New Agent
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{editing ? "Edit Agent" : "Create Agent"}</DialogTitle>
                </DialogHeader>
                <AgentForm
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
          </div>
        </div>

        {agents.length === 0 ? (
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
                <Plus className="h-4 w-4 mr-2" /> New Agent
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <Card key={agent.id} className="glow-card border-border/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{agent.name}</CardTitle>
                    <div className="flex items-center gap-1">
                      {hasGuardrails(agent) && (
                        <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                          <Shield className="h-3 w-3 mr-1" /> Guarded
                        </Badge>
                      )}
                      <Badge variant={agent.is_active ? "default" : "secondary"}>
                        {agent.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                  </div>
                  {agent.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {agent.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {PROVIDERS.find((p) => p.value === agent.llm_provider)?.label ??
                        agent.llm_provider}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {agent.llm_model}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/playground" search={{ agentId: agent.id }}>
                        <Play className="h-3 w-3 mr-1" /> Chat
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
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => deleteAgent(agent.id)}
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
      </div>
      <LearnPanel
        topic="Building your first agent"
        tagline="Prompt + model + (optional) tools & memory. That's the whole stack."
        section={learnAgents}
      />
    </div>
  );
}
