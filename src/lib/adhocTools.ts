// Ad-hoc (session-scoped) chat tools.
//
// The agent builder saves tool toggles onto the agent row — permanent, every
// chat, every surface. This module is the other duration: "for this chat,
// also let the model search the web", picked from the composer's Tools menu
// and forgotten when the conversation is.
//
// Client-safe on purpose: the playground menu and /api/chat both import from
// here, so the curated list and the merge rule cannot drift apart. Only a
// type is imported from the server registry — erased at build time.
import type { ToolableId } from "@/utils/tools/registry.server";

/**
 * The tools a user may switch on ad hoc, from chat, without touching the
 * agent's saved configuration.
 *
 * Deliberately a curated subset of TOOLABLE_IDS rather than all of it:
 * everything here works with zero per-agent configuration (web_search falls
 * back to DuckDuckGo without a key, weather is Open-Meteo, calculator and
 * datetime are pure) and reads nothing the user cannot already read.
 * kb_search / sql_query / metric_query / memory_* / n8n / mcp stay
 * agent-config-only: they need allow-lists, scoping or wiring that a
 * one-click session toggle would silently skip.
 */
export const ADHOC_SERVER_TOOLS: ReadonlyArray<{
  id: ToolableId;
  label: string;
  description: string;
}> = [
  {
    id: "web_search",
    label: "Web search",
    description:
      "Search the live web and cite sources. Uses Firecrawl if connected, else DuckDuckGo.",
  },
  {
    id: "web_browse",
    label: "Read a web page",
    description:
      "Fetch a specific URL and read it as clean text. Needs Firecrawl (Integrations → Web Search) — without it the model cannot browse and will say so.",
  },
  {
    id: "calculator",
    label: "Calculator",
    description: "Exact arithmetic instead of guessed numbers.",
  },
  {
    id: "datetime",
    label: "Date & time",
    description: "The current date/time, timezone-aware.",
  },
  {
    id: "weather",
    label: "Weather",
    description: "Current conditions + 3-day forecast for any place.",
  },
];

const ADHOC_SERVER_TOOL_IDS = new Set<string>(ADHOC_SERVER_TOOLS.map((t) => t.id));

/**
 * The diagram "tool" is client-side: it never reaches /api/chat as a tool.
 * Arming it appends DIAGRAM_SYSTEM_NOTE to the system prompt so the model
 * answers diagram-shaped questions with a mermaid fence, which the message
 * renderer draws inline (with SVG/PNG download).
 */
export const DIAGRAM_TOOL_ID = "diagram" as const;

export const DIAGRAM_SYSTEM_NOTE = [
  "The user has enabled the Diagram tool for this chat.",
  "When they ask for a diagram, flowchart, architecture sketch, sequence, state machine, ER model, mind map, timeline or Gantt chart, respond with exactly one fenced code block whose language is `mermaid`, containing valid Mermaid syntax — it renders inline in the chat.",
  "Prefer the simplest Mermaid diagram type that fits (flowchart TD, sequenceDiagram, erDiagram, stateDiagram-v2, mindmap, timeline, gantt).",
  "Keep node labels short; put any explanation in prose outside the fence. Do not wrap the fence in extra formatting, and never emit more than one mermaid block per answer unless asked.",
].join(" ");

/**
 * Union a session's ad-hoc tool picks into the allow-list the server resolved
 * from the request/agent.
 *
 * - `extras` is untrusted request input: anything not in the curated ad-hoc
 *   set is dropped, silently — the server's own derivation stays the only way
 *   to enable the configured tools.
 * - With no (valid) extras the base is returned untouched, `undefined`
 *   included: `undefined` means "no allow-list" upstream and turning it into
 *   `[]` would flip the semantics from "derive from agent" to "no tools".
 */
export function mergeExtraTools(
  base: ToolableId[] | undefined,
  extras: unknown,
): ToolableId[] | undefined {
  const valid = Array.isArray(extras)
    ? (extras.filter(
        (t): t is ToolableId => typeof t === "string" && ADHOC_SERVER_TOOL_IDS.has(t),
      ) as ToolableId[])
    : [];
  if (valid.length === 0) return base;
  const out = new Set<ToolableId>(base ?? []);
  for (const t of valid) out.add(t);
  return [...out];
}

/**
 * Which of the ad-hoc-offerable tools this agent already has switched on
 * permanently (agent builder → tools). Used by the menu to label them "on
 * for this agent" instead of offering a toggle that would change nothing.
 *
 * Mirrors the key aliases /api/chat accepts for these five tools
 * (`web_browser` is the legacy spelling of `web_browse`). Display-only: the
 * server derivation remains the authority on what actually runs.
 */
export function agentPermanentAdhocTools(agentTools: unknown): Set<string> {
  const on = new Set<string>();
  if (!agentTools || typeof agentTools !== "object") return on;
  const builtIn = (agentTools as { builtInTools?: unknown }).builtInTools;
  if (!builtIn || typeof builtIn !== "object") return on;
  const t = builtIn as Record<string, unknown>;
  if (t.web_search) on.add("web_search");
  if (t.web_browse || t.web_browser) on.add("web_browse");
  if (t.calculator) on.add("calculator");
  if (t.datetime) on.add("datetime");
  if (t.weather) on.add("weather");
  return on;
}
