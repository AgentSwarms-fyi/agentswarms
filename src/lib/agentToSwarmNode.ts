// Importing a saved agent into a swarm node, without quietly losing its limits.
//
// MEASURED, which is why this exists. "Import from library" copied the label,
// prompt, provider, model, temperature, primary knowledge base and reranker —
// and silently dropped everything whose job is to RESTRICT:
//
//   · guardrails        — PII policy, blocked patterns, content safety, rate
//                         limit. A real agent on this account carries 18 such
//                         settings; the node it produced carried none.
//   · sql table allow-list — and this one does not fail safe. Per
//                         SwarmToolConfigs, `sql_table_names` empty/undefined
//                         means EVERY table the owner can see. An agent limited
//                         to one table became a node limited to nothing.
//   · metric model allow-list, skills, MCP servers, extra knowledge bases, and
//                         8 of the 11 tool ids, which had no mapping at all.
//
// The node type could already carry all of it — `guardrails`, `toolConfigs`
// and `skillIds` are declared on SwarmNodeData and read by the executor. The
// import simply never populated them, and the shapes differ just enough
// (`toolConfigs.sql_query.table_names` here, flat `sql_table_names` there) to
// explain how that survived review.
//
// The other half is disclosure. Some things genuinely cannot cross — a swarm
// node has no notion of a webhook or a gateway preference — and a copy that
// arrives quietly smaller is worse than one that says what it left behind.
// So this returns what it dropped, and the caller shows it.
//
// Pure and exported so the dialog and the tests read the same function.
import type { SwarmGuardrails, SwarmNodeData, SwarmToolConfigs, SwarmToolId } from "./swarmRuntime";

/** Every tool id a swarm node can run. Mirrors SwarmToolId exactly. */
export const SWARM_TOOL_IDS = [
  "kb_search",
  "kb_graph_search",
  "web_search",
  "web_browse",
  "n8n_run_workflow",
  "mcp_call_tool",
  "calculator",
  "datetime",
  "weather",
  "sql_query",
  "metric_query",
] as const satisfies readonly SwarmToolId[];

const SWARM_TOOL_SET = new Set<string>(SWARM_TOOL_IDS);

/** Older agents wrote `web_browser`; the swarm id is `web_browse`. */
const TOOL_ALIASES: Record<string, SwarmToolId> = { web_browser: "web_browse" };

/** The parts of an agent row this import reads. */
export type ImportableAgentRow = {
  name: string;
  system_prompt?: string | null;
  llm_provider: string;
  llm_model: string;
  temperature: number;
  knowledge_base_id?: string | null;
  tools?: unknown;
};

/** Something the source agent had that the node cannot carry. */
export type DroppedSetting = { what: string; why: string };

export type AgentImport = {
  patch: Partial<SwarmNodeData>;
  dropped: DroppedSetting[];
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];

/**
 * Which of the agent's enabled tools a node can run, and which it cannot.
 *
 * The previous mapping handled three ids by hand and dropped the other eight
 * without a word, so an agent that queried SQL became a node that could not.
 */
export function importableTools(builtInTools: unknown): {
  tools: SwarmToolId[];
  unsupported: string[];
} {
  const flags = obj(builtInTools);
  const tools: SwarmToolId[] = [];
  const unsupported: string[] = [];
  for (const [rawId, on] of Object.entries(flags)) {
    if (on !== true) continue;
    const id = TOOL_ALIASES[rawId] ?? rawId;
    if (SWARM_TOOL_SET.has(id)) {
      if (!tools.includes(id as SwarmToolId)) tools.push(id as SwarmToolId);
    } else {
      unsupported.push(rawId);
    }
  }
  return { tools, unsupported };
}

/**
 * Translate the agent's tool configuration into the node's shape.
 *
 * The two allow-lists are the point of this function. They are stored nested
 * on the agent and flat on the node, and losing either changes what the node
 * may read — in opposite directions, which is why they are handled explicitly
 * rather than spread.
 */
export function importableToolConfigs(tools: unknown): SwarmToolConfigs {
  const t = obj(tools);
  const cfgs = obj(t.toolConfigs);
  const out: SwarmToolConfigs = {};

  const web = obj(cfgs.web_search);
  if (Object.keys(web).length) out.web_search = web as SwarmToolConfigs["web_search"];
  const browse = obj(cfgs.web_browse);
  if (Object.keys(browse).length) out.web_browse = browse as SwarmToolConfigs["web_browse"];

  // ALLOW by default: an absent list means every table, so dropping the
  // agent's list widens what the node may read rather than narrowing it.
  const sqlTables = strings(obj(cfgs.sql_query).table_names);
  if (sqlTables.length) out.sql_table_names = sqlTables;

  // DENY by default: an absent list means no models. Carrying it over is what
  // keeps the tool working, not what keeps it safe.
  const metricModels = strings(obj(cfgs.metric_query).model_names);
  if (metricModels.length) out.metric_model_names = metricModels;

  const mcp = strings(t.mcpServerNames);
  if (mcp.length) out.mcp_server_names = mcp;

  const workflowIds = Object.entries(obj(t.activeWorkflows))
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  if (workflowIds.length) out.n8n_workflow_ids = workflowIds;

  return out;
}

/**
 * Snapshot an agent into a node patch, and say what did not come across.
 *
 * Still a snapshot — the node stays independent of later edits to the agent,
 * which is the existing and deliberate behaviour. What changes is that the
 * snapshot is now faithful about the settings that constrain the agent, and
 * explicit about the ones it cannot represent.
 */
export function agentToNodePatch(agent: ImportableAgentRow): AgentImport {
  const t = obj(agent.tools);
  const dropped: DroppedSetting[] = [];

  const { tools, unsupported } = importableTools(t.builtInTools);
  for (const id of unsupported) {
    dropped.push({ what: `Tool: ${id}`, why: "a swarm node has no equivalent tool" });
  }

  // kb_search is implied by having a knowledge base, the way the agent form
  // implies it — but only add it if the agent did not already list it.
  if (agent.knowledge_base_id && !tools.includes("kb_search")) tools.push("kb_search");

  const kbIds = strings(t.knowledgeBaseIds);
  const primaryKb = agent.knowledge_base_id ?? kbIds[0] ?? null;
  if (kbIds.length > 1) {
    dropped.push({
      what: `${kbIds.length - 1} additional knowledge base${kbIds.length > 2 ? "s" : ""}`,
      why: "a node retrieves from one knowledge base",
    });
  }

  const guardrails = obj(t.guardrails) as SwarmGuardrails;
  const toolConfigs = importableToolConfigs(t);
  const skillIds = strings(t.skillIds);

  if (t.routeThroughGateway === true) {
    dropped.push({
      what: "Route through gateway",
      why: "swarm runs resolve provider credentials per node",
    });
  }
  if (Array.isArray(t.webhooks) && t.webhooks.length > 0) {
    dropped.push({ what: "Webhooks", why: "add an HTTP node to the canvas instead" });
  }

  const reranker = obj(t.reranker);
  const rerankProvider = typeof reranker.provider === "string" ? reranker.provider : "";
  const rerankModel = typeof reranker.model === "string" ? reranker.model : "";

  const patch: Partial<SwarmNodeData> = {
    label: agent.name,
    systemPrompt: agent.system_prompt || "",
    provider: agent.llm_provider,
    model: agent.llm_model,
    temperature: agent.temperature,
    knowledgeBaseId: primaryKb,
    reranker:
      rerankProvider && rerankModel ? { provider: rerankProvider, model: rerankModel } : null,
    enabledTools: tools,
    // The three that were silently missing. Empty objects are written as
    // undefined so a node is never given an empty guardrail set that reads,
    // in the inspector, as "configured and permissive".
    guardrails: Object.keys(guardrails).length ? guardrails : undefined,
    toolConfigs: Object.keys(toolConfigs).length ? toolConfigs : undefined,
    skillIds: skillIds.length ? skillIds : undefined,
    // Snapshot, not a link: later edits to the agent must not reach a swarm
    // that has already been reviewed and deployed.
    agentId: null,
  };

  return { patch, dropped };
}
