import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { allowedProviders, isModelAllowedByRules, useMyModelRules } from "@/hooks/use-iam";
import { useOllamaModels } from "@/hooks/use-ollama-models";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Shield,
  Zap,
  Search,
  Globe,
  Calculator,
  Database,
  Workflow,
  GitBranch,
  Webhook,
  Clock,
  CloudSun,
  BarChart3,
  BrainCircuit,
  Wrench,
  BookOpen,
  Plug,
  Send,
  Brain,
  Trash2,
  Boxes,
} from "lucide-react";
import { ModelRegistryPicker } from "@/components/agents/ModelRegistryPicker";
import { PromptLibraryPicker } from "@/components/prompts/PromptLibraryPicker";
import { SkillPicker } from "@/components/skills/SkillPicker";
import { isImageModelId } from "@/lib/providerSupport";

type BuiltInTool = {
  id: string;
  name: string;
  description: string;
  icon: any;
  category: "search" | "utility" | "automation" | "knowledge" | "data";
  requiresConfig?: boolean;
  // When true, this card is informational only — the capability is enabled
  // automatically by another setting (e.g. linking a knowledge base).
  passive?: boolean;
};

// Curated list — every tool here is fully implemented server-side in
// src/utils/tools/registry.server.ts and surfaced to the LLM via TOOLABLE_IDS.
// Anything cosmetic was intentionally removed: the agent will never advertise
// a capability it cannot actually run.
const BUILT_IN_TOOLS: BuiltInTool[] = [
  // Search & retrieval
  {
    id: "web_search",
    name: "Web Search",
    description:
      "Search the web in real-time. Built-in Firecrawl, or bring your own key (Brave / SerpAPI / Tavily).",
    icon: Search,
    category: "search",
    requiresConfig: true,
  },
  {
    id: "web_browse",
    name: "Web Browser",
    description:
      "Fetch a URL as clean markdown for the agent to read. Built-in Firecrawl or your own (ScrapingBee).",
    icon: Globe,
    category: "search",
    requiresConfig: true,
  },

  // Knowledge — auto-enabled when the agent has a knowledge base linked.
  {
    id: "kb_search",
    name: "Knowledge Base Search",
    description:
      "Search documents in this agent's connected knowledge bases. Auto-enabled when a KB is linked above.",
    icon: BookOpen,
    category: "knowledge",
    passive: true,
  },
  {
    id: "kb_graph_search",
    name: "Knowledge Graph Search",
    description:
      "Multi-hop Graph RAG over the KB's entity relationships. Build the graph in Knowledge → Graph first, then link the KB above.",
    icon: GitBranch,
    category: "knowledge",
  },

  // Data — runs SQL against the user's uploaded CSV tables.
  {
    id: "sql_query",
    name: "SQL Query",
    description:
      "Run read-only SELECT against the user's local CSV-derived tables. Manage datasets in Data & SQL Agents.",
    icon: Database,
    category: "data",
    requiresConfig: true,
  },
  {
    id: "metric_query",
    name: "Semantic Metrics",
    description:
      "Query governed metrics + dimensions defined in the Semantic Layer, so business definitions (revenue, active customers) compute consistently. Define models under Semantic Layer.",
    icon: Database,
    category: "data",
  },

  // Utilities — keyless, real implementations.
  {
    id: "calculator",
    name: "Calculator",
    description:
      "Safe math expression evaluator. Handles arithmetic, percentages, and formulas. No key needed.",
    icon: Calculator,
    category: "utility",
  },
  {
    id: "datetime",
    name: "Date & Time",
    description: "Current date/time in any IANA timezone. No key needed.",
    icon: Clock,
    category: "utility",
  },
  {
    id: "weather",
    name: "Weather",
    description: "Current conditions + 3-day forecast for any place via Open-Meteo. No key needed.",
    icon: CloudSun,
    category: "utility",
  },

  // Automation
  {
    id: "n8n_run_workflow",
    name: "n8n Workflow",
    description:
      "Trigger workflows on the user's connected n8n instance. Configure in the Workflows section below.",
    icon: Workflow,
    category: "automation",
    requiresConfig: true,
  },
  {
    id: "mcp_call_tool",
    name: "MCP Tool",
    description:
      "Invoke tools on connected MCP servers. Toggle on, then pick which servers this agent may call.",
    icon: Plug,
    category: "automation",
    requiresConfig: true,
  },
];

const TOOL_CATEGORIES = [
  { id: "search", label: "Search & Retrieval" },
  { id: "knowledge", label: "Knowledge" },
  { id: "data", label: "Data" },
  { id: "utility", label: "Utilities" },
  { id: "automation", label: "Automation" },
] as const;

type WorkflowProvider = {
  id: string;
  name: string;
  description: string;
  icon: any;
  openSource: boolean;
  fields: { key: string; label: string; placeholder: string; type?: string }[];
};

const WORKFLOW_PROVIDERS: WorkflowProvider[] = [
  {
    id: "n8n",
    name: "n8n",
    description: "Fair-code workflow automation (open source)",
    icon: Workflow,
    openSource: true,
    fields: [
      {
        key: "webhook_url",
        label: "Webhook URL",
        placeholder: "https://n8n.example.com/webhook/...",
      },
      {
        key: "auth_header",
        label: "Auth Header (optional)",
        placeholder: "Bearer ...",
        type: "password",
      },
      // Allow-list of workflow ids the n8n_run_workflow tool may execute. Comma-separated.
      // Empty = the agent may run any workflow on the connected instance. The chat route
      // parses this as `tools.workflows.n8n.workflow_ids` and enforces it server-side.
      {
        key: "workflow_ids",
        label: "Allowed Workflow IDs (comma-separated, optional)",
        placeholder: "wf_abc123, wf_xyz789",
      },
    ],
  },
  {
    id: "activepieces",
    name: "Activepieces",
    description: "MIT-licensed open source automation",
    icon: Workflow,
    openSource: true,
    fields: [
      {
        key: "webhook_url",
        label: "Trigger Webhook URL",
        placeholder: "https://cloud.activepieces.com/api/v1/webhooks/...",
      },
    ],
  },
  {
    id: "node_red",
    name: "Node-RED",
    description: "Flow-based programming for IoT & APIs (open source)",
    icon: GitBranch,
    openSource: true,
    fields: [
      {
        key: "endpoint",
        label: "HTTP-In Endpoint",
        placeholder: "https://nodered.example.com/agent-trigger",
      },
      { key: "auth_token", label: "Auth Token (optional)", placeholder: "...", type: "password" },
    ],
  },
  {
    id: "windmill",
    name: "Windmill",
    description: "Open-source dev platform for scripts & workflows",
    icon: Wrench,
    openSource: true,
    fields: [
      { key: "workspace", label: "Workspace", placeholder: "my-workspace" },
      { key: "script_path", label: "Script/Flow Path", placeholder: "f/folder/my_flow" },
      { key: "token", label: "API Token", placeholder: "...", type: "password" },
      { key: "base_url", label: "Base URL", placeholder: "https://app.windmill.dev" },
    ],
  },
  {
    id: "temporal",
    name: "Temporal",
    description: "Open-source durable workflow orchestration",
    icon: BrainCircuit,
    openSource: true,
    fields: [
      { key: "namespace", label: "Namespace", placeholder: "default" },
      { key: "task_queue", label: "Task Queue", placeholder: "agent-tasks" },
      { key: "workflow_type", label: "Workflow Type", placeholder: "AgentWorkflow" },
      { key: "endpoint", label: "Frontend Address", placeholder: "temporal.example.com:7233" },
    ],
  },
  {
    id: "airflow",
    name: "Apache Airflow",
    description: "Open-source workflow orchestration (DAGs)",
    icon: Workflow,
    openSource: true,
    fields: [
      { key: "base_url", label: "Airflow Base URL", placeholder: "https://airflow.example.com" },
      { key: "dag_id", label: "DAG ID", placeholder: "agent_pipeline" },
      { key: "username", label: "Username", placeholder: "admin" },
      { key: "password", label: "Password", placeholder: "...", type: "password" },
    ],
  },
  {
    id: "huginn",
    name: "Huginn",
    description: "Open-source IFTTT-style agent system",
    icon: Workflow,
    openSource: true,
    fields: [
      {
        key: "webhook_url",
        label: "Agent Webhook URL",
        placeholder: "https://huginn.example.com/users/.../web_requests/...",
      },
      { key: "secret", label: "Secret", placeholder: "...", type: "password" },
    ],
  },
  {
    id: "zapier",
    name: "Zapier",
    description: "Hosted automation (5000+ apps)",
    icon: Webhook,
    openSource: false,
    fields: [
      {
        key: "webhook_url",
        label: "Catch Hook URL",
        placeholder: "https://hooks.zapier.com/hooks/catch/...",
      },
    ],
  },
  {
    id: "make",
    name: "Make (Integromat)",
    description: "Visual automation platform",
    icon: Webhook,
    openSource: false,
    fields: [
      { key: "webhook_url", label: "Webhook URL", placeholder: "https://hook.make.com/..." },
    ],
  },
  {
    id: "custom_webhook",
    name: "Custom Webhook",
    description: "Trigger any HTTP endpoint",
    icon: Webhook,
    openSource: false,
    fields: [
      { key: "url", label: "Endpoint URL", placeholder: "https://api.example.com/trigger" },
      { key: "method", label: "HTTP Method", placeholder: "POST" },
      { key: "headers", label: "Headers (JSON)", placeholder: '{"Authorization": "Bearer ..."}' },
    ],
  },
];

const PROVIDERS = [
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
  { value: "vllm", label: "vLLM (self-hosted)" },
];

const EXTERNAL_PROVIDERS = new Set(["bedrock", "vertex", "azure_openai", "oci_genai", "qwen"]);

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
  vllm: [
    "meta-llama/Meta-Llama-3.1-8B-Instruct",
    "meta-llama/Meta-Llama-3.1-70B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "Qwen/Qwen2.5-7B-Instruct",
    "Qwen/Qwen2.5-72B-Instruct",
    "deepseek-ai/DeepSeek-V2.5",
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
    // openrouter/free is OpenRouter's smart router that picks a free model at
    // random matching the request's required features (tools, vision, JSON).
    // 200K ctx, $0/token. Same /v1/chat/completions endpoint + same API key —
    // the only difference is the model slug.
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

export type Agent = {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  llm_provider: string;
  llm_model: string;
  temperature: number;
  max_tokens: number;
  tools: any;
  n8n_webhook_url: string | null;
  knowledge_base_id: string | null;
  is_active: boolean;
};

type Guardrails = {
  enableInputFilters: boolean;
  enableOutputFilters: boolean;
  blockPII: boolean;
  blockProfanity: boolean;
  maxTurnsPerConversation: number;
  maxInputLength: number;
  rateLimitPerMinute: number;
  topicRestrictions: string;
  allowedTopics: string;
  blockedPatterns: string;
  requireApprovalAboveTokens: number;
  enableCitationCheck: boolean;
  enableHallucinationFilter: boolean;
  contentSafetyLevel: "off" | "low" | "medium" | "high";
  customFilterPrompt: string;
};

const defaultGuardrails: Guardrails = {
  enableInputFilters: false,
  enableOutputFilters: false,
  blockPII: false,
  blockProfanity: false,
  maxTurnsPerConversation: 50,
  maxInputLength: 4000,
  rateLimitPerMinute: 20,
  topicRestrictions: "",
  allowedTopics: "",
  blockedPatterns: "",
  requireApprovalAboveTokens: 0,
  enableCitationCheck: false,
  enableHallucinationFilter: false,
  contentSafetyLevel: "off",
  customFilterPrompt: "",
};

type KnowledgeBase = { id: string; name: string };

// Rerank-capable providers (Cohere/Jina-style POST /rerank) with model
// suggestions; the dropdown filters to connected integrations.
const RERANK_PROVIDERS: { id: string; label: string; models: string[] }[] = [
  { id: "openrouter", label: "OpenRouter", models: ["llama-nemotron-rerank-vl-1b-v2"] },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    models: ["nvidia/llama-3.2-nv-rerankqa-1b-v2", "nvidia/nv-rerankqa-mistral-4b-v3"],
  },
  { id: "vllm", label: "vLLM", models: [] },
  { id: "qwen", label: "Qwen", models: ["gte-rerank"] },
];
type DataTable = { id: string; name: string; is_sample: boolean; columns: unknown };

// Per-agent memory configuration. Backed by the `agent_memory_config` table —
// one row per agent. Defaults match DEFAULT_MEMORY_CONFIG in
// src/utils/memory/types.ts. STM is on by default; LTM is opt-in.
type MemoryConfigForm = {
  stm_enabled: boolean;
  stm_window_messages: number;
  stm_summarize: boolean;
  ltm_enabled: boolean;
  ltm_auto_extract: boolean;
  ltm_max_items: number;
  ltm_recall_top_k: number;
  chat_retention_days: number;
};

const DEFAULT_MEMORY_CONFIG_FORM: MemoryConfigForm = {
  stm_enabled: true,
  stm_window_messages: 20,
  stm_summarize: true,
  ltm_enabled: false,
  ltm_auto_extract: true,
  ltm_max_items: 200,
  ltm_recall_top_k: 5,
  chat_retention_days: 7,
};

type MemoryItemRow = {
  id: string;
  kind: string;
  content: string;
  score: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
};

export function AgentForm({
  agent,
  userId,
  onSaved,
}: {
  agent: Agent | null;
  userId: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(agent?.name || "");
  const [description, setDescription] = useState(agent?.description || "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt || "");
  const [provider, setProvider] = useState(agent?.llm_provider || "openrouter");
  const myModelRules = useMyModelRules();
  // Live model tags from a connected Ollama integration — replaces the
  // static suggestions whenever the user picks the ollama provider.
  const ollamaLive = useOllamaModels(provider === "ollama");
  const [model, setModel] = useState(agent?.llm_model || "google/gemini-3-flash-preview");
  const [temperature, setTemperature] = useState(agent?.temperature || 0.7);
  const [maxTokens, setMaxTokens] = useState(agent?.max_tokens || 4096);
  const [n8nWebhook, setN8nWebhook] = useState(agent?.n8n_webhook_url || "");
  const [useN8n, setUseN8n] = useState(!!agent?.n8n_webhook_url);
  const initialExtraKbs: string[] = Array.isArray((agent?.tools as any)?.knowledgeBaseIds)
    ? ((agent!.tools as any).knowledgeBaseIds as string[])
    : [];
  const initialKbSet = new Set<string>([
    ...(agent?.knowledge_base_id ? [agent.knowledge_base_id] : []),
    ...initialExtraKbs,
  ]);
  const [selectedKbIds, setSelectedKbIds] = useState<Set<string>>(initialKbSet);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  // Optional retrieval re-ranker (tools.reranker): a cross-encoder that
  // reorders retrieved chunks before they reach the model.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initialReranker = ((agent?.tools as any)?.reranker ?? null) as {
    provider?: string;
    model?: string;
  } | null;
  const [rerankProvider, setRerankProvider] = useState<string>(initialReranker?.provider ?? "none");
  const [rerankModel, setRerankModel] = useState<string>(initialReranker?.model ?? "");
  const [rerankCustom, setRerankCustom] = useState(false);
  const [loading, setLoading] = useState(false);

  // Guardrails + Tools state
  const existingTools =
    agent?.tools && typeof agent.tools === "object" && !Array.isArray(agent.tools)
      ? (agent.tools as any)
      : {};
  const [guardrails, setGuardrails] = useState<Guardrails>({
    ...defaultGuardrails,
    ...(existingTools.guardrails || {}),
  });
  const [enabledTools, setEnabledTools] = useState<Record<string, boolean>>(
    existingTools.builtInTools || {},
  );
  const [skillIds, setSkillIds] = useState<string[]>(
    Array.isArray((existingTools as any).skillIds)
      ? ((existingTools as any).skillIds as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : [],
  );
  const [toolConfigs, setToolConfigs] = useState<Record<string, Record<string, string>>>(
    existingTools.toolConfigs || {},
  );
  const [workflowConfigs, setWorkflowConfigs] = useState<Record<string, Record<string, string>>>(
    existingTools.workflows || {},
  );
  const [activeWorkflows, setActiveWorkflows] = useState<Record<string, boolean>>(
    existingTools.activeWorkflows || {},
  );
  // Allow-list of MCP server names the mcp_call_tool may invoke. Empty = any
  // connected MCP server is fair game. Saved on the agent record under
  // `tools.mcpServerNames` and enforced server-side in registry.server.ts.
  const [mcpServerNames, setMcpServerNames] = useState<string[]>(
    Array.isArray(existingTools.mcpServerNames)
      ? existingTools.mcpServerNames.filter((s: any) => typeof s === "string")
      : [],
  );
  const [availableMcpServers, setAvailableMcpServers] = useState<
    Array<{ id: string; name: string; type: string; status: string }>
  >([]);
  const [mcpServersLoaded, setMcpServersLoaded] = useState(false);
  const [routeThroughGateway, setRouteThroughGateway] = useState<boolean>(
    !!existingTools.routeThroughGateway,
  );
  // Visual BI answers: when on, chat answers include an auto-generated data
  // widget (saved under tools.biVisuals so embeds inherit it).
  const [biVisuals, setBiVisuals] = useState<boolean>(!!existingTools.biVisuals);
  const [gatewayConnected, setGatewayConnected] = useState<{
    connected: boolean;
    provider?: string;
    baseUrl?: string;
  }>({ connected: false });
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(
    new Set(["openrouter"]),
  );
  const [providersLoaded, setProvidersLoaded] = useState(false);

  // Data tables — used by the sql_query tool's per-agent allow-list picker.
  // We show every table the user can read (own + public sample) and let
  // them whitelist a subset. Empty selection = the agent sees every table.
  const [availableDataTables, setAvailableDataTables] = useState<DataTable[]>([]);
  const [dataTablesLoaded, setDataTablesLoaded] = useState(false);
  const initialSqlTables: string[] = Array.isArray(
    (existingTools.toolConfigs?.sql_query as { table_names?: unknown } | undefined)?.table_names,
  )
    ? (existingTools.toolConfigs!.sql_query as { table_names: unknown[] }).table_names.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];
  const [sqlTableNames, setSqlTableNames] = useState<string[]>(initialSqlTables);

  // Memory configuration. Loaded from agent_memory_config in the effect below
  // when editing an existing agent; defaults are used for new agents.
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfigForm>(DEFAULT_MEMORY_CONFIG_FORM);
  const [memoryItems, setMemoryItems] = useState<MemoryItemRow[]>([]);
  const [memoryItemsLoading, setMemoryItemsLoading] = useState(false);

  function updateMemory<K extends keyof MemoryConfigForm>(key: K, value: MemoryConfigForm[K]) {
    setMemoryConfig((prev) => ({ ...prev, [key]: value }));
  }

  async function refreshMemoryItems() {
    if (!agent?.id) return;
    setMemoryItemsLoading(true);
    const { data } = await supabase
      .from("agent_memory_items")
      .select("id, kind, content, score, usage_count, last_used_at, created_at")
      .eq("agent_id", agent.id)
      .order("last_used_at", { ascending: false, nullsFirst: false })
      .limit(200);
    if (data) setMemoryItems(data as MemoryItemRow[]);
    setMemoryItemsLoading(false);
  }

  async function deleteMemoryItem(id: string) {
    const { error } = await supabase.from("agent_memory_items").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setMemoryItems((prev) => prev.filter((m) => m.id !== id));
  }

  async function clearAllMemoryItems() {
    if (!agent?.id) return;
    if (!confirm("Delete all remembered items for this agent? This cannot be undone.")) return;
    const { error } = await supabase.from("agent_memory_items").delete().eq("agent_id", agent.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setMemoryItems([]);
    toast.success("Memory cleared");
  }

  useEffect(() => {
    supabase
      .from("knowledge_bases")
      .select("id, name")
      .then(({ data }) => {
        if (data) setKnowledgeBases(data);
      });
    // Discover which providers the user has actually connected, plus
    // whether an LLM Gateway is configured + active.
    (async () => {
      const connected = new Set<string>(["openrouter"]); // always available (operator's shared key)
      const [{ data: creds }, { data: integ }] = await Promise.all([
        supabase.from("provider_credentials").select("provider, is_active"),
        supabase.from("integrations").select("provider, type, is_active, config"),
      ]);
      creds?.forEach((r: any) => {
        if (r.is_active !== false && r.provider) connected.add(r.provider);
      });
      integ
        ?.filter((r: any) => r.type === "llm_provider")
        .forEach((r: any) => {
          if (r.is_active !== false && r.provider) connected.add(r.provider);
        });
      const gw = integ?.find((r: any) => r.type === "llm_gateway" && r.is_active);
      if (gw?.config) {
        setGatewayConnected({
          connected: true,
          provider: (gw.config as any).provider,
          baseUrl: (gw.config as any).base_url,
        });
      }
      setConnectedProviders(connected);
      setProvidersLoaded(true);
    })();

    // Load the user's connected MCP servers so the allow-list shows real
    // options to pick from instead of forcing them to remember server names.
    supabase
      .from("mcp_servers")
      .select("id, name, type, status")
      .eq("status", "connected")
      .order("name", { ascending: true })
      .then(({ data }) => {
        if (data) {
          setAvailableMcpServers(data as any);
          // Only live servers are selectable. Prune anything removed or no
          // longer connected so stale names never render in the picker.
          const validNames = new Set((data as any[]).map((s) => s.name));
          setMcpServerNames((prev) => prev.filter((n) => validNames.has(n)));
        }
        setMcpServersLoaded(true);
      });

    // Load data tables (own + public sample) for the SQL allow-list picker.
    supabase
      .from("user_data_tables")
      .select("id, name, is_sample, columns")
      .order("name", { ascending: true })
      .then(({ data }) => {
        if (data) setAvailableDataTables(data as DataTable[]);
        setDataTablesLoaded(true);
      });

    // Load memory config + items for an existing agent.
    if (agent?.id) {
      (async () => {
        const { data } = await supabase
          .from("agent_memory_config")
          .select("*")
          .eq("agent_id", agent.id)
          .maybeSingle();
        if (data) {
          setMemoryConfig({
            stm_enabled: data.stm_enabled,
            stm_window_messages: data.stm_window_messages,
            stm_summarize: data.stm_summarize,
            ltm_enabled: data.ltm_enabled,
            ltm_auto_extract: data.ltm_auto_extract,
            ltm_max_items: data.ltm_max_items,
            ltm_recall_top_k: data.ltm_recall_top_k,
            chat_retention_days: data.chat_retention_days ?? 7,
          });
        }
        await refreshMemoryItems();
      })();
    }
  }, []);

  function updateGuardrail<K extends keyof Guardrails>(key: K, value: Guardrails[K]) {
    setGuardrails((prev) => ({ ...prev, [key]: value }));
  }
  function toggleTool(id: string, value: boolean) {
    setEnabledTools((prev) => ({ ...prev, [id]: value }));
  }
  function updateToolConfig(toolId: string, key: string, value: string) {
    setToolConfigs((prev) => ({ ...prev, [toolId]: { ...(prev[toolId] || {}), [key]: value } }));
  }
  function updateWorkflowConfig(wfId: string, key: string, value: string) {
    setWorkflowConfigs((prev) => ({ ...prev, [wfId]: { ...(prev[wfId] || {}), [key]: value } }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const kbIds = Array.from(selectedKbIds);
    const primaryKbId = kbIds[0] || null;

    const toolsPayload: any = {
      guardrails,
      builtInTools: enabledTools,
      toolConfigs: {
        ...toolConfigs,
        // SQL allow-list — only persist when the user picked specific tables.
        // Empty array means "all tables", so we drop the key entirely.
        ...(sqlTableNames.length > 0
          ? { sql_query: { ...(toolConfigs.sql_query || {}), table_names: sqlTableNames } }
          : (() => {
              const { sql_query: _omit, ...rest } = toolConfigs as Record<string, unknown>;
              return { ...(rest as typeof toolConfigs) };
            })()),
      },
      workflows: workflowConfigs,
      activeWorkflows,
      // Persist only MCP servers still present in the live picker.
      mcpServerNames: mcpServerNames
        .map((s) => s.trim())
        .filter((s) => s && availableMcpServers.some((srv) => srv.name === s)),
      knowledgeBaseIds: kbIds,
      ...(rerankProvider !== "none" && rerankModel.trim()
        ? { reranker: { provider: rerankProvider, model: rerankModel.trim() } }
        : {}),
      skillIds,
      routeThroughGateway,
      biVisuals,
      webhooks: useN8n && n8nWebhook ? [{ type: "n8n_webhook", url: n8nWebhook }] : [],
    };

    const payload = {
      user_id: userId,
      name,
      description: description || null,
      system_prompt: systemPrompt || null,
      llm_provider: provider,
      llm_model: model,
      temperature,
      max_tokens: maxTokens,
      n8n_webhook_url: useN8n ? n8nWebhook : null,
      knowledge_base_id: primaryKbId,
      tools: toolsPayload,
    };

    try {
      let savedAgentId = agent?.id;
      if (agent) {
        const { error } = await supabase.from("agents").update(payload).eq("id", agent.id);
        if (error) throw error;
      } else {
        const { data: created, error } = await supabase
          .from("agents")
          .insert(payload)
          .select("id")
          .single();
        if (error) throw error;
        savedAgentId = created?.id;
      }
      // Persist memory config (separate table). Best-effort — failure is
      // logged but does not block the agent save.
      if (savedAgentId) {
        const { error: memErr } = await supabase
          .from("agent_memory_config")
          .upsert(
            { agent_id: savedAgentId, user_id: userId, ...memoryConfig },
            { onConflict: "agent_id" },
          );
        if (memErr) console.warn("[memory_config] save failed:", memErr.message);
      }
      toast.success(agent ? "Agent updated" : "Agent created");
      onSaved();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  // IAM model governance: hide providers/models the administrator hasn't
  // allowed for this user (the server enforces the same rules on /api/chat).
  const iamAllowedProviders = allowedProviders(myModelRules);
  const baseModelSuggestions =
    provider === "ollama" && ollamaLive.models.length > 0
      ? ollamaLive.models
      : MODEL_SUGGESTIONS[provider] || [];
  const suggestedModels = baseModelSuggestions.filter((m) =>
    isModelAllowedByRules(myModelRules, provider, m),
  );
  const availableProviders = PROVIDERS.filter(
    (p) => connectedProviders.has(p.value) || p.value === provider,
  ).filter((p) => !iamAllowedProviders || iamAllowedProviders.has(p.value) || p.value === provider);
  const onlyDefaultProvider = providersLoaded && connectedProviders.size === 1;
  const currentProviderConnected = connectedProviders.has(provider);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Tabs defaultValue="general">
        <TabsList className="w-full flex-wrap h-auto">
          <TabsTrigger value="general" className="flex-1">
            General
          </TabsTrigger>
          <TabsTrigger value="model" className="flex-1">
            Model
          </TabsTrigger>
          <TabsTrigger value="knowledge" className="flex-1">
            <BookOpen className="h-3 w-3 mr-1" /> Knowledge
          </TabsTrigger>
          <TabsTrigger value="memory" className="flex-1">
            <Brain className="h-3 w-3 mr-1" /> Memory
          </TabsTrigger>
          <TabsTrigger value="guardrails" className="flex-1">
            <Shield className="h-3 w-3 mr-1" /> Guardrails
          </TabsTrigger>
          <TabsTrigger value="tools" className="flex-1">
            Tools
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label>Name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="My Agent"
            />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A helpful assistant for..."
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>System Prompt</Label>
              <PromptLibraryPicker
                onPick={(p) => {
                  setSystemPrompt(p.content);
                  toast.success(`Loaded "${p.title}" from Prompt Library`);
                }}
              />
            </div>
            <Textarea
              rows={5}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant that..."
            />
            <p className="text-xs text-muted-foreground">
              Define the agent's personality, capabilities, and constraints — or pick a
              battle-tested prompt from the Library above.
            </p>
            <div className="mt-6 border-t border-border/60 pt-4">
              <SkillPicker value={skillIds} onChange={setSkillIds} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="model" className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label>LLM Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v);
                setModel(
                  (v === "ollama" && ollamaLive.models[0]) || MODEL_SUGGESTIONS[v]?.[0] || "",
                );
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableProviders.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                    {!connectedProviders.has(p.value) ? " (not connected)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {onlyDefaultProvider && (
              <p className="text-xs text-muted-foreground">
                Using the server's default OpenRouter key.{" "}
                <a
                  href="/integrations"
                  className="underline text-primary"
                  target="_blank"
                  rel="noreferrer"
                >
                  Connect your own provider
                </a>{" "}
                to use your own account/billing.
              </p>
            )}
          </div>
          {EXTERNAL_PROVIDERS.has(provider) && !currentProviderConnected && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-1">
              <p className="font-medium text-destructive flex items-center gap-1">
                <Shield className="h-3 w-3" /> Provider not connected
              </p>
              <p className="text-muted-foreground">
                Add credentials in{" "}
                <a
                  href="/integrations"
                  className="underline text-primary"
                  target="_blank"
                  rel="noreferrer"
                >
                  Integrations
                </a>{" "}
                before this agent can run.
              </p>
            </div>
          )}
          {EXTERNAL_PROVIDERS.has(provider) && currentProviderConnected && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs space-y-1">
              <p className="font-medium text-primary flex items-center gap-1">
                <Shield className="h-3 w-3" /> Using your own credentials
              </p>
              <p className="text-muted-foreground">
                Calls go to your account. Credentials are encrypted at rest and never exposed in
                exports.
              </p>
            </div>
          )}

          {/* Per-agent LLM Gateway opt-in. The toggle stores
              tools.routeThroughGateway = true on the agent record; chat.ts
              reads that flag at request time and overrides base_url + api_key. */}
          <div
            className={`rounded-md border p-3 text-xs space-y-2 ${gatewayConnected.connected ? "border-border/60 bg-muted/30" : "border-dashed border-border/60 bg-muted/10"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <Workflow className="h-3 w-3 text-primary" /> Route through LLM Gateway
                </Label>
                <p className="text-muted-foreground mt-0.5">
                  {gatewayConnected.connected
                    ? `When on, this agent's calls go through your ${gatewayConnected.provider || "configured"} gateway instead of the upstream API.`
                    : "Configure a gateway in Integrations → LLM Gateway first."}
                </p>
                {gatewayConnected.connected && gatewayConnected.baseUrl && (
                  <p className="text-muted-foreground mt-0.5 font-mono truncate">
                    → {gatewayConnected.baseUrl}
                  </p>
                )}
              </div>
              <Switch
                checked={routeThroughGateway && gatewayConnected.connected}
                disabled={!gatewayConnected.connected}
                onCheckedChange={setRouteThroughGateway}
              />
            </div>
            {!gatewayConnected.connected && (
              <a
                href="/integrations"
                target="_blank"
                rel="noreferrer"
                className="underline text-primary text-xs"
              >
                Open Integrations →
              </a>
            )}
          </div>

          {/* Visual BI answers — saved under tools.biVisuals so the chat
              playground AND embeds render a data widget alongside answers. */}
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-xs font-medium flex items-center gap-1">
                  <BarChart3 className="h-3 w-3 text-primary" /> Visual BI answers
                </Label>
                <p className="text-muted-foreground mt-0.5">
                  When on, answers include an auto-generated chart from your connected data (shown
                  in chat and in embeds of this agent).
                </p>
              </div>
              <Switch checked={biVisuals} onCheckedChange={setBiVisuals} />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Model</Label>
              <ModelRegistryPicker
                defaultModality="text"
                onPick={(id) => setModel(id)}
                trigger={
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs">
                    <Boxes className="h-3 w-3 mr-1" /> Browse registry
                  </Button>
                }
              />
            </div>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model-name"
            />
            {suggestedModels.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {suggestedModels.map((m) => (
                  <Badge
                    key={m}
                    variant={model === m ? "default" : "outline"}
                    className="cursor-pointer text-xs gap-1"
                    onClick={() => setModel(m)}
                    title={isImageModelId(m) ? "Image-generation model" : undefined}
                  >
                    {m}
                    {isImageModelId(m) && (
                      <span className="rounded-sm border border-primary/40 bg-primary/10 px-1 py-0 text-[9px] uppercase tracking-wider text-primary">
                        Image
                      </span>
                    )}
                  </Badge>
                ))}
              </div>
            )}
            {isImageModelId(model) && (
              <p className="text-[11px] text-muted-foreground bg-primary/5 border border-primary/20 rounded px-2 py-1.5">
                <strong className="text-primary">Image model.</strong> Replies are images rendered
                inline with a Download button. Inputs accept text prompts and optional image
                attachments for editing.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Temperature: {temperature}</Label>
            <Slider
              min={0}
              max={2}
              step={0.05}
              value={[temperature]}
              onValueChange={([v]) => setTemperature(v)}
            />
            <p className="text-xs text-muted-foreground">
              Lower = more deterministic, higher = more creative.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Max Tokens</Label>
              <Input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                min={1}
                max={128000}
              />
            </div>
            <div className="space-y-2">
              <Label>Top-P (Nucleus Sampling)</Label>
              <Input type="number" defaultValue={1} min={0} max={1} step={0.05} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Frequency Penalty</Label>
              <Input type="number" defaultValue={0} min={-2} max={2} step={0.1} />
            </div>
            <div className="space-y-2">
              <Label>Presence Penalty</Label>
              <Input type="number" defaultValue={0} min={-2} max={2} step={0.1} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Stop Sequences</Label>
            <Input placeholder="e.g. \n\n, END, ###  (comma-separated)" />
            <p className="text-xs text-muted-foreground">
              Sequences where the model will stop generating.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="knowledge" className="space-y-4 mt-4">
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-primary" /> Retrieval Re-ranker
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Optional second-stage ranking: retrieval over-fetches candidate chunks (3x) and a
                cross-encoder model reorders them by true relevance before they reach the agent.
                Applies to auto-RAG and the kb_search tool. If the re-rank call fails, the original
                similarity order is kept.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Provider</Label>
                  <Select
                    value={rerankProvider}
                    onValueChange={(v) => {
                      setRerankProvider(v);
                      setRerankCustom(false);
                      const first = RERANK_PROVIDERS.find((r) => r.id === v)?.models[0];
                      setRerankModel(first ?? "");
                    }}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (similarity order)</SelectItem>
                      {RERANK_PROVIDERS.filter(
                        (r) => connectedProviders.has(r.id) || r.id === rerankProvider,
                      ).map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
                          {!connectedProviders.has(r.id) ? " (not connected)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">
                    Only connected integrations with a rerank API are listed.
                  </p>
                </div>
                {rerankProvider !== "none" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Re-rank model</Label>
                    {(() => {
                      const suggestions =
                        RERANK_PROVIDERS.find((r) => r.id === rerankProvider)?.models ?? [];
                      const useCustom =
                        rerankCustom ||
                        suggestions.length === 0 ||
                        (rerankModel !== "" && !suggestions.includes(rerankModel));
                      return (
                        <>
                          {suggestions.length > 0 && (
                            <Select
                              value={useCustom ? "__custom__" : rerankModel || suggestions[0]}
                              onValueChange={(v) => {
                                if (v === "__custom__") {
                                  setRerankCustom(true);
                                } else {
                                  setRerankCustom(false);
                                  setRerankModel(v);
                                }
                              }}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {suggestions.map((m) => (
                                  <SelectItem key={m} value={m}>
                                    {m}
                                  </SelectItem>
                                ))}
                                <SelectItem value="__custom__">Custom model name…</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                          {useCustom && (
                            <Input
                              value={rerankModel}
                              onChange={(e) => setRerankModel(e.target.value)}
                              placeholder="llama-nemotron-rerank-vl-1b-v2"
                              className="h-9"
                            />
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
              {rerankProvider !== "none" && !rerankModel.trim() && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Enter a model name — the re-ranker is skipped until both are set.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-primary" /> Knowledge Base Collections
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Select one or more collections to ground the agent's responses (RAG). The first
                selected collection acts as the primary; additional ones are queried alongside it.
              </p>
              {knowledgeBases.length === 0 ? (
                <div className="rounded-md border border-dashed border-border/60 p-4 text-center text-sm text-muted-foreground">
                  No knowledge bases yet.{" "}
                  <a
                    href="/knowledge"
                    className="underline text-primary"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create a collection
                  </a>{" "}
                  to attach it here.
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {knowledgeBases.map((kb) => {
                    const checked = selectedKbIds.has(kb.id);
                    return (
                      <Card
                        key={kb.id}
                        className={`border-border/50 cursor-pointer transition-colors ${checked ? "ring-1 ring-primary/40 bg-primary/5" : ""}`}
                        onClick={() => {
                          setSelectedKbIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(kb.id)) next.delete(kb.id);
                            else next.add(kb.id);
                            return next;
                          });
                        }}
                      >
                        <CardContent className="p-3 flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2 min-w-0">
                            <Database className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                            <p className="text-sm font-medium truncate">{kb.name}</p>
                          </div>
                          <Switch
                            checked={checked}
                            onCheckedChange={(v) => {
                              setSelectedKbIds((prev) => {
                                const next = new Set(prev);
                                if (v) next.add(kb.id);
                                else next.delete(kb.id);
                                return next;
                              });
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
              <div className="flex items-center justify-between pt-2 border-t border-border/40">
                <p className="text-xs text-muted-foreground">
                  {selectedKbIds.size} collection{selectedKbIds.size === 1 ? "" : "s"} selected
                </p>
                {selectedKbIds.size > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedKbIds(new Set())}
                  >
                    Clear all
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="memory" className="space-y-4 mt-4">
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs leading-relaxed">
            <p className="font-medium text-foreground mb-1 flex items-center gap-1.5">
              <Brain className="h-3.5 w-3.5 text-primary" /> Two-tier memory
            </p>
            <p className="text-muted-foreground">
              <strong>Short-term</strong> keeps the live conversation coherent — last N messages
              plus a rolling summary of older turns. <strong>Long-term</strong> remembers facts
              across sessions: extracted automatically after each turn, recalled by keyword match on
              the next user prompt.
            </p>
          </div>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Brain className="h-4 w-4 text-primary" /> Short-term memory (this conversation)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Enable short-term memory</Label>
                  <p className="text-xs text-muted-foreground">
                    Send recent turns + a rolling summary to the model.
                  </p>
                </div>
                <Switch
                  checked={memoryConfig.stm_enabled}
                  onCheckedChange={(v) => updateMemory("stm_enabled", v)}
                />
              </div>
              <div className="space-y-2">
                <Label>Sliding window: last {memoryConfig.stm_window_messages} messages</Label>
                <Slider
                  min={4}
                  max={60}
                  step={2}
                  value={[memoryConfig.stm_window_messages]}
                  onValueChange={([v]) => updateMemory("stm_window_messages", v)}
                  disabled={!memoryConfig.stm_enabled}
                />
                <p className="text-xs text-muted-foreground">
                  Older messages are folded into the rolling summary.
                </p>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Auto-summarize older turns</Label>
                  <p className="text-xs text-muted-foreground">
                    Compress overflow into a single summary block.
                  </p>
                </div>
                <Switch
                  checked={memoryConfig.stm_summarize}
                  onCheckedChange={(v) => updateMemory("stm_summarize", v)}
                  disabled={!memoryConfig.stm_enabled}
                />
              </div>
              <div className="space-y-2 border-t border-border/40 pt-3">
                <Label>Chat history retention</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={7}
                    max={3650}
                    className="w-28"
                    value={memoryConfig.chat_retention_days}
                    onChange={(e) =>
                      updateMemory(
                        "chat_retention_days",
                        Math.max(7, Math.min(3650, Math.round(Number(e.target.value) || 7))),
                      )
                    }
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Conversations with this agent — and any PowerPoint / Word / Excel files generated
                  in them — are kept for this long, then automatically deleted. Minimum 7 days.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BrainCircuit className="h-4 w-4 text-primary" /> Long-term memory (across sessions)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Enable long-term memory</Label>
                  <p className="text-xs text-muted-foreground">
                    Persist facts/preferences and recall them in future chats.
                  </p>
                </div>
                <Switch
                  checked={memoryConfig.ltm_enabled}
                  onCheckedChange={(v) => updateMemory("ltm_enabled", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Auto-extract after each turn</Label>
                  <p className="text-xs text-muted-foreground">
                    Use a small model to identify items worth remembering.
                  </p>
                </div>
                <Switch
                  checked={memoryConfig.ltm_auto_extract}
                  onCheckedChange={(v) => updateMemory("ltm_auto_extract", v)}
                  disabled={!memoryConfig.ltm_enabled}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Recall top-K</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={memoryConfig.ltm_recall_top_k}
                    onChange={(e) =>
                      updateMemory(
                        "ltm_recall_top_k",
                        Math.max(1, Math.min(12, Number(e.target.value) || 5)),
                      )
                    }
                    disabled={!memoryConfig.ltm_enabled}
                  />
                  <p className="text-xs text-muted-foreground">Items injected per request.</p>
                </div>
                <div className="space-y-2">
                  <Label>Max stored items</Label>
                  <Input
                    type="number"
                    min={20}
                    max={2000}
                    value={memoryConfig.ltm_max_items}
                    onChange={(e) =>
                      updateMemory(
                        "ltm_max_items",
                        Math.max(20, Math.min(2000, Number(e.target.value) || 200)),
                      )
                    }
                    disabled={!memoryConfig.ltm_enabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    Oldest low-score items pruned on overflow.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {agent?.id && (
            <Card className="border-border/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Database className="h-4 w-4 text-primary" /> What this agent remembers
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={refreshMemoryItems}>
                      Refresh
                    </Button>
                    {memoryItems.length > 0 && (
                      <Button type="button" variant="ghost" size="sm" onClick={clearAllMemoryItems}>
                        Clear all
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {memoryItemsLoading ? (
                  <p className="text-xs text-muted-foreground">Loading…</p>
                ) : memoryItems.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nothing remembered yet. With long-term memory enabled, items appear here after
                    the agent has chatted with users.
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto space-y-1.5">
                    {memoryItems.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-2"
                      >
                        <Badge variant="outline" className="text-[9px] shrink-0 mt-0.5 font-mono">
                          {m.kind}
                        </Badge>
                        <p className="text-xs flex-1 min-w-0 break-words">{m.content}</p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() => deleteMemoryItem(m.id)}
                          title="Delete this memory"
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="guardrails" className="space-y-4 mt-4">
          {/* Honesty banner — distinguishes server-enforced fields from
              fields the UI saves but does not yet act on. Updated when
              src/utils/guardrails.ts gains coverage. */}
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs leading-relaxed">
            <p className="font-medium text-foreground mb-1 flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-primary" /> Guardrails are enforced server-side
            </p>
            <p className="text-muted-foreground">
              Settings on this tab are evaluated by <code className="font-mono">/api/chat</code> on
              every request. Inputs that violate them get a{" "}
              <code className="font-mono">422 GUARDRAIL_INPUT_BLOCKED</code> response; outputs are
              redacted or replaced before reaching the client.
              <span className="block mt-1.5">
                <span className="text-foreground font-medium">Active enforcement: </span>
                Content safety, PII redaction, profanity, max input length, blocked input regex,
                allowed/restricted topics, citation check, hallucination heuristic.
              </span>
              <span className="block mt-1">
                <span className="text-foreground font-medium">Saved but not yet enforced: </span>
                Rate limit (req/min), max turns/conversation, require-approval-above-tokens, custom
                output filter prompt — these persist on the agent so future enforcement can read
                them, but currently take no action.
              </span>
            </p>
          </div>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" /> Content Safety
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>Safety Level</Label>
                <Select
                  value={guardrails.contentSafetyLevel}
                  onValueChange={(v: any) => updateGuardrail("contentSafetyLevel", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="low">Low — Block explicit harmful content</SelectItem>
                    <SelectItem value="medium">
                      Medium — Block harmful + sensitive content
                    </SelectItem>
                    <SelectItem value="high">High — Strict filtering on all content</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Block PII (Emails, SSN, Phone)</Label>
                  <p className="text-xs text-muted-foreground">
                    Redact personally identifiable information
                  </p>
                </div>
                <Switch
                  checked={guardrails.blockPII}
                  onCheckedChange={(v) => updateGuardrail("blockPII", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Block Profanity</Label>
                  <p className="text-xs text-muted-foreground">Filter profane language in output</p>
                </div>
                <Switch
                  checked={guardrails.blockProfanity}
                  onCheckedChange={(v) => updateGuardrail("blockProfanity", v)}
                />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Input Guardrails</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Enable Input Filtering</Label>
                <Switch
                  checked={guardrails.enableInputFilters}
                  onCheckedChange={(v) => updateGuardrail("enableInputFilters", v)}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Input Length (characters)</Label>
                <Input
                  type="number"
                  value={guardrails.maxInputLength}
                  onChange={(e) => updateGuardrail("maxInputLength", Number(e.target.value))}
                  min={100}
                  max={100000}
                />
              </div>
              <div className="space-y-2">
                <Label>Blocked Input Patterns (regex, one per line)</Label>
                <Textarea
                  rows={3}
                  value={guardrails.blockedPatterns}
                  onChange={(e) => updateGuardrail("blockedPatterns", e.target.value)}
                  placeholder={"ignore previous instructions\nact as.*DAN\njailbreak"}
                />
                <p className="text-xs text-muted-foreground">
                  Regex patterns to reject from user input (prompt injection defense).
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Output Guardrails</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Enable Output Filtering</Label>
                <Switch
                  checked={guardrails.enableOutputFilters}
                  onCheckedChange={(v) => updateGuardrail("enableOutputFilters", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Hallucination Detection</Label>
                  <p className="text-xs text-muted-foreground">
                    Flag responses not grounded in provided context
                  </p>
                </div>
                <Switch
                  checked={guardrails.enableHallucinationFilter}
                  onCheckedChange={(v) => updateGuardrail("enableHallucinationFilter", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Citation Check</Label>
                  <p className="text-xs text-muted-foreground">
                    Require citations from knowledge base
                  </p>
                </div>
                <Switch
                  checked={guardrails.enableCitationCheck}
                  onCheckedChange={(v) => updateGuardrail("enableCitationCheck", v)}
                />
              </div>
              <div className="space-y-2">
                <Label>Custom Output Filter Prompt</Label>
                <Textarea
                  rows={3}
                  value={guardrails.customFilterPrompt}
                  onChange={(e) => updateGuardrail("customFilterPrompt", e.target.value)}
                  placeholder="Check the response for accuracy and..."
                />
                <p className="text-xs text-muted-foreground">
                  A prompt passed to a filter LLM to evaluate responses before delivery.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Rate Limiting & Boundaries</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Max Turns / Conversation</Label>
                  <Input
                    type="number"
                    value={guardrails.maxTurnsPerConversation}
                    onChange={(e) =>
                      updateGuardrail("maxTurnsPerConversation", Number(e.target.value))
                    }
                    min={1}
                    max={500}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Rate Limit (req/min)</Label>
                  <Input
                    type="number"
                    value={guardrails.rateLimitPerMinute}
                    onChange={(e) => updateGuardrail("rateLimitPerMinute", Number(e.target.value))}
                    min={1}
                    max={1000}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Require Approval Above (tokens)</Label>
                <Input
                  type="number"
                  value={guardrails.requireApprovalAboveTokens}
                  onChange={(e) =>
                    updateGuardrail("requireApprovalAboveTokens", Number(e.target.value))
                  }
                  min={0}
                />
                <p className="text-xs text-muted-foreground">
                  0 = disabled. Responses above this token count require human approval.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Topic Boundaries</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>Allowed Topics (one per line)</Label>
                <Textarea
                  rows={3}
                  value={guardrails.allowedTopics}
                  onChange={(e) => updateGuardrail("allowedTopics", e.target.value)}
                  placeholder={"customer support\nproduct information\ntechnical help"}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to allow all topics. Agent will decline off-topic requests.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Restricted Topics (one per line)</Label>
                <Textarea
                  rows={3}
                  value={guardrails.topicRestrictions}
                  onChange={(e) => updateGuardrail("topicRestrictions", e.target.value)}
                  placeholder={"politics\nmedical advice\nlegal advice"}
                />
                <p className="text-xs text-muted-foreground">
                  Topics the agent must refuse to discuss.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tools" className="space-y-6 mt-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-primary" /> Built-in Tools
                </h3>
                <p className="text-xs text-muted-foreground">
                  Toggle capabilities the agent can invoke. Configure credentials per-tool where
                  required.
                </p>
              </div>
              <Badge variant="outline" className="text-xs">
                {Object.values(enabledTools).filter(Boolean).length} enabled
              </Badge>
            </div>

            {TOOL_CATEGORIES.map((cat) => {
              const tools = BUILT_IN_TOOLS.filter((t) => t.category === cat.id);
              if (tools.length === 0) return null;
              return (
                <div key={cat.id} className="mt-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    {cat.label}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {tools.map((tool) => {
                      const isEnabled = !!enabledTools[tool.id];
                      return (
                        <Card
                          key={tool.id}
                          className={`border-border/50 ${isEnabled ? "ring-1 ring-primary/40" : ""}`}
                        >
                          <CardContent className="p-3 space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-start gap-2 min-w-0">
                                <tool.icon className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">{tool.name}</p>
                                  <p className="text-xs text-muted-foreground line-clamp-2">
                                    {tool.description}
                                  </p>
                                </div>
                              </div>
                              {tool.passive ? (
                                <Badge variant="outline" className="text-[10px]">
                                  Auto
                                </Badge>
                              ) : (
                                <Switch
                                  checked={isEnabled}
                                  onCheckedChange={(v) => toggleTool(tool.id, v)}
                                />
                              )}
                            </div>
                            {isEnabled && tool.requiresConfig && (
                              <div className="pt-2 border-t border-border/50 space-y-2">
                                {tool.id === "web_search" || tool.id === "web_browse" ? (
                                  <>
                                    <div className="space-y-1">
                                      <Label className="text-xs">Provider</Label>
                                      <Select
                                        value={
                                          toolConfigs[tool.id]?.provider || "firecrawl_builtin"
                                        }
                                        onValueChange={(v) =>
                                          updateToolConfig(tool.id, "provider", v)
                                        }
                                      >
                                        <SelectTrigger className="h-8 text-xs">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="firecrawl_builtin">
                                            Built-in Firecrawl (uses workspace connector)
                                          </SelectItem>
                                          <SelectItem value="firecrawl_custom">
                                            Firecrawl (custom API key)
                                          </SelectItem>
                                          {tool.id === "web_search" && (
                                            <>
                                              <SelectItem value="brave">Brave Search</SelectItem>
                                              <SelectItem value="serpapi">SerpAPI</SelectItem>
                                              <SelectItem value="tavily">Tavily</SelectItem>
                                            </>
                                          )}
                                          {tool.id === "web_browse" && (
                                            <SelectItem value="scrapingbee">ScrapingBee</SelectItem>
                                          )}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    {(toolConfigs[tool.id]?.provider || "firecrawl_builtin") ===
                                    "firecrawl_builtin" ? (
                                      <p className="text-[11px] text-muted-foreground leading-snug">
                                        No key needed. Connect Firecrawl once in{" "}
                                        <span className="font-medium text-foreground">
                                          Connectors
                                        </span>{" "}
                                        and every agent using built-in Firecrawl will share it.
                                      </p>
                                    ) : (
                                      <div className="space-y-1">
                                        <Label className="text-xs">API Key</Label>
                                        <Input
                                          type="password"
                                          className="h-8 text-xs"
                                          placeholder="Paste API key"
                                          value={toolConfigs[tool.id]?.api_key || ""}
                                          onChange={(e) =>
                                            updateToolConfig(tool.id, "api_key", e.target.value)
                                          }
                                        />
                                      </div>
                                    )}
                                  </>
                                ) : tool.id === "sql_query" ? (
                                  <div className="space-y-1">
                                    <Label className="text-xs">Allowed tables</Label>
                                    {!dataTablesLoaded ? (
                                      <p className="text-[11px] text-muted-foreground">
                                        Loading tables…
                                      </p>
                                    ) : availableDataTables.length === 0 ? (
                                      <p className="text-[11px] text-muted-foreground">
                                        No tables yet. Upload a CSV in{" "}
                                        <span className="font-medium text-foreground">
                                          Data &amp; SQL Agents
                                        </span>
                                        .
                                      </p>
                                    ) : (
                                      <>
                                        <div className="max-h-40 overflow-y-auto space-y-1 rounded-md border border-border/50 p-2 bg-background/40">
                                          {availableDataTables.map((t) => {
                                            const checked = sqlTableNames.includes(t.name);
                                            return (
                                              <label
                                                key={t.id}
                                                className="flex items-start gap-2 cursor-pointer text-[11px]"
                                              >
                                                <input
                                                  type="checkbox"
                                                  className="mt-0.5"
                                                  checked={checked}
                                                  onChange={(e) =>
                                                    setSqlTableNames((prev) =>
                                                      e.target.checked
                                                        ? Array.from(new Set([...prev, t.name]))
                                                        : prev.filter((n) => n !== t.name),
                                                    )
                                                  }
                                                />
                                                <span className="font-mono truncate flex-1">
                                                  {t.name}
                                                </span>
                                                {t.is_sample && (
                                                  <Badge variant="outline" className="text-[9px]">
                                                    sample
                                                  </Badge>
                                                )}
                                              </label>
                                            );
                                          })}
                                        </div>
                                        <p className="text-[11px] text-muted-foreground leading-snug">
                                          {sqlTableNames.length === 0
                                            ? "No selection — the agent can query every table you can read."
                                            : `Agent will only see ${sqlTableNames.length} selected table${sqlTableNames.length === 1 ? "" : "s"}.`}
                                        </p>
                                      </>
                                    )}
                                  </div>
                                ) : tool.id === "mcp_call_tool" ? (
                                  <div className="space-y-1.5">
                                    <Label className="text-xs">Allowed MCP servers</Label>
                                    {!mcpServersLoaded ? (
                                      <p className="text-[11px] text-muted-foreground">
                                        Loading connected MCP servers…
                                      </p>
                                    ) : availableMcpServers.length === 0 ? (
                                      <p className="text-[11px] text-muted-foreground">
                                        No MCP servers connected. Add one under{" "}
                                        <a
                                          href="/mcp"
                                          className="text-primary underline underline-offset-2"
                                        >
                                          /mcp
                                        </a>
                                        .
                                      </p>
                                    ) : (
                                      <>
                                        <div className="max-h-44 overflow-y-auto space-y-1 rounded-md border border-border/50 p-2 bg-background/40">
                                          {availableMcpServers.map((srv) => {
                                            const checked = mcpServerNames.includes(srv.name);
                                            const isConnected = srv.status === "connected";
                                            return (
                                              <label
                                                key={srv.id}
                                                className="flex items-center gap-2 cursor-pointer text-[11px] px-1 py-0.5 rounded hover:bg-muted/40"
                                              >
                                                <input
                                                  type="checkbox"
                                                  className="h-3.5 w-3.5 accent-primary"
                                                  checked={checked}
                                                  onChange={(e) =>
                                                    setMcpServerNames((prev) =>
                                                      e.target.checked
                                                        ? Array.from(new Set([...prev, srv.name]))
                                                        : prev.filter((n) => n !== srv.name),
                                                    )
                                                  }
                                                />
                                                <span className="font-medium truncate flex-1">
                                                  {srv.name}
                                                </span>
                                                <span className="text-[10px] text-muted-foreground capitalize shrink-0">
                                                  {srv.type} ·{" "}
                                                  {isConnected ? (
                                                    <span className="text-emerald-500">
                                                      connected
                                                    </span>
                                                  ) : (
                                                    <span>{srv.status}</span>
                                                  )}
                                                </span>
                                              </label>
                                            );
                                          })}
                                        </div>
                                        <p className="text-[11px] text-muted-foreground leading-snug">
                                          {mcpServerNames.length === 0
                                            ? "No selection — any connected server is allowed."
                                            : `Agent may only call ${mcpServerNames.length} selected server${mcpServerNames.length === 1 ? "" : "s"}.`}
                                        </p>
                                      </>
                                    )}
                                  </div>
                                ) : (
                                  <div className="space-y-1">
                                    <Label className="text-xs">API Key / Endpoint</Label>
                                    <Input
                                      type="password"
                                      className="h-8 text-xs"
                                      placeholder="Use Integration Hub or paste here"
                                      value={toolConfigs[tool.id]?.api_key || ""}
                                      onChange={(e) =>
                                        updateToolConfig(tool.id, "api_key", e.target.value)
                                      }
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Workflow className="h-4 w-4 text-primary" /> Workflow & Automation Platforms
                </h3>
                <p className="text-xs text-muted-foreground">
                  Connect open-source and hosted workflow engines. Open-source options are
                  highlighted.
                </p>
              </div>
              <Badge variant="outline" className="text-xs">
                {Object.values(activeWorkflows).filter(Boolean).length} active
              </Badge>
            </div>

            <div className="space-y-2 mt-3">
              {WORKFLOW_PROVIDERS.map((wf) => {
                const isActive = !!activeWorkflows[wf.id];
                return (
                  <Card
                    key={wf.id}
                    className={`border-border/50 ${isActive ? "ring-1 ring-primary/40" : ""}`}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <wf.icon className="h-4 w-4 text-primary shrink-0" />
                          <div className="min-w-0">
                            <CardTitle className="text-sm flex items-center gap-2">
                              {wf.name}
                              {wf.openSource && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] border-primary/40 text-primary"
                                >
                                  Open Source
                                </Badge>
                              )}
                            </CardTitle>
                            <p className="text-xs text-muted-foreground">{wf.description}</p>
                          </div>
                        </div>
                        <Switch
                          checked={isActive}
                          onCheckedChange={(v) =>
                            setActiveWorkflows((prev) => ({ ...prev, [wf.id]: v }))
                          }
                        />
                      </div>
                    </CardHeader>
                    {isActive && (
                      <CardContent className="space-y-2">
                        {wf.fields.map((f) => (
                          <div key={f.key} className="space-y-1">
                            <Label className="text-xs">{f.label}</Label>
                            <Input
                              type={f.type || "text"}
                              className="h-8 text-xs"
                              placeholder={f.placeholder}
                              value={workflowConfigs[wf.id]?.[f.key] || ""}
                              onChange={(e) => updateWorkflowConfig(wf.id, f.key, e.target.value)}
                            />
                          </div>
                        ))}
                      </CardContent>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>

          <Card className="border-border/50 bg-muted/30">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Send className="h-4 w-4 text-primary" /> Quick n8n Webhook (legacy)
                </CardTitle>
                <Switch checked={useN8n} onCheckedChange={setUseN8n} />
              </div>
            </CardHeader>
            {useN8n && (
              <CardContent className="space-y-2">
                <Label>Webhook URL</Label>
                <Input
                  value={n8nWebhook}
                  onChange={(e) => setN8nWebhook(e.target.value)}
                  placeholder="https://n8n.example.com/webhook/..."
                />
                <p className="text-xs text-muted-foreground">
                  Stored on the agent record for backward compatibility.
                </p>
              </CardContent>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Saving..." : agent ? "Update Agent" : "Create Agent"}
      </Button>
    </form>
  );
}
