// Side panel for editing the currently-selected swarm node.
// Renders different controls based on node.kind.
import { useEffect, useState } from "react";
import type { Node } from "@xyflow/react";
import type { SwarmNodeData, SwarmToolId, EvalMetricConfig } from "@/lib/swarmRuntime";
import { DEFAULT_EVAL_METRICS, runSwarm } from "@/lib/swarmRuntime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModelCombobox } from "@/components/models/ModelCombobox";
import { supabase } from "@/integrations/supabase/client";
import { agentToNodePatch, type DroppedSetting } from "@/lib/agentToSwarmNode";
import { fetchAgentCard, type AgentCard } from "@/lib/a2aClient";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Trash2,
  X,
  Library,
  Search,
  Globe,
  BookOpen,
  Workflow,
  Plug,
  Calculator,
  Clock,
  CloudSun,
  Cloud,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Database,
  Shield,
  Brain,
  Code2,
  Play,
  GitBranch,
  Users,
  UserPlus,
  Mail,
  Plus,
  CopyPlus,
  Puzzle,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useApproverDirectory } from "@/hooks/use-approver-directory";
import { runSandboxed, safeStringify } from "@/lib/sandbox/jsSandbox";
import { coerceParams } from "@/lib/swarmComponents";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { PromptLibraryPicker } from "@/components/prompts/PromptLibraryPicker";
import { SkillPicker } from "@/components/skills/SkillPicker";
import { isImageModelId } from "@/lib/providerSupport";
import { allowedProviders, isModelAllowedByRules, useMyModelRules } from "@/hooks/use-iam";
import { useOllamaModels } from "@/hooks/use-ollama-models";

// Rerank-capable providers (Cohere/Jina-style POST /rerank); the picker
// filters to connected integrations (OpenRouter always available).
const NODE_RERANK_PROVIDERS: { id: string; label: string; models: string[] }[] = [
  { id: "openrouter", label: "OpenRouter", models: ["llama-nemotron-rerank-vl-1b-v2"] },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    models: ["nvidia/llama-3.2-nv-rerankqa-1b-v2", "nvidia/nv-rerankqa-mistral-4b-v3"],
  },
  { id: "vllm", label: "vLLM", models: [] },
  { id: "qwen", label: "Qwen", models: ["gte-rerank"] },
];

// Mirror the provider list shown in /agents AgentForm so swarm nodes can use
// any LLM provider the user has connected.
const PROVIDERS: { value: string; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "grok", label: "Grok (xAI)" },
  { value: "groq", label: "Groq (LPU inference)" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "bedrock", label: "AWS Bedrock (your account)" },
  { value: "vertex", label: "Google Vertex AI (your account)" },
  { value: "anthropic", label: "Anthropic direct (your API key)" },
  { value: "azure_openai", label: "Azure OpenAI (your deployment)" },
  { value: "oci_genai", label: "OCI Generative AI (your tenancy)" },
  { value: "qwen", label: "Qwen (Alibaba DashScope)" },
];

// Same model catalog as AgentForm — single source of truth would be nice,
// but keeping a copy avoids importing the 1000-line form into the canvas.
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  openai: [
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.2",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "o3",
    "o3-mini",
    "o1",
    "o1-preview",
    "o1-mini",
  ],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-image",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  grok: ["grok-4", "grok-3", "grok-3-mini", "grok-2-1212"],
  ollama: ["llama3.1", "mistral", "codellama", "mixtral"],
  bedrock: [
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "anthropic.claude-3-5-haiku-20241022-v1:0",
    "anthropic.claude-3-opus-20240229-v1:0",
    "meta.llama3-1-70b-instruct-v1:0",
    "mistral.mistral-large-2407-v1:0",
  ],
  vertex: ["gemini-2.5-pro", "gemini-2.5-flash", "claude-3-5-sonnet-v2@20241022"],
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-1-20250805",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ],
  azure_openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  oci_genai: [
    "cohere.command-r-plus-08-2024",
    "cohere.command-r-08-2024",
    "meta.llama-3.1-70b-instruct",
    "meta.llama-3.1-405b-instruct",
  ],
  qwen: [
    "qwen-max",
    "qwen-plus",
    "qwen-turbo",
    "qwen2.5-72b-instruct",
    "qwen2.5-32b-instruct",
    "qwen2.5-coder-32b-instruct",
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "llama-3.1-70b-versatile",
    "llama3-70b-8192",
    "llama3-8b-8192",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
    "deepseek-r1-distill-llama-70b",
    "qwen-2.5-32b",
    "qwen-2.5-coder-32b",
  ],
  openrouter: [
    // openrouter/free is OpenRouter's smart router that picks a free model
    // matching the request's required features. 200K ctx, $0/token.
    "openrouter/free",
    "openai/gpt-5",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3.5-haiku",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
    "deepseek/deepseek-chat",
    "mistralai/mistral-large",
    "x-ai/grok-2-1212",
    "qwen/qwen-2.5-72b-instruct",
  ],
};

// Providers that run the server-side tool loop. Must stay in sync with
// OPENAI_COMPAT_PROVIDERS in src/utils/providers/credentials.server.ts.
// An empty/undefined provider (which defaults to openrouter server-side)
// also runs the loop. Anything outside this set silently streams without tools.
const TOOL_SUPPORTING_PROVIDERS = new Set<string>([
  "openai",
  "gemini",
  "grok",
  "groq",
  "openrouter",
  "ollama",
  "qwen",
  "vllm",
  "nvidia",
]);
function providerLacksToolSupport(provider?: string): boolean {
  if (!provider) return false; // empty defaults to openrouter which supports tools
  return !TOOL_SUPPORTING_PROVIDERS.has(provider);
}

// Curated subset of tools a swarm node can opt into. These map 1:1 to the
// server-side TOOLABLE_IDS in registry.server.ts. Anything outside this list
// is intentionally hidden — the UI must not advertise tools that don't run.
const TOOL_CATALOG: { id: SwarmToolId; label: string; desc: string; icon: typeof Search }[] = [
  {
    id: "web_search",
    label: "Web Search",
    desc: "Search the web for fresh info (Firecrawl, falls back to DuckDuckGo).",
    icon: Search,
  },
  {
    id: "web_browse",
    label: "Web Browse",
    desc: "Fetch a URL as clean markdown for the agent to read (Firecrawl required).",
    icon: Globe,
  },
  {
    id: "kb_search",
    label: "Knowledge Base Search",
    desc: "Search documents in the agent's linked knowledge base.",
    icon: BookOpen,
  },
  {
    id: "kb_graph_search",
    label: "Knowledge Graph Search",
    desc: "Multi-hop Graph RAG over the KB's entity relationships. Build the graph in Knowledge → Graph first.",
    icon: GitBranch,
  },
  {
    id: "sql_query",
    label: "SQL Query",
    desc: "Run read-only SQL against the user's local CSV-derived tables (Data & SQL page).",
    icon: Database,
  },
  {
    id: "metric_query",
    label: "Semantic Metrics",
    desc: "Query governed metrics from the Semantic Layer. Pick the models below — the node gets none until you do.",
    icon: Database,
  },
  {
    id: "calculator",
    label: "Calculator",
    desc: "Safe math expression evaluator. No key needed.",
    icon: Calculator,
  },
  {
    id: "datetime",
    label: "Date & Time",
    desc: "Current date/time in any IANA timezone. No key needed.",
    icon: Clock,
  },
  {
    id: "weather",
    label: "Weather",
    desc: "Current conditions + 3-day forecast via Open-Meteo. No key needed.",
    icon: CloudSun,
  },
  {
    id: "n8n_run_workflow",
    label: "n8n Workflow",
    desc: "Trigger a workflow on the user's connected n8n instance.",
    icon: Workflow,
  },
  {
    id: "mcp_call_tool",
    label: "MCP Tool Call",
    desc: "Invoke a tool on a connected MCP server.",
    icon: Plug,
  },
];

type ImportableAgent = {
  id: string;
  name: string;
  description: string | null;
  llm_provider: string;
  llm_model: string;
  temperature: number;
  system_prompt: string | null;
  knowledge_base_id: string | null;
  tools: unknown;
};

type Props = {
  node: Node<SwarmNodeData>;
  knowledgeBases: { id: string; name: string }[];
  agentLibrary: ImportableAgent[];
  onChange: (patch: Partial<SwarmNodeData>) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onClose: () => void;
};

export function NodeInspector({
  node,
  knowledgeBases,
  agentLibrary,
  onChange,
  onDelete,
  onDuplicate,
  onClose,
}: Props) {
  const data = node.data;

  // Discover which LLM providers the user has connected. Mirrors AgentForm so
  // a swarm node can pick from the same list of providers/models the agent
  // builder shows. openrouter is always available (operator's shared key).
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(
    () => new Set<string>(["openrouter"]),
  );
  // Data tables — used by the sql_query per-node allow-list picker.
  const [availableDataTables, setAvailableDataTables] = useState<
    { id: string; name: string; is_sample: boolean }[]
  >([]);
  const [dataTablesLoaded, setDataTablesLoaded] = useState(false);
  // Semantic models — the metric_query per-node allow-list. RLS returns the
  // user's own plus IAM-shared, which is exactly the set the tool could reach,
  // so the picker cannot offer something that would then be refused at run time.
  const [availableSemanticModels, setAvailableSemanticModels] = useState<
    { id: string; name: string }[]
  >([]);
  const [semanticModelsLoaded, setSemanticModelsLoaded] = useState(false);
  // Connected MCP servers — used by the mcp_call_tool per-node allow-list picker
  // so users can check off servers instead of typing names from memory.
  const [availableMcpServers, setAvailableMcpServers] = useState<
    { id: string; name: string; type: string; status: string }[]
  >([]);
  const [mcpServersLoaded, setMcpServersLoaded] = useState(false);
  useEffect(() => {
    (async () => {
      const connected = new Set<string>(["openrouter"]);
      const [{ data: creds }, { data: integ }] = await Promise.all([
        supabase.from("provider_credentials").select("provider, is_active"),
        supabase.from("integrations").select("provider, type, is_active"),
      ]);
      creds?.forEach((r: { provider: string | null; is_active: boolean | null }) => {
        if (r.is_active !== false && r.provider) connected.add(r.provider);
      });
      integ
        ?.filter((r: { type: string }) => r.type === "llm_provider")
        .forEach((r: { provider: string | null; is_active: boolean | null }) => {
          if (r.is_active !== false && r.provider) connected.add(r.provider);
        });
      setConnectedProviders(connected);
      const { data: dt } = await supabase
        .from("user_data_tables")
        .select("id, name, is_sample")
        .order("name", { ascending: true });
      if (dt) setAvailableDataTables(dt);
      setDataTablesLoaded(true);
      const { data: sm } = await supabase
        .from("semantic_models")
        .select("id, name")
        .order("name", { ascending: true });
      if (sm) setAvailableSemanticModels(sm);
      setSemanticModelsLoaded(true);
      const { data: mcp } = await supabase
        .from("mcp_servers")
        .select("id, name, type, status")
        .eq("status", "connected")
        .order("name", { ascending: true });
      if (mcp) {
        setAvailableMcpServers(mcp as any);
        // Only live servers are selectable. Prune anything removed or no
        // longer connected on the inspected node before it can render.
        const validNames = new Set((mcp as any[]).map((s) => s.name));
        const current = (data.toolConfigs?.mcp_server_names ?? []) as string[];
        if (Array.isArray(current) && current.some((n) => !validNames.has(n))) {
          onChange({
            toolConfigs: {
              ...(data.toolConfigs ?? {}),
              mcp_server_names: current.filter((n) => validNames.has(n)),
            },
          });
        }
      }
      setMcpServersLoaded(true);
    })();
  }, []);

  const currentProvider = data.provider || "openrouter";
  const currentModel = data.model || "openai/gpt-4o-mini";
  // IAM model governance: hide providers/models the admin hasn't allowed.
  const myModelRules = useMyModelRules();
  const iamAllowedProviders = allowedProviders(myModelRules);
  // Live model tags from a connected Ollama integration.
  const ollamaLive = useOllamaModels(currentProvider === "ollama");
  // Show every connected provider + the node's current one (even if it was
  // disconnected after the fact, so the value isn't silently dropped).
  const availableProviders = PROVIDERS.filter(
    (p) => connectedProviders.has(p.value) || p.value === currentProvider,
  ).filter(
    (p) => !iamAllowedProviders || iamAllowedProviders.has(p.value) || p.value === currentProvider,
  );
  const baseModelSuggestions =
    currentProvider === "ollama" && ollamaLive.models.length > 0
      ? ollamaLive.models
      : MODEL_SUGGESTIONS[currentProvider] || [];
  const suggestedModels = baseModelSuggestions.filter((m) =>
    isModelAllowedByRules(myModelRules, currentProvider, m),
  );

  /** What the last import could not bring across, shown under the picker. */
  const [importDropped, setImportDropped] = useState<DroppedSetting[]>([]);

  // Snapshot-copy an existing /agents Agent into this node. Independent copy:
  // future edits to the source agent won't affect this swarm.
  //
  // The mapping lives in agentToSwarmNode so the tests exercise the real one.
  // It used to be inline and handled three tool ids out of eleven, and copied
  // none of the settings whose purpose is to restrict — see that module's
  // header for what that cost.
  function importFromLibrary(agentId: string) {
    const a = agentLibrary.find((x) => x.id === agentId);
    if (!a) return;
    const { patch, dropped } = agentToNodePatch(a);
    onChange(patch);
    setImportDropped(dropped);
  }

  const enabled = new Set<SwarmToolId>(data.enabledTools ?? []);
  function toggleTool(id: SwarmToolId, on: boolean) {
    const next = new Set(enabled);
    if (on) next.add(id);
    else next.delete(id);
    onChange({ enabledTools: Array.from(next) });
  }

  // Per-tool configuration helpers. Mirror the agent builder's panels:
  //   - web_search / web_browse: provider + API key (built-in Firecrawl by default)
  //   - n8n_run_workflow: comma-separated allow-list of workflow ids
  //   - mcp_call_tool: comma-separated allow-list of server names
  // All values are persisted to node.data.toolConfigs and forwarded by
  // swarmRuntime.callAgent → /api/chat → resolveAgentTools where they are
  // strictly enforced (not cosmetic).
  const tc = data.toolConfigs ?? {};
  function patchToolConfig(patch: Partial<NonNullable<SwarmNodeData["toolConfigs"]>>) {
    onChange({ toolConfigs: { ...tc, ...patch } });
  }
  function patchWebTool(
    key: "web_search" | "web_browse",
    patch: Partial<NonNullable<NonNullable<SwarmNodeData["toolConfigs"]>["web_search"]>>,
  ) {
    onChange({
      toolConfigs: {
        ...tc,
        [key]: { ...(tc[key] ?? {}), ...patch },
      },
    });
  }

  return (
    <aside className="w-80 border-l border-border bg-card/40 flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {data.kind} node
          </p>
          <p className="text-sm font-semibold truncate">{data.label}</p>
        </div>
        <div className="flex items-center gap-1">
          {onDuplicate && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onDuplicate}
              title="Duplicate node"
            >
              <CopyPlus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onDelete}
            title="Delete node"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
        <Section label="Label">
          <Input value={data.label} onChange={(e) => onChange({ label: e.target.value })} />
        </Section>

        {TESTABLE_KINDS.has(data.kind) && <NodeTestButton node={node} />}

        {(data.kind === "agent" ||
          data.kind === "loop" ||
          data.kind === "condition" ||
          data.kind === "router" ||
          data.kind === "evaluate" ||
          data.kind === "foreach" ||
          data.kind === "extract") && (
          <>
            {/* Helper banner — clarifies how loop/condition differ from a plain agent.
                Agent nodes get no banner (the defaults are self-explanatory). */}
            {data.kind === "loop" && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-[11px] leading-relaxed">
                <p className="font-medium text-foreground mb-0.5">🔁 Loop node</p>
                <p className="text-muted-foreground">
                  Re-runs this agent body up to <strong>Max iterations</strong> times. Each
                  iteration sees the previous output as context. Stops early when the agent appends{" "}
                  <code className="font-mono">DONE</code> to its reply.
                </p>
              </div>
            )}
            {data.kind === "condition" && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-[11px] leading-relaxed">
                <p className="font-medium text-foreground mb-0.5">🔀 Condition node</p>
                <p className="text-muted-foreground">
                  Asks the LLM a YES/NO question and routes execution along the outgoing edge whose
                  label matches (<code className="font-mono">yes</code> or{" "}
                  <code className="font-mono">no</code>). No tools or knowledge base — just a fast
                  judgment call.
                </p>
              </div>
            )}
            {data.kind === "router" && (
              <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-2.5 text-[11px] leading-relaxed">
                <p className="font-medium text-foreground mb-0.5">🧭 Router Agent</p>
                <p className="text-muted-foreground">
                  Intelligently picks <strong>one</strong> outgoing route. Label each outgoing edge
                  with a route name (e.g. <code className="font-mono">math</code>,{" "}
                  <code className="font-mono">writer</code>, <code className="font-mono">code</code>
                  ) — the LLM chooses one, that branch runs, and the others stay still. Use this
                  instead of fanning an agent out to multiple branches in parallel.
                </p>
              </div>
            )}
            {data.kind === "evaluate" && (
              <div className="rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5 text-[11px] leading-relaxed">
                <p className="font-medium text-foreground mb-0.5">
                  📊 Evaluate node (LLM-as-a-Judge)
                </p>
                <p className="text-muted-foreground">
                  Scores upstream output against configurable metrics (faithfulness, relevancy,
                  completeness, etc.) using a strong LLM judge. Returns a structured JSON scorecard
                  with per-metric 0–1 scores, justifications, and an overall pass/fail verdict. Best
                  practice: use a <strong>different model family</strong> than the candidate being
                  judged.
                </p>
              </div>
            )}

            {/* Import from agent library — snapshot copy.
                Hidden for condition/evaluate nodes: importing a full agent's prompt + tools
                doesn't make sense for specialized judge nodes. */}
            {data.kind !== "condition" &&
              data.kind !== "router" &&
              data.kind !== "evaluate" &&
              data.kind !== "extract" && (
                <Section label="Import from agent library">
                  <Select value="" onValueChange={importFromLibrary}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          agentLibrary.length === 0
                            ? "No saved agents yet — build one in /agents"
                            : "Pick an agent to copy in"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {agentLibrary.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <span className="flex items-center gap-2">
                            <Library className="h-3 w-3 text-primary" />
                            <span className="truncate">{a.name}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Copies prompt, model, tools, guardrails, tool limits and KB into this node.
                    Independent of the source — future edits to the agent won't affect this swarm.
                  </p>
                  {importDropped.length > 0 && (
                    // A copy that arrives quietly smaller is worse than one that
                    // says what it left behind.
                    <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
                      <p className="text-[10px] font-medium text-amber-700 dark:text-amber-400">
                        Not copied into this node:
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {importDropped.map((d) => (
                          <li key={d.what} className="text-[10px] text-muted-foreground">
                            <span className="text-foreground">{d.what}</span> — {d.why}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Section>
              )}

            <Section label="Provider">
              <Select
                value={currentProvider}
                onValueChange={(v) => {
                  // When provider changes, snap the model to the first
                  // suggestion for that provider so we don't end up with an
                  // OpenAI model still selected after switching to Anthropic.
                  const first =
                    (v === "ollama" && ollamaLive.models[0]) || MODEL_SUGGESTIONS[v]?.[0];
                  onChange({ provider: v, ...(first ? { model: first } : {}) });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableProviders.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                      {!connectedProviders.has(p.value) && p.value !== "openrouter" && (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          (not connected)
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground mt-1">
                Only providers you've connected appear here. Add more in{" "}
                <strong>Integrations</strong>.
              </p>
            </Section>

            <Section label="Model">
              {/* The provider's live catalogue, searchable. This used to be a
                  plain Select over MODEL_SUGGESTIONS -- about a dozen bundled
                  ids -- so picking any of OpenRouter's several hundred meant
                  typing the exact id from memory into the box below. The
                  bundled list is still passed as the fallback for a provider
                  that publishes no catalogue, or before the first fetch lands,
                  and an unlisted id can still be typed and used. */}
              <ModelCombobox
                value={currentModel}
                onChange={(m) => onChange({ model: m })}
                provider={currentProvider}
                fallbackModels={suggestedModels}
                isAllowed={(m) => isModelAllowedByRules(myModelRules, currentProvider, m)}
                placeholder="Search or type a model id..."
                renderBadge={(m) =>
                  isImageModelId(m) ? (
                    <span className="ml-2 shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-1 text-[9px] uppercase tracking-wider text-primary">
                      Image
                    </span>
                  ) : null
                }
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {isImageModelId(currentModel)
                  ? "This model returns an image. The node accepts text prompts and (optionally) an upstream image to edit. The final image renders in the Run panel with a Download button."
                  : currentProvider === "openrouter"
                    ? "Routed via OpenRouter — uses the server's default key unless you've connected your own."
                    : "Uses your connected provider credentials."}
              </p>
            </Section>

            <Section label={`Temperature: ${(data.temperature ?? 0.4).toFixed(2)}`}>
              <Slider
                value={[data.temperature ?? 0.4]}
                min={0}
                max={1}
                step={0.05}
                onValueChange={([v]) => onChange({ temperature: v })}
              />
            </Section>

            {data.kind !== "evaluate" && data.kind !== "extract" && (
              <Section
                label={
                  data.kind === "condition"
                    ? "Condition prompt (asks YES/NO)"
                    : data.kind === "router"
                      ? "Router prompt (picks 1 of N route labels)"
                      : data.kind === "foreach"
                        ? "Per-item prompt (body run for each item)"
                        : "System prompt"
                }
              >
                {data.kind !== "condition" && data.kind !== "router" && (
                  <div className="flex justify-end mb-1.5">
                    <PromptLibraryPicker
                      iconOnly
                      align="end"
                      onPick={(p) => {
                        onChange({ systemPrompt: p.content });
                        toast.success(`Loaded "${p.title}" from Library`);
                      }}
                    />
                  </div>
                )}
                <Textarea
                  value={
                    data.kind === "condition"
                      ? data.conditionPrompt || ""
                      : data.kind === "router"
                        ? data.routerPrompt || ""
                        : data.systemPrompt || ""
                  }
                  onChange={(e) =>
                    onChange(
                      data.kind === "condition"
                        ? { conditionPrompt: e.target.value }
                        : data.kind === "router"
                          ? { routerPrompt: e.target.value }
                          : { systemPrompt: e.target.value },
                    )
                  }
                  rows={6}
                  placeholder={
                    data.kind === "condition"
                      ? "Should the workflow continue down the YES branch?"
                      : data.kind === "router"
                        ? "You manage these specialists: ... Pick the best route for the user's request."
                        : "You are a helpful agent that..."
                  }
                  className="font-mono text-xs"
                />
                {data.kind === "router" && (
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    Route names come from the labels on this node's outgoing edges. Click an edge to
                    label it (e.g. <code className="font-mono">math</code>,{" "}
                    <code className="font-mono">writer</code>). Unlabeled edges are ignored.
                  </p>
                )}
              </Section>
            )}

            {data.kind !== "condition" &&
              data.kind !== "router" &&
              data.kind !== "evaluate" &&
              data.kind !== "extract" && (
                <Section label="Skills (from Skill Library)">
                  <SkillPicker
                    value={Array.isArray(data.skillIds) ? data.skillIds : []}
                    onChange={(ids) => onChange({ skillIds: ids })}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    Attached skills are prepended to this node's system prompt at run time.
                  </p>
                </Section>
              )}

            {data.kind === "loop" && (
              <Section label={`Max iterations: ${data.maxIters ?? 3}`}>
                <Slider
                  value={[data.maxIters ?? 3]}
                  min={1}
                  max={6}
                  step={1}
                  onValueChange={([v]) => onChange({ maxIters: v })}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Loop ends early when the agent appends <code>DONE</code>.
                </p>
              </Section>
            )}

            {/* Tools + KB hidden for condition/router/evaluate nodes — specialized judges don't need them. */}
            {data.kind !== "condition" &&
              data.kind !== "router" &&
              data.kind !== "evaluate" &&
              data.kind !== "extract" && (
                <>
                  {/* Warn when this node's provider doesn't support tool calling.
                    The chat API only runs the tool loop for OpenAI-compatible
                    providers + the built-in gateway; everything else (Bedrock,
                    Vertex, Azure, OCI, direct Anthropic) silently ignores
                    enabledTools and streams plain text. */}
                  {(data.enabledTools ?? []).length > 0 &&
                    providerLacksToolSupport(data.provider) && (
                      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
                        <p className="text-[11px] text-amber-400 leading-snug">
                          <strong>⚠ Tools may be ignored.</strong> The selected provider (
                          {data.provider}) doesn&apos;t support tool calling in this app yet — only
                          OpenAI-compatible providers (OpenAI, Gemini, Grok, Groq, OpenRouter,
                          Ollama, Qwen, vLLM, NVIDIA NIM) and the built-in gateway run the tool
                          loop. This node will stream plain text without invoking tools.
                        </p>
                      </div>
                    )}

                  {/* Curated per-node tool toggles */}
                  <Section label="Tools (server-side, executed during run)">
                    <div className="space-y-2">
                      {TOOL_CATALOG.map((t) => {
                        const Icon = t.icon;
                        const on = enabled.has(t.id);
                        return (
                          <div
                            key={t.id}
                            className="rounded-md border border-border/50 bg-background/40 p-2"
                          >
                            <div className="flex items-start gap-2">
                              <Icon
                                className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${on ? "text-primary" : "text-muted-foreground"}`}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium">{t.label}</span>
                                  <Switch
                                    checked={on}
                                    onCheckedChange={(v) => toggleTool(t.id, v)}
                                  />
                                </div>
                                <p className="text-[10px] text-muted-foreground mt-0.5">{t.desc}</p>
                              </div>
                            </div>

                            {/* Per-tool configuration. Real, not cosmetic — values are
                          forwarded to /api/chat → resolveAgentTools. */}
                            {on &&
                              (t.id === "web_search" || t.id === "web_browse") &&
                              (() => {
                                const webId: "web_search" | "web_browse" = t.id;
                                const provider = tc[webId]?.provider || "firecrawl_builtin";
                                return (
                                  <div className="mt-2 pt-2 border-t border-border/40 space-y-2">
                                    <div>
                                      <Label className="text-[10px] text-muted-foreground mb-1 block">
                                        Provider
                                      </Label>
                                      <Select
                                        value={provider}
                                        onValueChange={(v) =>
                                          patchWebTool(webId, {
                                            provider: v,
                                            ...(v === "firecrawl_builtin" ? { api_key: "" } : {}),
                                          })
                                        }
                                      >
                                        <SelectTrigger className="h-8 text-xs">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="firecrawl_builtin">
                                            Firecrawl (built-in)
                                          </SelectItem>
                                          <SelectItem value="firecrawl_custom">
                                            Firecrawl (custom API key)
                                          </SelectItem>
                                          {webId === "web_search" && (
                                            <>
                                              <SelectItem value="brave">Brave Search</SelectItem>
                                              <SelectItem value="tavily">Tavily</SelectItem>
                                              <SelectItem value="serpapi">SerpAPI</SelectItem>
                                            </>
                                          )}
                                          {webId === "web_browse" && (
                                            <SelectItem value="scrapingbee">ScrapingBee</SelectItem>
                                          )}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    {provider !== "firecrawl_builtin" && (
                                      <div>
                                        <Label className="text-[10px] text-muted-foreground mb-1 block">
                                          API key
                                        </Label>
                                        <Input
                                          type="password"
                                          className="h-8 text-xs font-mono"
                                          placeholder="Paste API key for selected provider"
                                          value={tc[webId]?.api_key || ""}
                                          onChange={(e) =>
                                            patchWebTool(webId, { api_key: e.target.value })
                                          }
                                        />
                                      </div>
                                    )}
                                    {provider === "firecrawl_builtin" && (
                                      <p className="text-[10px] text-muted-foreground">
                                        Uses the workspace Firecrawl key from{" "}
                                        <span className="font-medium text-foreground">
                                          Connectors
                                        </span>
                                        . Falls back to DuckDuckGo for search if Firecrawl is
                                        unavailable.
                                      </p>
                                    )}
                                  </div>
                                );
                              })()}

                            {on && t.id === "n8n_run_workflow" && (
                              <div className="mt-2 pt-2 border-t border-border/40 space-y-1">
                                <Label className="text-[10px] text-muted-foreground block">
                                  Allowed workflow IDs (optional)
                                </Label>
                                <Input
                                  className="h-8 text-xs font-mono"
                                  placeholder="wf_abc123, wf_xyz789"
                                  value={(tc.n8n_workflow_ids ?? []).join(", ")}
                                  onChange={(e) =>
                                    patchToolConfig({
                                      n8n_workflow_ids: e.target.value
                                        .split(",")
                                        .map((s) => s.trim())
                                        .filter(Boolean),
                                    })
                                  }
                                />
                                <p className="text-[10px] text-muted-foreground">
                                  Comma-separated. Empty = any workflow on the connected n8n
                                  instance. Connect n8n in{" "}
                                  <span className="font-medium text-foreground">Integrations</span>.
                                </p>
                              </div>
                            )}

                            {on && t.id === "mcp_call_tool" && (
                              <div className="mt-2 pt-2 border-t border-border/40 space-y-1.5">
                                <Label className="text-[10px] text-muted-foreground block">
                                  Allowed MCP servers (optional)
                                </Label>
                                {!mcpServersLoaded ? (
                                  <p className="text-[10px] text-muted-foreground">Loading…</p>
                                ) : availableMcpServers.length === 0 ? (
                                  <p className="text-[10px] text-muted-foreground">
                                    No MCP servers connected. Add one under{" "}
                                    <a href="/mcp" className="text-primary underline">
                                      /mcp
                                    </a>
                                    .
                                  </p>
                                ) : (
                                  <>
                                    {(() => {
                                      const validNames = new Set(
                                        availableMcpServers.map((s) => s.name),
                                      );
                                      const selected = new Set(
                                        (tc.mcp_server_names ?? []).filter((n) =>
                                          validNames.has(n),
                                        ),
                                      );
                                      return (
                                        <>
                                          <div className="grid gap-1">
                                            {availableMcpServers.map((srv) => {
                                              const checked = selected.has(srv.name);
                                              return (
                                                <label
                                                  key={srv.id}
                                                  className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-2 py-1 cursor-pointer hover:border-primary/40"
                                                >
                                                  <input
                                                    type="checkbox"
                                                    className="h-3 w-3 accent-primary"
                                                    checked={checked}
                                                    onChange={(e) => {
                                                      const next = new Set(selected);
                                                      if (e.target.checked) next.add(srv.name);
                                                      else next.delete(srv.name);
                                                      patchToolConfig({
                                                        mcp_server_names: Array.from(next),
                                                      });
                                                    }}
                                                  />
                                                  <span className="text-[11px] font-medium truncate flex-1">
                                                    {srv.name}
                                                  </span>
                                                  <span className="text-[9px] text-muted-foreground capitalize">
                                                    {srv.status}
                                                  </span>
                                                </label>
                                              );
                                            })}
                                          </div>
                                          <p className="text-[10px] text-muted-foreground">
                                            Empty = any connected server is allowed.
                                          </p>
                                        </>
                                      );
                                    })()}
                                  </>
                                )}
                              </div>
                            )}

                            {on && t.id === "kb_search" && !data.knowledgeBaseId && (
                              <div className="mt-2 pt-2 border-t border-border/40">
                                <p className="text-[10px] text-destructive">
                                  Pick a knowledge base below for this tool to return results.
                                </p>
                              </div>
                            )}

                            {on && t.id === "sql_query" && (
                              <div className="mt-2 pt-2 border-t border-border/40 space-y-1">
                                <Label className="text-[10px] text-muted-foreground block">
                                  Allowed tables (optional)
                                </Label>
                                {!dataTablesLoaded ? (
                                  <p className="text-[10px] text-muted-foreground">
                                    Loading tables…
                                  </p>
                                ) : availableDataTables.length === 0 ? (
                                  <p className="text-[10px] text-muted-foreground">
                                    No tables yet. Upload a CSV in{" "}
                                    <span className="font-medium text-foreground">
                                      Data &amp; SQL Agents
                                    </span>
                                    .
                                  </p>
                                ) : (
                                  <>
                                    <div className="max-h-32 overflow-y-auto space-y-1 rounded-md border border-border/40 bg-background/40 p-2">
                                      {availableDataTables.map((dt) => {
                                        const list = tc.sql_table_names ?? [];
                                        const checked = list.includes(dt.name);
                                        return (
                                          <label
                                            key={dt.id}
                                            className="flex items-start gap-2 cursor-pointer text-[10px]"
                                          >
                                            <input
                                              type="checkbox"
                                              className="mt-0.5"
                                              checked={checked}
                                              onChange={(e) => {
                                                const next = e.target.checked
                                                  ? Array.from(new Set([...list, dt.name]))
                                                  : list.filter((n) => n !== dt.name);
                                                patchToolConfig({ sql_table_names: next });
                                              }}
                                            />
                                            <span className="font-mono truncate flex-1">
                                              {dt.name}
                                            </span>
                                            {dt.is_sample && (
                                              <Badge variant="outline" className="text-[9px]">
                                                sample
                                              </Badge>
                                            )}
                                          </label>
                                        );
                                      })}
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">
                                      {(tc.sql_table_names ?? []).length === 0
                                        ? "No selection — node can query every table you can read."
                                        : `Node will only see ${(tc.sql_table_names ?? []).length} selected table${(tc.sql_table_names ?? []).length === 1 ? "" : "s"}.`}
                                    </p>
                                  </>
                                )}
                              </div>
                            )}

                            {on && t.id === "metric_query" && (
                              <div className="mt-2 pt-2 border-t border-border/40 space-y-1">
                                <Label className="text-[10px] text-muted-foreground block">
                                  Allowed semantic models (required)
                                </Label>
                                {!semanticModelsLoaded ? (
                                  <p className="text-[10px] text-muted-foreground">
                                    Loading models…
                                  </p>
                                ) : availableSemanticModels.length === 0 ? (
                                  <p className="text-[10px] text-muted-foreground">
                                    No semantic models yet. Define one under{" "}
                                    <span className="font-medium text-foreground">
                                      Semantic Layer
                                    </span>
                                    .
                                  </p>
                                ) : (
                                  <>
                                    <div className="max-h-32 overflow-y-auto space-y-1 rounded-md border border-border/40 bg-background/40 p-2">
                                      {availableSemanticModels.map((sm) => {
                                        const list = tc.metric_model_names ?? [];
                                        const checked = list.includes(sm.name);
                                        return (
                                          <label
                                            key={sm.id}
                                            className="flex items-start gap-2 cursor-pointer text-[10px]"
                                          >
                                            <input
                                              type="checkbox"
                                              className="mt-0.5"
                                              checked={checked}
                                              onChange={(e) => {
                                                const next = e.target.checked
                                                  ? Array.from(new Set([...list, sm.name]))
                                                  : list.filter((n) => n !== sm.name);
                                                patchToolConfig({ metric_model_names: next });
                                              }}
                                            />
                                            <span className="font-mono truncate flex-1">
                                              {sm.name}
                                            </span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                    {/* Deny-by-default, the opposite of the SQL
                                        picker directly above. Say so, because the
                                        difference is invisible otherwise. */}
                                    <p
                                      className={`text-[10px] ${
                                        (tc.metric_model_names ?? []).length === 0
                                          ? "text-amber-600 dark:text-amber-500"
                                          : "text-muted-foreground"
                                      }`}
                                    >
                                      {(tc.metric_model_names ?? []).length === 0
                                        ? "No models selected — this tool stays inactive on this node."
                                        : `Node can query ${(tc.metric_model_names ?? []).length} model${(tc.metric_model_names ?? []).length === 1 ? "" : "s"}.`}
                                    </p>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-2">
                      Each enabled tool is offered to the model during this node's run. Tools whose
                      backing service isn't connected are silently skipped.
                    </p>
                  </Section>

                  <Section label="Knowledge base (optional, for grounding)">
                    <Select
                      value={data.knowledgeBaseId || "__none__"}
                      onValueChange={(v) =>
                        onChange({ knowledgeBaseId: v === "__none__" ? null : v })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {knowledgeBases.map((kb) => (
                          <SelectItem key={kb.id} value={kb.id}>
                            {kb.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Retrieved chunks are injected into this node's context and via the kb_search
                      tool when enabled.
                    </p>
                  </Section>

                  <Section label="Retrieval re-ranker (optional)">
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        value={data.reranker?.provider || "__none__"}
                        onValueChange={(v) =>
                          onChange({
                            reranker:
                              v === "__none__"
                                ? null
                                : {
                                    provider: v,
                                    model:
                                      NODE_RERANK_PROVIDERS.find((r) => r.id === v)?.models[0] ??
                                      data.reranker?.model ??
                                      "",
                                  },
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None (similarity order)</SelectItem>
                          {NODE_RERANK_PROVIDERS.filter(
                            (r) =>
                              connectedProviders.has(r.id) ||
                              r.id === "openrouter" ||
                              r.id === data.reranker?.provider,
                          ).map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.label}
                              {!connectedProviders.has(r.id) && r.id !== "openrouter"
                                ? " (not connected)"
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {data.reranker && (
                        <Input
                          value={data.reranker.model}
                          onChange={(e) =>
                            onChange({
                              reranker: {
                                provider: data.reranker!.provider,
                                model: e.target.value,
                              },
                            })
                          }
                          placeholder={
                            NODE_RERANK_PROVIDERS.find((r) => r.id === data.reranker?.provider)
                              ?.models[0] ?? "rerank model"
                          }
                        />
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      A cross-encoder reorders retrieved chunks before this node sees them. Only
                      connected integrations with a rerank API are listed; failures fall back to
                      similarity order.
                    </p>
                  </Section>

                  {/* Per-node guardrails. Real enforcement — values are forwarded to
                /api/chat where they merge OVER the linked agent's saved
                guardrails (so a node can be STRICTER than its source agent). */}
                  <GuardrailsSection data={data} onChange={onChange} />

                  {/* Per-node memory configuration. Forwarded as memoryOverrides to
                /api/chat. STM scope is per-conversation; LTM scope decides
                whether facts are shared with the agent's normal sessions or
                isolated to this swarm run. */}
                  <MemorySection data={data} onChange={onChange} />
                </>
              )}
          </>
        )}

        {data.kind === "approval" && (
          <>
            <Section label="Approval title (shown in inbox)">
              <Input
                value={data.approvalTitle || ""}
                onChange={(e) => onChange({ approvalTitle: e.target.value })}
                placeholder="Approve action: send email"
              />
            </Section>
            <Section label="Risk level">
              <Select
                value={data.approvalRisk || "medium"}
                onValueChange={(v) => onChange({ approvalRisk: v as "low" | "medium" | "high" })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </Section>
            <Section label="Timeout (seconds)">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  step={30}
                  value={data.approvalTimeoutMs ? Math.round(data.approvalTimeoutMs / 1000) : ""}
                  onChange={(e) => {
                    const secs = parseInt(e.target.value, 10);
                    onChange({ approvalTimeoutMs: secs > 0 ? secs * 1000 : undefined });
                  }}
                  placeholder="No timeout"
                  className="w-32"
                />
                <span className="text-[11px] text-muted-foreground">
                  seconds (0 = wait forever)
                </span>
              </div>
            </Section>
            <ApproverPicker data={data} onChange={onChange} />
          </>
        )}

        {data.kind === "a2a_remote" && <A2APanel data={data} onChange={onChange} />}

        {data.kind === "function" && <FunctionPanel data={data} onChange={onChange} />}

        {data.kind === "evaluate" && <EvaluatePanel data={data} onChange={onChange} />}

        {data.kind === "set_var" && <SetVarPanel data={data} onChange={onChange} />}

        {data.kind === "http" && <HttpPanel data={data} onChange={onChange} />}

        {data.kind === "tool" && (
          <ToolPanel data={data} onChange={onChange} knowledgeBases={knowledgeBases} />
        )}

        {data.kind === "foreach" && <ForEachPanel data={data} onChange={onChange} />}

        {data.kind === "extract" && <ExtractPanel data={data} onChange={onChange} />}

        {data.kind === "merge" && <MergePanel data={data} onChange={onChange} />}

        {data.kind === "retrieve" && (
          <RetrievePanel data={data} onChange={onChange} knowledgeBases={knowledgeBases} />
        )}

        {data.kind === "input" && <InputFieldsPanel data={data} onChange={onChange} />}

        {data.kind === "subswarm" && <SubSwarmPanel data={data} onChange={onChange} />}

        {ERROR_POLICY_KINDS.has(data.kind) && (
          <ErrorPolicySection
            data={data}
            onChange={onChange}
            showTimeout={LLM_TIMEOUT_KINDS.has(data.kind)}
          />
        )}

        <Section label="Inputs (variables read from upstream)">
          <Input
            value={(data.inputs ?? []).join(", ")}
            onChange={(e) =>
              onChange({
                inputs: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="input, summary"
            className="font-mono text-xs"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Comma-separated. Each upstream node's output is keyed by its <code>outputVar</code>.
          </p>
        </Section>

        {data.kind !== "output" && (
          <Section label="Output variable (name written to context)">
            <Input
              value={data.outputVar || ""}
              onChange={(e) =>
                onChange({ outputVar: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })
              }
              placeholder={data.kind === "input" ? "input" : `out_${node.id}`}
              className="font-mono text-xs"
            />
          </Section>
        )}

        {data.lastOutput && (
          <Section label="Last output (preview)">
            <div className="rounded-md border border-border bg-background/50 p-2 text-xs max-h-40 overflow-auto whitespace-pre-wrap">
              {data.lastOutput.slice(0, 1500)}
            </div>
          </Section>
        )}

        <div className="flex flex-wrap gap-1 pt-2 border-t border-border">
          <Badge variant="outline" className="text-[9px]">
            id: {node.id}
          </Badge>
          <Badge variant="outline" className="text-[9px]">
            kind: {data.kind}
          </Badge>
          {(data.enabledTools?.length ?? 0) > 0 && (
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">
              {data.enabledTools!.length} tool{data.enabledTools!.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </div>
    </aside>
  );
}

// ───────────────────── Per-node Guardrails panel ─────────────────────
// Real, server-enforced guardrails. The values entered here ride along on
// every /api/chat request this node makes (see swarmRuntime.callAgent),
// where they are merged OVER the linked agent's saved guardrails. The
// chat route then runs the same evaluateInputGuardrails / applyOutputGuardrails
// pipeline used by the playground — same redaction, same blocking, same
// safety-tier matching. Nothing here is cosmetic.
function GuardrailsSection({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const g = (data.guardrails ?? {}) as NonNullable<SwarmNodeData["guardrails"]>;
  const active =
    !!g.enableInputFilters ||
    !!g.enableOutputFilters ||
    !!g.blockPII ||
    (g.piiMode && g.piiMode !== "off") ||
    !!g.blockProfanity ||
    (g.contentSafetyLevel && g.contentSafetyLevel !== "off") ||
    !!g.enableCitationCheck ||
    !!g.enableHallucinationFilter ||
    !!(g.blockedPatterns && g.blockedPatterns.trim()) ||
    !!(g.allowedTopics && g.allowedTopics.trim()) ||
    !!(g.topicRestrictions && g.topicRestrictions.trim());

  function patch(p: Partial<NonNullable<SwarmNodeData["guardrails"]>>) {
    onChange({ guardrails: { ...g, ...p } });
  }

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Shield className="h-3 w-3 text-primary" />
          Guardrails (server-enforced)
          {active && (
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary ml-1">
              active
            </Badge>
          )}
        </span>
      }
    >
      <div className="rounded-md border border-border/50 bg-background/40 p-2.5 space-y-3">
        <p className="text-[10px] text-muted-foreground">
          These are the ONLY guardrails a swarm run applies to this node — a node is a snapshot, not
          a link, so nothing is inherited from the agent it was imported from. Inputs that violate
          these rules are rejected by <code className="font-mono">/api/chat</code> with a 422;
          unsafe outputs are redacted or blocked before they reach the canvas.
        </p>

        {/* Content safety */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">Content safety level</Label>
          <Select
            value={g.contentSafetyLevel || "off"}
            onValueChange={(v) =>
              patch({ contentSafetyLevel: v as "off" | "low" | "medium" | "high" })
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off (inherit from agent)</SelectItem>
              <SelectItem value="low">Low — block explicit harm terms</SelectItem>
              <SelectItem value="medium">Medium — + sensitive categories</SelectItem>
              <SelectItem value="high">High — + borderline terms</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* PII / data protection */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">Personal data (PII)</Label>
          <Select
            value={g.piiMode || (g.blockPII ? "redact" : "off")}
            onValueChange={(v) =>
              patch({
                piiMode: v as "off" | "redact" | "block",
                // Mirror onto the legacy flag so anything still reading it agrees.
                blockPII: v !== "off",
              })
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off (inherit from agent)</SelectItem>
              <SelectItem value="redact">Redact — mask identifiers</SelectItem>
              <SelectItem value="block">Block — refuse the turn</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            Emails, secrets/API keys, IBANs, national IDs, checksum-validated card numbers, phones,
            IPs. Applies to what this node sends AND what it returns.
          </p>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <Label className="text-xs">Block profanity</Label>
            <p className="text-[10px] text-muted-foreground">
              Mask matched terms in the assistant's reply.
            </p>
          </div>
          <Switch
            checked={!!g.blockProfanity}
            onCheckedChange={(v) => patch({ blockProfanity: v })}
          />
        </div>

        {/* Input filters */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
          <Label className="text-xs">Enable input filters</Label>
          <Switch
            checked={!!g.enableInputFilters}
            onCheckedChange={(v) => patch({ enableInputFilters: v })}
          />
        </div>
        {g.enableInputFilters && (
          <>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Max input length (chars)</Label>
              <Input
                type="number"
                className="h-8 text-xs"
                value={g.maxInputLength ?? 4000}
                min={100}
                max={100000}
                onChange={(e) => patch({ maxInputLength: Number(e.target.value) || 4000 })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">
                Blocked input patterns (regex, one per line)
              </Label>
              <Textarea
                rows={2}
                className="text-xs font-mono"
                value={g.blockedPatterns ?? ""}
                onChange={(e) => patch({ blockedPatterns: e.target.value })}
                placeholder={"ignore previous instructions\nact as.*DAN"}
              />
            </div>
          </>
        )}

        {/* Output filters */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
          <Label className="text-xs">Enable output filters</Label>
          <Switch
            checked={!!g.enableOutputFilters}
            onCheckedChange={(v) => patch({ enableOutputFilters: v })}
          />
        </div>
        {g.enableOutputFilters && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-xs">Citation check</Label>
                <p className="text-[10px] text-muted-foreground">
                  Warn when KB-grounded answers omit [n] markers.
                </p>
              </div>
              <Switch
                checked={!!g.enableCitationCheck}
                onCheckedChange={(v) => patch({ enableCitationCheck: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-xs">Hallucination heuristic</Label>
                <p className="text-[10px] text-muted-foreground">
                  Warn when grounded answers state numbers/years without a source.
                </p>
              </div>
              <Switch
                checked={!!g.enableHallucinationFilter}
                onCheckedChange={(v) => patch({ enableHallucinationFilter: v })}
              />
            </div>
          </>
        )}

        {/* Topics */}
        <div className="space-y-1 pt-1 border-t border-border/40">
          <Label className="text-[10px] text-muted-foreground">
            Allowed topics (one per line, optional)
          </Label>
          <Textarea
            rows={2}
            className="text-xs"
            value={g.allowedTopics ?? ""}
            onChange={(e) => patch({ allowedTopics: e.target.value })}
            placeholder={"customer support\nproduct info"}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            Restricted topics (one per line, optional)
          </Label>
          <Textarea
            rows={2}
            className="text-xs"
            value={g.topicRestrictions ?? ""}
            onChange={(e) => patch({ topicRestrictions: e.target.value })}
            placeholder={"politics\nmedical advice"}
          />
        </div>

        {active && (
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-destructive underline"
            onClick={() => onChange({ guardrails: undefined })}
          >
            Clear all node-level guardrails (inherit agent's only)
          </button>
        )}
      </div>
    </Section>
  );
}

function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-[11px] text-muted-foreground mb-1.5 block">{label}</Label>
      {children}
    </div>
  );
}

// ───────────────────── Approval routing (IAM users + groups) ─────────────────
// Choose which IAM users and/or groups should be notified and can decide this
// approval. When at least one is chosen, those approvers receive an email +
// the in-app approvals bell. The person running the swarm is only notified if
// they appear here — by picking themselves, or a group they belong to. With
// nothing chosen, the approval falls back to the runner (legacy behaviour).
function ApproverPicker({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const { user } = useAuth();
  const { directory, loading } = useApproverDirectory(true);
  // Plain inline search + checkbox list (no Popover / cmdk) — the same pattern
  // the MCP-server and SQL-table pickers in this file use. Avoids pulling a
  // combobox dependency into the swarm canvas bundle.
  const [query, setQuery] = useState("");

  const userIds = Array.isArray(data.approverUserIds) ? data.approverUserIds : [];
  const groupIds = Array.isArray(data.approverGroupIds) ? data.approverGroupIds : [];

  const users = directory?.users ?? [];
  const groups = directory?.groups ?? [];
  const userById = new Map(users.map((u) => [u.user_id, u]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const userLabel = (id: string) => {
    const u = userById.get(id);
    return u?.display_name || u?.email || `${id.slice(0, 8)}…`;
  };
  const groupLabel = (id: string) => groupById.get(id)?.name || `${id.slice(0, 8)}…`;

  const toggleUser = (id: string) =>
    onChange({
      approverUserIds: userIds.includes(id) ? userIds.filter((x) => x !== id) : [...userIds, id],
    });
  const toggleGroup = (id: string) =>
    onChange({
      approverGroupIds: groupIds.includes(id)
        ? groupIds.filter((x) => x !== id)
        : [...groupIds, id],
    });

  const meSelected = user ? userIds.includes(user.id) : false;
  const meInSelectedGroup = user
    ? groupIds.some((g) => (groupById.get(g)?.member_user_ids ?? []).includes(user.id))
    : false;
  const runnerNotified = meSelected || meInSelectedGroup;
  const total = userIds.length + groupIds.length;

  const q = query.trim().toLowerCase();
  const filteredGroups = groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  const filteredUsers = users.filter(
    (u) =>
      !q ||
      (u.display_name ?? "").toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q),
  );

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Users className="h-3 w-3 text-primary" />
          Approvers (IAM users &amp; groups)
          {total > 0 && (
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary ml-1">
              {total}
            </Badge>
          )}
        </span>
      }
    >
      <div className="rounded-md border border-border/50 bg-background/40 p-2.5 space-y-2.5">
        {/* Selected chips */}
        {total > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {groupIds.map((id) => (
              <span
                key={`g-${id}`}
                className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300"
              >
                <Users className="h-2.5 w-2.5" /> {groupLabel(id)}
                <button
                  type="button"
                  onClick={() => toggleGroup(id)}
                  className="hover:text-foreground"
                  aria-label="Remove group"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            {userIds.map((id) => (
              <span
                key={`u-${id}`}
                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
              >
                <UserPlus className="h-2.5 w-2.5" /> {userLabel(id)}
                {user && id === user.id && <span className="opacity-70">(you)</span>}
                <button
                  type="button"
                  onClick={() => toggleUser(id)}
                  className="hover:text-foreground"
                  aria-label="Remove user"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            No approvers chosen — the approval goes to you (the runner) only, as before.
          </p>
        )}

        {/* Search + quick "Add me" */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search users or groups…"
              className="h-8 pl-7 text-xs"
            />
          </div>
          {user && !meSelected && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => toggleUser(user.id)}
              title="Add yourself as an approver"
            >
              Add me
            </Button>
          )}
        </div>

        {/* Checkbox list */}
        <div className="max-h-56 overflow-y-auto rounded-md border border-border/40 bg-background/40 p-1 space-y-0.5">
          {loading ? (
            <p className="p-2 text-[10px] text-muted-foreground">Loading directory…</p>
          ) : filteredGroups.length === 0 && filteredUsers.length === 0 ? (
            <p className="p-2 text-[10px] text-muted-foreground">
              {users.length === 0 && groups.length === 0
                ? "No other users or groups found. Create users/groups in Admin → IAM."
                : "No matches."}
            </p>
          ) : (
            <>
              {filteredGroups.length > 0 && (
                <p className="px-1.5 pt-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Groups
                </p>
              )}
              {filteredGroups.map((g) => (
                <label
                  key={g.id}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 cursor-pointer hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-primary"
                    checked={groupIds.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                  />
                  <Users className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                  <span className="flex-1 truncate text-xs">{g.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {g.member_user_ids.length}
                  </span>
                </label>
              ))}
              {filteredUsers.length > 0 && (
                <p className="px-1.5 pt-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  People
                </p>
              )}
              {filteredUsers.map((u) => (
                <label
                  key={u.user_id}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 cursor-pointer hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-primary"
                    checked={userIds.includes(u.user_id)}
                    onChange={() => toggleUser(u.user_id)}
                  />
                  <UserPlus className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="flex-1 truncate text-xs">
                    {u.display_name || u.email || u.user_id.slice(0, 8)}
                    {user && u.user_id === user.id && (
                      <span className="ml-1 text-muted-foreground">(you)</span>
                    )}
                  </span>
                </label>
              ))}
            </>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground leading-relaxed">
          <Mail className="inline h-3 w-3 mr-0.5 -mt-0.5" />
          Chosen approvers get an email (asking them to check AgentSwarms for pending approvals) and
          the in-app bell.{" "}
          {total > 0 &&
            (runnerNotified
              ? "You'll be notified too, because you picked yourself or a group you belong to."
              : "You (the runner) won't be notified — add yourself or a group you're in if you want to be.")}
        </p>
      </div>
    </Section>
  );
}

// ───────────────────── Single-node test / debug ─────────────────────
// Kinds where running the node in isolation (with a test input) is meaningful.
const TESTABLE_KINDS = new Set<SwarmNodeData["kind"]>([
  "agent",
  "http",
  "tool",
  "extract",
  "evaluate",
  "retrieve",
  "foreach",
  "function",
  "a2a_remote",
]);

function NodeTestButton({ node }: { node: Node<SwarmNodeData> }) {
  const [open, setOpen] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setOutput(null);
    setError(null);
    let out = "";
    let err: string | null = null;
    try {
      // Run a one-node swarm with the test input seeded as `input`.
      const solo: Node<SwarmNodeData> = {
        ...node,
        data: { ...node.data, status: "idle", lastOutput: undefined },
      };
      await runSwarm([solo], [], {
        initialInput: testInput,
        onEvent: (e) => {
          if (e.type === "node_done") out = e.output;
          else if (e.type === "node_error") err = e.error;
          else if (e.type === "run_error") err = err ?? e.error;
        },
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    setOutput(out);
    setError(err);
    setRunning(false);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-full text-xs"
        onClick={() => setOpen(true)}
      >
        <Play className="h-3.5 w-3.5 mr-1.5" /> Test this node
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">Test “{node.data.label}”</DialogTitle>
            <DialogDescription className="text-xs">
              Runs just this node in isolation with the input below (seeded as{" "}
              <code className="font-mono">input</code>). References to other flow variables
              won&apos;t be available here.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              rows={4}
              placeholder="Test input for this node…"
              className="text-sm"
              disabled={running}
            />
            <Button onClick={run} disabled={running} size="sm" className="w-full">
              {running ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 mr-1.5" />
              )}
              Run node
            </Button>
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive whitespace-pre-wrap">
                {error}
              </div>
            )}
            {output !== null && !error && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-emerald-400 mb-1">Output</p>
                <div className="max-h-64 overflow-auto rounded-md border border-border bg-background/50 p-2.5 text-xs whitespace-pre-wrap font-mono">
                  {output || <span className="italic text-muted-foreground">(empty)</span>}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ───────────────────── Per-node error handling ─────────────────────
const ERROR_POLICY_KINDS = new Set<SwarmNodeData["kind"]>([
  "agent",
  "loop",
  "foreach",
  "extract",
  "evaluate",
  "http",
  "tool",
  "retrieve",
  "subswarm",
  "a2a_remote",
  "function",
]);
const LLM_TIMEOUT_KINDS = new Set<SwarmNodeData["kind"]>([
  "agent",
  "loop",
  "foreach",
  "extract",
  "evaluate",
  "a2a_remote",
]);

function ErrorPolicySection({
  data,
  onChange,
  showTimeout,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
  showTimeout: boolean;
}) {
  const retries = data.retryCount ?? 0;
  const onErr = data.onError ?? "fail";
  const active = retries > 0 || onErr === "continue" || (data.nodeTimeoutMs ?? 0) > 0;
  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3 text-primary" />
          Error handling
          {active && (
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary ml-1">
              set
            </Badge>
          )}
        </span>
      }
    >
      <div className="rounded-md border border-border/50 bg-background/40 p-2.5 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px] text-muted-foreground mb-1 block">Retries</Label>
            <Input
              type="number"
              min={0}
              max={5}
              value={retries}
              onChange={(e) =>
                onChange({ retryCount: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })
              }
              className="h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground mb-1 block">Retry delay (s)</Label>
            <Input
              type="number"
              min={0}
              max={30}
              value={data.retryDelayMs ? Math.round(data.retryDelayMs / 1000) : 1}
              onChange={(e) =>
                onChange({ retryDelayMs: Math.max(0, Number(e.target.value) || 0) * 1000 })
              }
              className="h-8 text-xs"
              disabled={retries === 0}
            />
          </div>
        </div>
        <div>
          <Label className="text-[10px] text-muted-foreground mb-1 block">On failure</Label>
          <Select
            value={onErr}
            onValueChange={(v) => onChange({ onError: v as "fail" | "continue" })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fail">Fail the run (default)</SelectItem>
              <SelectItem value="continue">Continue with a fallback value</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {onErr === "continue" && (
          <div>
            <Label className="text-[10px] text-muted-foreground mb-1 block">Fallback output</Label>
            <Textarea
              rows={2}
              value={data.errorFallback ?? ""}
              onChange={(e) => onChange({ errorFallback: e.target.value })}
              placeholder="Value written to the output variable if this node keeps failing"
              className="text-xs"
            />
          </div>
        )}
        {showTimeout && (
          <div>
            <Label className="text-[10px] text-muted-foreground mb-1 block">
              Timeout (s, 0 = default 240s)
            </Label>
            <Input
              type="number"
              min={0}
              max={600}
              value={data.nodeTimeoutMs ? Math.round(data.nodeTimeoutMs / 1000) : 0}
              onChange={(e) => {
                const s = Math.max(0, Number(e.target.value) || 0);
                onChange({ nodeTimeoutMs: s > 0 ? s * 1000 : undefined });
              }}
              className="h-8 text-xs"
            />
          </div>
        )}
      </div>
    </Section>
  );
}

// ───────────────────── Input node: typed start form ─────────────────────
type InputFieldT = NonNullable<SwarmNodeData["inputFields"]>[number];

function InputFieldsPanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const fields = data.inputFields ?? [];
  const update = (i: number, patch: Partial<InputFieldT>) =>
    onChange({ inputFields: fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) });
  return (
    <Section label="Start form (typed inputs)">
      <div className="rounded-md border border-border/50 bg-background/40 p-2.5 space-y-2.5">
        <p className="text-[10px] text-muted-foreground">
          Add fields to collect typed inputs in the Run panel. Each value is seeded into flow state
          under its name — reference it anywhere as <code className="font-mono">{"{{name}}"}</code>.
          Leave empty for a single free-text input. A <strong>file</strong> field accepts a PDF,
          DOCX or text document and seeds its extracted TEXT — so downstream nodes read it like any
          other variable.
        </p>
        {fields.map((f, i) => (
          <div key={i} className="rounded-md border border-border/40 p-2 space-y-1.5">
            <div className="flex gap-1.5">
              <Input
                value={f.name}
                onChange={(e) => update(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
                placeholder="name"
                className="w-28 font-mono text-xs"
              />
              <Select
                value={f.type}
                onValueChange={(v) => update(i, { type: v as InputFieldT["type"] })}
              >
                <SelectTrigger className="h-8 flex-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["text", "textarea", "number", "select", "file"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => onChange({ inputFields: fields.filter((_, idx) => idx !== i) })}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
            <Input
              value={f.label ?? ""}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Label (shown to the user)"
              className="text-xs"
            />
            {f.type === "select" && (
              <Input
                value={(f.options ?? []).join(", ")}
                onChange={(e) =>
                  update(i, {
                    options: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Option A, Option B, Option C"
                className="text-xs"
              />
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                className="h-3 w-3 accent-primary"
                checked={!!f.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              Required
            </label>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onChange({
              inputFields: [...fields, { name: `field_${fields.length + 1}`, type: "text" }],
            })
          }
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add field
        </Button>
      </div>
    </Section>
  );
}

// ───────────────────── Execute Swarm (sub-flow) panel ─────────────────────
function SubSwarmPanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const [swarms, setSwarms] = useState<{ id: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    supabase
      .from("swarms")
      .select("id, name")
      .order("updated_at", { ascending: false })
      .then(({ data: rows }) => {
        if (!cancelled) {
          setSwarms(rows ?? []);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <>
      <div className="rounded-md border border-purple-500/30 bg-purple-500/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">🧩 Execute Swarm</p>
        <p className="text-muted-foreground">
          Runs another saved swarm as a single step — its final output becomes this node&apos;s
          output. Great for reusing a sub-pipeline. Runs in isolation (nesting is capped at 3
          levels).
        </p>
      </div>
      <Section label="Swarm to run">
        <Select
          value={data.subSwarmId || "__none__"}
          onValueChange={(v) => onChange({ subSwarmId: v === "__none__" ? null : v })}
        >
          <SelectTrigger>
            <SelectValue placeholder={loaded ? "Pick a swarm" : "Loading…"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {swarms.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground mt-1">
          The gathered input is passed as the sub-swarm&apos;s initial input. Save the sub-swarm
          first so its latest version runs.
        </p>
      </Section>
    </>
  );
}

// ───────────────────── Merge (variable aggregator) panel ─────────────────────
function MergePanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const mode = data.mergeMode || "concat";
  return (
    <>
      <div className="rounded-md border border-slate-400/30 bg-slate-400/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">🔀 Merge (aggregator)</p>
        <p className="text-muted-foreground">
          Combines this node&apos;s <strong>Inputs</strong> (listed below) into one value.
          &quot;First non-empty&quot; is handy after a Condition/Router where only one branch ran.
        </p>
      </div>
      <Section label="Combine strategy">
        <Select value={mode} onValueChange={(v) => onChange({ mergeMode: v as typeof mode })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="concat">Concatenate (text)</SelectItem>
            <SelectItem value="first">First non-empty</SelectItem>
            <SelectItem value="array">JSON array of inputs</SelectItem>
            <SelectItem value="object">JSON object keyed by input name</SelectItem>
          </SelectContent>
        </Select>
      </Section>
      {mode === "concat" && (
        <Section label="Separator">
          <Input
            value={data.mergeSeparator ?? "\\n\\n"}
            onChange={(e) => onChange({ mergeSeparator: e.target.value.replace(/\\n/g, "\n") })}
            placeholder="\n\n"
            className="font-mono text-xs"
          />
        </Section>
      )}
    </>
  );
}

// ───────────────────── Retrieve (KB search) panel ─────────────────────
function RetrievePanel({
  data,
  onChange,
  knowledgeBases,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
  knowledgeBases: { id: string; name: string }[];
}) {
  return (
    <>
      <div className="rounded-md border border-emerald-600/30 bg-emerald-600/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">📚 Retrieve (Knowledge Base)</p>
        <p className="text-muted-foreground">
          Searches a knowledge base directly — no LLM turn. The matching snippets (JSON) are written
          to the output variable for a downstream agent to ground on.
        </p>
      </div>
      <Section label="Knowledge base">
        <Select
          value={data.knowledgeBaseId || "__none__"}
          onValueChange={(v) => onChange({ knowledgeBaseId: v === "__none__" ? null : v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None (required)</SelectItem>
            {knowledgeBases.map((kb) => (
              <SelectItem key={kb.id} value={kb.id}>
                {kb.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Section>
      <Section label="Query">
        <Input
          value={data.retrieveQuery ?? "{{input}}"}
          onChange={(e) => onChange({ retrieveQuery: e.target.value })}
          placeholder="{{input}}"
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Supports <code className="font-mono">{"{{var}}"}</code> templating.
        </p>
      </Section>
      <Section label={`Top K: ${data.retrieveTopK ?? 5}`}>
        <Slider
          value={[data.retrieveTopK ?? 5]}
          min={1}
          max={12}
          step={1}
          onValueChange={([v]) => onChange({ retrieveTopK: v })}
        />
      </Section>
    </>
  );
}

// ───────────────────── Set Variable panel ─────────────────────
function SetVarPanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const rows = data.stateAssignments ?? [];
  const update = (i: number, patch: Partial<{ key: string; value: string }>) =>
    onChange({ stateAssignments: rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) });
  return (
    <>
      <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">🔧 Set Variable</p>
        <p className="text-muted-foreground">
          Writes named keys into the shared <strong>flow state</strong>. Each value is a template —
          use <code className="font-mono">{"{{input}}"}</code>,{" "}
          <code className="font-mono">{"{{other_var}}"}</code>, or a JSON path{" "}
          <code className="font-mono">{"{{var.items[0].name}}"}</code>.
        </p>
      </div>
      <Section label="Assignments">
        {rows.map((r, i) => (
          <div key={i} className="flex gap-1.5 mb-1.5">
            <Input
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
              placeholder="key"
              className="w-28 font-mono text-xs"
            />
            <Input
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder="{{input}}"
              className="flex-1 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => onChange({ stateAssignments: rows.filter((_, idx) => idx !== i) })}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onChange({ stateAssignments: [...rows, { key: "", value: "" }] })}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add assignment
        </Button>
      </Section>
    </>
  );
}

// ───────────────────── HTTP Request panel ─────────────────────
function HttpPanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const method = data.httpMethod || "GET";
  const headers = data.httpHeaders ?? [];
  const updateHeader = (i: number, patch: Partial<{ key: string; value: string }>) =>
    onChange({ httpHeaders: headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)) });
  const hasBody = method !== "GET" && method !== "DELETE";
  return (
    <>
      <div className="rounded-md border border-lime-500/30 bg-lime-500/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">🌐 HTTP Request</p>
        <p className="text-muted-foreground">
          Deterministic call (runs server-side). URL, headers and body support{" "}
          <code className="font-mono">{"{{var}}"}</code> flow-state templating and{" "}
          <code className="font-mono">{"{{secret:NAME}}"}</code> — secrets are resolved on the
          server and never sent to the browser.
        </p>
      </div>
      <Section label="Method & URL">
        <div className="flex gap-1.5">
          <Select
            value={method}
            onValueChange={(v) => onChange({ httpMethod: v as SwarmNodeData["httpMethod"] })}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={data.httpUrl || ""}
            onChange={(e) => onChange({ httpUrl: e.target.value })}
            placeholder="https://api.example.com/{{input}}"
            className="flex-1 font-mono text-xs"
          />
        </div>
      </Section>
      <Section label="Headers">
        {headers.map((h, i) => (
          <div key={i} className="flex gap-1.5 mb-1.5">
            <Input
              value={h.key}
              onChange={(e) => updateHeader(i, { key: e.target.value })}
              placeholder="Authorization"
              className="w-32 font-mono text-xs"
            />
            <Input
              value={h.value}
              onChange={(e) => updateHeader(i, { value: e.target.value })}
              placeholder="Bearer {{secret:MY_KEY}}"
              className="flex-1 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => onChange({ httpHeaders: headers.filter((_, idx) => idx !== i) })}
            >
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onChange({ httpHeaders: [...headers, { key: "", value: "" }] })}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add header
        </Button>
      </Section>
      {hasBody && (
        <Section label="Request body">
          <Textarea
            value={data.httpBody || ""}
            onChange={(e) => onChange({ httpBody: e.target.value })}
            rows={4}
            placeholder={'{"q": "{{input}}"}'}
            className="font-mono text-xs"
          />
        </Section>
      )}
      <Section label="Response JSON path (optional)">
        <Input
          value={data.httpResponsePath || ""}
          onChange={(e) => onChange({ httpResponsePath: e.target.value })}
          placeholder="data.items[0].name"
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Leave empty to store the raw response body. A path drills into a JSON response.
        </p>
      </Section>
      <Section label="Timeout (seconds)">
        <Input
          type="number"
          min={1}
          max={120}
          value={data.httpTimeoutMs ? Math.round(data.httpTimeoutMs / 1000) : 30}
          onChange={(e) =>
            onChange({ httpTimeoutMs: Math.max(1, Number(e.target.value) || 30) * 1000 })
          }
          className="w-28"
        />
      </Section>
    </>
  );
}

// ───────────────────── Tool node panel ─────────────────────
const TOOL_NODE_OPTIONS: {
  id: SwarmToolId;
  label: string;
  args: { key: string; placeholder: string; textarea?: boolean }[];
}[] = [
  { id: "web_search", label: "Web Search", args: [{ key: "query", placeholder: "{{input}}" }] },
  { id: "web_browse", label: "Web Browse", args: [{ key: "url", placeholder: "https://…" }] },
  {
    id: "sql_query",
    label: "SQL Query",
    args: [{ key: "sql", placeholder: "SELECT * FROM my_table LIMIT 10", textarea: true }],
  },
  {
    id: "kb_search",
    label: "Knowledge Base Search",
    args: [{ key: "query", placeholder: "{{input}}" }],
  },
  { id: "calculator", label: "Calculator", args: [{ key: "expression", placeholder: "2*(3+4)" }] },
  {
    id: "datetime",
    label: "Date & Time",
    args: [{ key: "timezone", placeholder: "America/New_York" }],
  },
  { id: "weather", label: "Weather", args: [{ key: "location", placeholder: "Paris" }] },
  {
    id: "mcp_call_tool",
    label: "MCP Tool Call",
    args: [
      { key: "server_name", placeholder: "my-server" },
      { key: "tool_name", placeholder: "search" },
      { key: "arguments", placeholder: '{"key": "{{input}}"}', textarea: true },
    ],
  },
];

function ToolPanel({
  data,
  onChange,
  knowledgeBases,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
  knowledgeBases: { id: string; name: string }[];
}) {
  const toolId = (data.toolId as SwarmToolId) || "web_search";
  const opt = TOOL_NODE_OPTIONS.find((o) => o.id === toolId) ?? TOOL_NODE_OPTIONS[0];
  const args = data.toolArgs ?? {};
  const setArg = (k: string, v: string) => onChange({ toolArgs: { ...args, [k]: v } });
  return (
    <>
      <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">🛠️ Tool (deterministic)</p>
        <p className="text-muted-foreground">
          Runs one built-in tool directly — no LLM turn, no tokens. Argument values accept{" "}
          <code className="font-mono">{"{{var}}"}</code> flow-state templating. The raw tool result
          (JSON) is written to this node&apos;s output variable.
        </p>
      </div>
      <Section label="Tool">
        <Select
          value={toolId}
          onValueChange={(v) => onChange({ toolId: v as SwarmToolId, toolArgs: {} })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TOOL_NODE_OPTIONS.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Section>
      {opt.args.map((arg) => (
        <Section key={arg.key} label={arg.key}>
          {arg.textarea ? (
            <Textarea
              value={args[arg.key] ?? ""}
              onChange={(e) => setArg(arg.key, e.target.value)}
              rows={3}
              placeholder={arg.placeholder}
              className="font-mono text-xs"
            />
          ) : (
            <Input
              value={args[arg.key] ?? ""}
              onChange={(e) => setArg(arg.key, e.target.value)}
              placeholder={arg.placeholder}
              className="font-mono text-xs"
            />
          )}
        </Section>
      ))}
      {toolId === "kb_search" && (
        <Section label="Knowledge base">
          <Select
            value={data.knowledgeBaseId || "__none__"}
            onValueChange={(v) => onChange({ knowledgeBaseId: v === "__none__" ? null : v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None (required for results)</SelectItem>
              {knowledgeBases.map((kb) => (
                <SelectItem key={kb.id} value={kb.id}>
                  {kb.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>
      )}
    </>
  );
}

// ───────────────────── For-Each panel ─────────────────────
function ForEachPanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  return (
    <>
      <div className="rounded-md border border-amber-600/30 bg-amber-600/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">🔁 For Each</p>
        <p className="text-muted-foreground">
          Reads an array from a variable and runs the agent body above{" "}
          <strong>once per element</strong>. Results are collected into this node&apos;s output as a
          JSON array.
        </p>
      </div>
      <Section label="Array source variable">
        <Input
          value={data.foreachInput || ""}
          onChange={(e) => onChange({ foreachInput: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
          placeholder="items (defaults to the first input)"
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Should hold a JSON array. Newline-separated text also works.
        </p>
      </Section>
      <Section label="Item variable name">
        <Input
          value={data.foreachItemVar || "item"}
          onChange={(e) =>
            onChange({ foreachItemVar: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })
          }
          placeholder="item"
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Reference it in the per-item prompt as <code className="font-mono">{"{{item}}"}</code>.{" "}
          <code className="font-mono">{"{{index}}"}</code> is also available.
        </p>
      </Section>
      <Section label={`Max items: ${data.maxIters ?? 25}`}>
        <Slider
          value={[data.maxIters ?? 25]}
          min={1}
          max={100}
          step={1}
          onValueChange={([v]) => onChange({ maxIters: v })}
        />
      </Section>
    </>
  );
}

// ───────────────────── Extract (structured output) panel ─────────────────────
function ExtractPanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const fields = data.extractSchema ?? [];
  const update = (
    i: number,
    patch: Partial<{
      name: string;
      type: "string" | "number" | "boolean" | "array";
      description: string;
    }>,
  ) => onChange({ extractSchema: fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) });
  return (
    <>
      <div className="rounded-md border border-sky-600/30 bg-sky-600/5 p-2.5 text-[11px] leading-relaxed">
        <p className="font-medium text-foreground mb-0.5">🧩 Extract (JSON)</p>
        <p className="text-muted-foreground">
          The model reads the input and returns <strong>only</strong> a JSON object with these
          fields. Reference results downstream with{" "}
          <code className="font-mono">{"{{outputVar.fieldName}}"}</code>.
        </p>
      </div>
      <Section label="Fields to extract">
        {fields.map((f, i) => (
          <div
            key={i}
            className="rounded-md border border-border/50 bg-background/40 p-2 mb-1.5 space-y-1.5"
          >
            <div className="flex gap-1.5">
              <Input
                value={f.name}
                onChange={(e) => update(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
                placeholder="field_name"
                className="flex-1 font-mono text-xs"
              />
              <Select value={f.type} onValueChange={(v) => update(i, { type: v as typeof f.type })}>
                <SelectTrigger className="w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["string", "number", "boolean", "array"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => onChange({ extractSchema: fields.filter((_, idx) => idx !== i) })}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
            <Input
              value={f.description ?? ""}
              onChange={(e) => update(i, { description: e.target.value })}
              placeholder="what to extract for this field"
              className="text-xs"
            />
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() =>
            onChange({ extractSchema: [...fields, { name: "", type: "string", description: "" }] })
          }
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add field
        </Button>
      </Section>
    </>
  );
}

// ───────────────────── A2A Remote Agent panel ─────────────────────
// Real config UI for a node that delegates to a remote A2A-compliant server.
// "Discover" actually fetches the Agent Card via /api/a2a?action=discover.
function A2APanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const card: AgentCard | undefined = data.a2aAgentCard;
  const endpoint = data.a2aEndpoint || "";

  async function handleDiscover() {
    if (!endpoint.trim()) {
      toast.error("Enter the remote agent endpoint URL first");
      return;
    }
    setDiscovering(true);
    setDiscoverError(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const result = await fetchAgentCard({
      endpoint: endpoint.trim(),
      authToken: sessionData.session?.access_token,
    });
    setDiscovering(false);
    if (!result.ok || !result.card) {
      setDiscoverError(result.error || "Discovery failed");
      toast.error(result.error || "Discovery failed");
      return;
    }
    onChange({
      a2aAgentCard: result.card,
      // Reset skill if the previous one isn't on this card
      a2aSkillId: result.card.skills?.find((s) => s.id === data.a2aSkillId)
        ? data.a2aSkillId
        : undefined,
      // Disable streaming if the new card doesn't support it
      a2aStreaming: data.a2aStreaming && !!result.card.capabilities?.streaming,
    });
    toast.success(`Discovered: ${result.card.name}`);
  }

  return (
    <>
      <Section label="Remote A2A endpoint URL">
        <Input
          value={endpoint}
          onChange={(e) => onChange({ a2aEndpoint: e.target.value })}
          placeholder="https://my-agent.example.com"
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          The agent's base URL, or its card URL directly. Discover tries{" "}
          <code className="text-[10px]">/.well-known/agent-card.json</code> then{" "}
          <code className="text-[10px]">/.well-known/agent.json</code>. The server must be reachable
          on the public internet — private and loopback addresses are refused here, so an agent
          running on localhost needs a tunnel.
        </p>
      </Section>

      <Button
        onClick={handleDiscover}
        disabled={discovering || !endpoint.trim()}
        size="sm"
        variant="outline"
        className="w-full h-8"
      >
        {discovering ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Discovering…
          </>
        ) : (
          <>
            <Cloud className="h-3.5 w-3.5 mr-1.5" /> Discover Agent Card
          </>
        )}
      </Button>

      {discoverError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
          <p className="text-[11px] text-destructive">{discoverError}</p>
        </div>
      )}

      {card && (
        <div className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/5 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-fuchsia-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold truncate">{card.name}</p>
              <p className="text-[10px] text-muted-foreground">v{card.version}</p>
              {card.description && (
                <p className="text-[10px] text-muted-foreground mt-1 line-clamp-3">
                  {card.description}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {card.capabilities?.streaming && (
              <Badge
                variant="outline"
                className="text-[9px] border-fuchsia-500/40 text-fuchsia-400"
              >
                streaming
              </Badge>
            )}
            {card.capabilities?.pushNotifications && (
              <Badge variant="outline" className="text-[9px]">
                push
              </Badge>
            )}
            <Badge variant="outline" className="text-[9px]">
              {card.skills?.length ?? 0} skill{card.skills?.length === 1 ? "" : "s"}
            </Badge>
          </div>

          {card.skills && card.skills.length > 0 && (
            <div>
              <Label className="text-[10px] text-muted-foreground mb-1 block">
                Skill (optional)
              </Label>
              <Select
                value={data.a2aSkillId || "__any__"}
                onValueChange={(v) => onChange({ a2aSkillId: v === "__any__" ? undefined : v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Any (let agent decide)</SelectItem>
                  {card.skills.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name || s.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      <Section label="Auth header (optional, sent as Authorization)">
        <Input
          type="password"
          value={data.a2aAuthHeader || ""}
          onChange={(e) => onChange({ a2aAuthHeader: e.target.value })}
          placeholder="Bearer {{secret:MY_AGENT_TOKEN}}"
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Forwarded only to the endpoint above. If you omit "Bearer ", we'll add it. Prefer{" "}
          <code className="font-mono">{"{{secret:NAME}}"}</code> — it resolves on the server at call
          time. A token typed here literally is stored in the swarm graph in plain text.
        </p>
      </Section>

      <div className="flex items-center justify-between rounded-md border border-border/50 bg-background/40 p-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">Stream responses (SSE)</p>
          <p className="text-[10px] text-muted-foreground">
            {card?.capabilities?.streaming
              ? "Use message/stream — tokens appear live in the run panel."
              : card
                ? "Disabled — this agent's card doesn't declare streaming."
                : "Discover the agent first to enable streaming."}
          </p>
        </div>
        <Switch
          checked={!!data.a2aStreaming}
          disabled={!card?.capabilities?.streaming}
          onCheckedChange={(v) => onChange({ a2aStreaming: v })}
        />
      </div>
    </>
  );
}

// ───────────────────── Per-node Memory panel ─────────────────────
// Forwards memory toggles + ltm_scope to /api/chat as `memoryOverrides`.
// STM here means the sliding window + auto-summary applied per conversation.
// LTM scope decides where facts extracted during this run are stored AND
// recalled from:
//   - "agent": share with the linked agent's normal playground sessions
//   - "swarm": isolate to this swarm run only (uses swarm_run_id as key)
//   - "none":  no LTM read/write for this node
function MemorySection({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const m = data.memory ?? {};
  const stmEnabled = m.stm_enabled !== false; // default on
  const ltmEnabled = !!m.ltm_enabled;
  const scope = m.ltm_scope ?? "agent";
  const window = m.stm_window_messages ?? 20;

  function patch(p: Partial<NonNullable<SwarmNodeData["memory"]>>) {
    onChange({ memory: { ...m, ...p } });
  }

  const active = m.stm_enabled === false || ltmEnabled || (m.ltm_scope && m.ltm_scope !== "agent");

  return (
    <Section
      label={
        <span className="flex items-center gap-1.5">
          <Brain className="h-3 w-3 text-primary" />
          Memory
          {active && (
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary ml-1">
              custom
            </Badge>
          )}
        </span>
      }
    >
      <div className="rounded-md border border-border/50 bg-background/40 p-2.5 space-y-3">
        <p className="text-[10px] text-muted-foreground">
          Overrides the linked agent's memory config for this node only. Forwarded to{" "}
          <code className="font-mono">/api/chat</code> as{" "}
          <code className="font-mono">memoryOverrides</code>.
        </p>

        <div className="flex items-center justify-between">
          <div className="min-w-0 pr-2">
            <p className="text-xs font-medium">Short-term memory (STM)</p>
            <p className="text-[10px] text-muted-foreground">
              Sliding window + rolling summary across this conversation.
            </p>
          </div>
          <Switch checked={stmEnabled} onCheckedChange={(v) => patch({ stm_enabled: v })} />
        </div>

        {stmEnabled && (
          <div>
            <Label className="text-[10px] text-muted-foreground mb-1 block">
              Window: last <strong>{window}</strong> messages
            </Label>
            <Slider
              min={4}
              max={50}
              step={2}
              value={[window]}
              onValueChange={(v) => patch({ stm_window_messages: v[0] })}
            />
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border/40 pt-3">
          <div className="min-w-0 pr-2">
            <p className="text-xs font-medium">Long-term memory (LTM)</p>
            <p className="text-[10px] text-muted-foreground">
              Recall + auto-extract durable facts across runs.
            </p>
          </div>
          <Switch checked={ltmEnabled} onCheckedChange={(v) => patch({ ltm_enabled: v })} />
        </div>

        {ltmEnabled && (
          <div>
            <Label className="text-[10px] text-muted-foreground mb-1 block">LTM scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => patch({ ltm_scope: v as "agent" | "swarm" | "none" })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Share with agent (default)</SelectItem>
                <SelectItem value="swarm">Isolate to this swarm run</SelectItem>
                <SelectItem value="none">No LTM (read/write off)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground mt-1">
              <strong>agent</strong> reuses the agent's library. <strong>swarm</strong> keeps facts
              scoped to this run only — useful for ephemeral, isolated experiments.
            </p>
          </div>
        )}

        {active && (
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-destructive underline"
            onClick={() => onChange({ memory: undefined })}
          >
            Clear node-level memory overrides (inherit agent's)
          </button>
        )}
      </div>
    </Section>
  );
}

// ───────────────────── Custom JS Function panel ─────────────────────
// Lets the user author a small JavaScript snippet that runs sandboxed
// (via runSandboxed) when this node executes. Includes a "Test" button
// that runs the code locally against a user-provided JSON sample so the
// user can validate behaviour before saving the swarm.
function FunctionPanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const code =
    data.functionCode ??
    "// ctx.input is the upstream value\n// ctx.vars holds all named upstream outputs\nreturn ctx.input;";
  const timeoutMs = data.functionTimeoutMs ?? 2000;

  const [sample, setSample] = useState<string>('"hello world"');
  const [running, setRunning] = useState(false);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testLogs, setTestLogs] = useState<string[]>([]);

  async function handleTest() {
    setRunning(true);
    setTestError(null);
    setTestOutput(null);
    setTestLogs([]);
    let parsed: unknown = sample;
    try {
      parsed = JSON.parse(sample);
    } catch {
      // Treat as raw string if not valid JSON.
      parsed = sample;
    }
    const result = await runSandboxed(
      code,
      {
        input: parsed,
        vars: {},
        // Same coercion the runtime uses, so a test here means what a run means.
        params: coerceParams(data.componentParams ?? [], data.componentValues ?? {}),
      },
      timeoutMs,
    );
    setRunning(false);
    setTestLogs(result.logs);
    if (result.ok) {
      setTestOutput(safeStringify(result.value));
      toast.success("Function ran successfully");
    } else {
      setTestError(result.error);
      toast.error(result.error);
    }
  }

  const cParams = data.componentParams ?? [];
  const cValues = data.componentValues ?? {};
  const setParam = (name: string, value: string) =>
    onChange({ componentValues: { ...cValues, [name]: value } });

  return (
    <>
      {data.componentId && (
        <Section
          label={
            <span className="flex items-center gap-1.5">
              <Puzzle className="h-3 w-3" /> Component
            </span>
          }
        >
          <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2 space-y-2">
            <p className="text-[11px]">
              <span className="font-medium">{data.componentName}</span>{" "}
              <span className="text-muted-foreground">v{data.componentVersion ?? 1}</span>
            </p>
            <p className="text-[10px] text-muted-foreground">
              This node carries its own copy of the component&rsquo;s code, so editing the library
              later cannot change a swarm that already works. Edit the code below to fork it for
              this node only.
            </p>
            {cParams.length > 0 && (
              <div className="space-y-1.5 pt-0.5">
                {cParams.map((p) => (
                  <div key={p.name} className="space-y-0.5">
                    <label
                      htmlFor={`cp-${p.name}`}
                      className="text-[10px] text-muted-foreground block"
                    >
                      {p.label || p.name}
                      {p.required && <span className="text-destructive"> *</span>}
                    </label>
                    {p.type === "select" ? (
                      <select
                        id={`cp-${p.name}`}
                        value={cValues[p.name] ?? p.default ?? ""}
                        onChange={(e) => setParam(p.name, e.target.value)}
                        className="w-full h-7 rounded-md border border-input bg-background px-2 text-xs"
                      >
                        <option value="">Select…</option>
                        {(p.options ?? []).map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : p.type === "boolean" ? (
                      <label className="flex items-center gap-1.5 text-[11px]">
                        <input
                          id={`cp-${p.name}`}
                          type="checkbox"
                          className="h-3 w-3 accent-primary"
                          checked={(cValues[p.name] ?? p.default) === "true"}
                          onChange={(e) => setParam(p.name, e.target.checked ? "true" : "false")}
                        />
                        enabled
                      </label>
                    ) : (
                      <Input
                        id={`cp-${p.name}`}
                        type={p.type === "number" ? "number" : "text"}
                        value={cValues[p.name] ?? p.default ?? ""}
                        onChange={(e) => setParam(p.name, e.target.value)}
                        className="h-7 text-xs"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}
      <Section
        label={
          <span className="flex items-center gap-1.5">
            <Code2 className="h-3 w-3" /> JavaScript code (sandboxed)
          </span>
        }
      >
        <Textarea
          value={code}
          onChange={(e) => onChange({ functionCode: e.target.value })}
          className="font-mono text-[11px] min-h-[180px] leading-relaxed"
          spellCheck={false}
          placeholder="return ctx.input;"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Receives <code>ctx.input</code> (upstream value) and <code>ctx.vars</code> (named
          outputs). Must <code>return</code> a value. Globals like <code>fetch</code>,{" "}
          <code>window</code>,<code>localStorage</code> are blocked.
        </p>
      </Section>

      <Section label="Timeout (ms)">
        <Input
          type="number"
          min={100}
          max={5000}
          step={100}
          value={timeoutMs}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n))
              onChange({ functionTimeoutMs: Math.max(100, Math.min(5000, Math.round(n))) });
          }}
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Async code is aborted after the timeout. A purely synchronous infinite loop can still
          freeze the tab — keep snippets short and avoid <code>while(true)</code>.
        </p>
      </Section>

      <Section label="Test on sample input (JSON)">
        <Textarea
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          className="font-mono text-[11px] min-h-[60px]"
          spellCheck={false}
          placeholder='"hello" or {"x":1}'
        />
        <Button
          onClick={handleTest}
          disabled={running}
          size="sm"
          variant="outline"
          className="w-full h-8 mt-2"
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Running…
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 mr-1.5" /> Test on sample input
            </>
          )}
        </Button>

        {testOutput !== null && (
          <div className="mt-2 rounded-md border border-border bg-background/50 p-2">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Return value</p>
            <pre className="text-[11px] whitespace-pre-wrap break-words max-h-40 overflow-auto">
              {testOutput}
            </pre>
          </div>
        )}
        {testError && (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
            <p className="text-[11px] text-destructive">{testError}</p>
          </div>
        )}
        {testLogs.length > 0 && (
          <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">console output</p>
            <pre className="text-[11px] whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {testLogs.join("\n")}
            </pre>
          </div>
        )}
      </Section>
    </>
  );
}

// ───────────────────── Evaluate (LLM-as-a-Judge) panel ─────────────────────
function EvaluatePanel({
  data,
  onChange,
}: {
  data: SwarmNodeData;
  onChange: (patch: Partial<SwarmNodeData>) => void;
}) {
  const metrics: EvalMetricConfig[] = data.evalMetrics ?? DEFAULT_EVAL_METRICS;

  function patchMetric(id: string, patch: Partial<EvalMetricConfig>) {
    const updated = metrics.map((m) => (m.id === id ? { ...m, ...patch } : m));
    onChange({ evalMetrics: updated });
  }

  function addCustomMetric() {
    const id = `custom_${Date.now()}`;
    onChange({
      evalMetrics: [
        ...metrics,
        {
          id,
          name: "Custom Metric",
          enabled: true,
          weight: 0.1,
          description: "Describe what this metric should evaluate.",
        },
      ],
    });
  }

  function removeMetric(id: string) {
    onChange({ evalMetrics: metrics.filter((m) => m.id !== id) });
  }

  const totalWeight = metrics.filter((m) => m.enabled).reduce((s, m) => s + m.weight, 0);

  return (
    <>
      <Section label="Evaluation metrics">
        <p className="text-[10px] text-muted-foreground mb-2">
          Toggle metrics on/off and adjust weights. The judge will score each enabled metric 0–1 and
          compute a weighted overall score.
        </p>
        <div className="space-y-2">
          {metrics.map((m) => (
            <div key={m.id} className="rounded-md border border-border p-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Switch
                    checked={m.enabled}
                    onCheckedChange={(v) => patchMetric(m.id, { enabled: v })}
                  />
                  {m.id.startsWith("custom_") ? (
                    <Input
                      value={m.name}
                      onChange={(e) => patchMetric(m.id, { name: e.target.value })}
                      className="h-6 text-xs font-semibold"
                    />
                  ) : (
                    <span
                      className={`text-xs font-semibold ${m.enabled ? "" : "text-muted-foreground"}`}
                    >
                      {m.name}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground w-8 text-right">
                    {(m.weight * 100).toFixed(0)}%
                  </span>
                  {m.id.startsWith("custom_") && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={() => removeMetric(m.id)}
                    >
                      <X className="h-3 w-3 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
              {m.enabled && (
                <>
                  {m.id.startsWith("custom_") && (
                    <Textarea
                      value={m.description}
                      onChange={(e) => patchMetric(m.id, { description: e.target.value })}
                      placeholder="Describe what this metric evaluates…"
                      className="text-xs min-h-[40px]"
                    />
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Weight:</span>
                    <Slider
                      min={0}
                      max={100}
                      step={5}
                      value={[m.weight * 100]}
                      onValueChange={([v]) => patchMetric(m.id, { weight: v / 100 })}
                      className="flex-1"
                    />
                  </div>
                  {!m.id.startsWith("custom_") && (
                    <p className="text-[10px] text-muted-foreground">{m.description}</p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        {Math.abs(totalWeight - 1) > 0.01 && (
          <div className="flex items-start gap-1.5 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
            <span className="text-amber-400 text-xs mt-px">⚠</span>
            <p className="text-[11px] text-amber-400 leading-snug">
              Weights sum to <strong>{(totalWeight * 100).toFixed(0)}%</strong>, not 100%. The
              overall score will be on a different scale — adjust weights to add up to 100% for
              accurate results.
            </p>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full text-xs"
          onClick={addCustomMetric}
        >
          + Add custom metric
        </Button>
      </Section>

      <Section label="Pass threshold">
        <div className="flex items-center gap-3">
          <Slider
            min={0}
            max={100}
            step={5}
            value={[(data.evalPassThreshold ?? 0.7) * 100]}
            onValueChange={([v]) => onChange({ evalPassThreshold: v / 100 })}
            className="flex-1"
          />
          <span className="text-xs font-mono w-10 text-right">
            {((data.evalPassThreshold ?? 0.7) * 100).toFixed(0)}%
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Overall weighted score must reach this threshold for the evaluation to "pass".
        </p>
      </Section>

      <Section label="Reference variable (original question / context)">
        <Input
          value={data.evalReferenceInput || ""}
          onChange={(e) =>
            onChange({ evalReferenceInput: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })
          }
          placeholder="input"
          className="font-mono text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Variable name holding the original question or source context. The judge uses this to
          assess faithfulness and relevancy.
        </p>
      </Section>

      <Section label="Evaluation rubric (optional)">
        <Textarea
          value={data.evalRubric || ""}
          onChange={(e) => onChange({ evalRubric: e.target.value })}
          placeholder="Describe specific criteria, grading standards, or domain-specific expectations…"
          className="min-h-[80px] text-xs"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          A written rubric the judge must follow. Industry best practice: be specific about what
          constitutes a 1.0 vs 0.0 on each axis.
        </p>
      </Section>

      <Section label="Custom instructions for the judge (optional)">
        <Textarea
          value={data.evalCustomInstructions || ""}
          onChange={(e) => onChange({ evalCustomInstructions: e.target.value })}
          placeholder="e.g. 'Be strict about citation accuracy' or 'Penalize any response that mentions competitor products'"
          className="min-h-[60px] text-xs"
        />
      </Section>
    </>
  );
}
