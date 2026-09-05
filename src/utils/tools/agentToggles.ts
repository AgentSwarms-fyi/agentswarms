// The one mapping from an agent's saved built-in tool toggles to the tool
// ids the registry resolves. Agent chat derives an agent's tools from it; the
// AI gateway derives a gateway turn's tools from it; anything else that runs
// a saved agent headlessly should too, so a toggle the builder can save is a
// tool the agent gets on every surface, not only the one someone tested.
//
// History, so the shape is not "improved" away: this mapping lived inside the
// chat route and twice omitted a toggle (metric_query, then ml_predict) - the
// builder saved it, agent chat never received it, and the model announced a
// capability it did not have. tests/unit/agentToolToggles pins every builder
// toggle to a line here.
import type { ToolableId } from "@/utils/tools/registry.server";

/**
 * Read the `builtInTools` record off an agent's `tools` JSON. Tolerates the
 * older shapes: a missing record, or non-boolean values.
 */
export function builtInTogglesOf(tools: unknown): Record<string, boolean> {
  const t =
    tools && typeof tools === "object" && !Array.isArray(tools)
      ? (tools as Record<string, unknown>)
      : {};
  const raw = t.builtInTools;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = Boolean(v);
  return out;
}

/**
 * Tool ids an agent's toggles ask for. Returns undefined when no toggle is
 * set at all, which callers treat as "the registry's default set" - the
 * historical meaning of an agent saved before toggles existed.
 */
export function enabledToolsFromToggles(
  t: Record<string, boolean> | null | undefined,
): ToolableId[] | undefined {
  if (!t || Object.keys(t).length === 0) return undefined;
  const out: ToolableId[] = [];
  if (t.web_search) out.push("web_search");
  if (t.web_browse || t.web_browser) out.push("web_browse");
  if (t.kb_search || t.knowledge_base) out.push("kb_search");
  if (t.kb_graph_search || t.knowledge_graph) out.push("kb_graph_search");
  if (t.calculator) out.push("calculator");
  if (t.datetime) out.push("datetime");
  if (t.weather) out.push("weather");
  if (t.sql_query) out.push("sql_query");
  if (t.metric_query) out.push("metric_query");
  if (t.ml_predict) out.push("ml_predict");
  if (t.n8n || t.n8n_run_workflow) out.push("n8n_run_workflow");
  if (t.mcp || t.mcp_call_tool) out.push("mcp_call_tool");
  if (t.send_notification || t.notifications) out.push("send_notification");
  return out.length > 0 ? out : undefined;
}
