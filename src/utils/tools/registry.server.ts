// Server-side tool registry for the agent's tool-calling loop.
//
// We expose four classes of tools to the LLM (via OpenAI-compatible
// function calling):
//
//   1. kb_search          — keyword RAG over the user's knowledge_documents
//   2. web_search         — DuckDuckGo Instant Answer (no key needed)
//   3. n8n_run_workflow   — executes a workflow on the user's connected n8n
//   4. mcp_call_tool      — calls a tool on a connected MCP server (Streamable HTTP)
//
// Each tool runs server-side with the user's auth token / env so we never
// trust the model with raw credentials. All errors are caught and returned
// as JSON strings so the model can read them and recover.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { listDataTablesTool, runListDataTables, runSqlQuery, sqlQueryTool } from "./sql.server";
import { metricQueryTool, runMetricQuery, semanticCatalogForCtx } from "./metric.server";
import { assertPublicUrl, safeFetch } from "@/utils/ssrfGuard.server";
import { resolveMcpAuthToken } from "@/lib/mcp/auth.server";
import { resolveIntegrationConfig } from "@/utils/providers/integrationConfig.server";
import { loadWarehouseConnectionForUser } from "@/utils/warehouse/connections.server";
import { executeWarehouseQuery, listWarehouseTables } from "@/utils/warehouse/drivers.server";
import {
  memoryRememberTool,
  memoryRecallTool,
  memoryForgetTool,
  memorySetTool,
  memoryGetTool,
  runMemoryRemember,
  runMemoryRecall,
  runMemoryForget,
  runMemorySet,
  runMemoryGet,
  type MemoryToolContext,
} from "@/utils/memory/tools.server";

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AgentToolContext = {
  userId: string;
  agentId?: string;
  authToken?: string;
  sb: SupabaseClient<Database>;
  // Optional — present when the chat route is handling a real conversation
  // (playground or swarm node). Required for memory_set/memory_get scratchpad.
  conversationId?: string | null;
  // Optional — explicit retrieval re-ranker from the request body (swarm
  // nodes); standalone agents carry theirs in tools.reranker instead.
  reranker?: { provider: string; model: string };
  // Set ONLY on headless (API-key / scheduled) runs, where `sb` is the
  // service-role client (RLS disabled). Data loaders MUST then explicitly
  // restrict results to this owner's rows + public samples — the sole tenant
  // guard in the absence of a user JWT. Never set on the normal RLS path.
  scopeUserId?: string;
};

// ============================================================================
// kb_search
// ============================================================================
export const kbSearchTool: ToolDef = {
  type: "function",
  function: {
    name: "kb_search",
    description:
      "Search the agent's connected knowledge bases for documents relevant to a question. " +
      "Returns up to top_k snippets with citation metadata. Use when the user's question may be answered by stored documents.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        top_k: { type: "number", description: "Max results to return (1-8)", default: 5 },
      },
      required: ["query"],
    },
  },
};

export async function runKbSearch(
  ctx: AgentToolContext,
  args: { query: string; top_k?: number },
  extraKbIds?: string[],
): Promise<string> {
  const hasAnyKb = !!ctx.agentId || (extraKbIds && extraKbIds.length > 0);
  if (!hasAnyKb)
    return JSON.stringify({ error: "No knowledge base wired — kb_search unavailable" });
  // Reuse the same retrieval the chat route uses for auto-RAG.
  const { retrieveCitationsServer } = await import("./kb.server");
  const cits = await retrieveCitationsServer({
    sb: ctx.sb,
    agentId: ctx.agentId,
    extraKbIds,
    query: args.query,
    topK: Math.max(1, Math.min(args.top_k ?? 5, 8)),
    userId: ctx.userId,
    reranker: ctx.reranker,
    scopeUserId: ctx.scopeUserId,
  });
  if (cits.length === 0) {
    return JSON.stringify({
      results: [],
      note: "No matching documents in any connected knowledge base.",
    });
  }
  return JSON.stringify({
    results: cits.map((c) => ({
      document: c.documentName,
      knowledge_base: c.knowledgeBaseName,
      snippet: c.snippet,
    })),
  });
}

// ============================================================================
// kb_graph_search — Graph RAG retrieval (1-2 hop neighbourhood)
// ============================================================================
export const kbGraphSearchTool: ToolDef = {
  type: "function",
  function: {
    name: "kb_graph_search",
    description:
      "Search the knowledge graph built from your knowledge base. Returns a subgraph of entity " +
      "relationships (triples like 'Billing depends_on Auth') plus supporting snippets. " +
      "PREFER THIS over kb_search for relational/multi-hop questions: 'who works on X?', " +
      "'what depends on Y?', 'who owns Z?', 'if we change A, who is affected?'. " +
      "The graph is built once via the Knowledge → Graph tab; if no graph exists this returns an empty result.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language question — entity names matter" },
      },
      required: ["query"],
    },
  },
};

export async function runKbGraphSearch(
  ctx: AgentToolContext,
  args: { query: string },
  extraKbIds?: string[],
): Promise<string> {
  const hasAnyKb = !!ctx.agentId || (extraKbIds && extraKbIds.length > 0);
  if (!hasAnyKb)
    return JSON.stringify({ error: "No knowledge base wired — kb_graph_search unavailable" });
  const { retrieveGraphContextServer } = await import("./kb-graph.server");
  const gc = await retrieveGraphContextServer({
    sb: ctx.sb,
    agentId: ctx.agentId,
    extraKbIds,
    query: args.query,
  });
  if (gc.subgraph.length === 0 && gc.entityFacts.length === 0) {
    return JSON.stringify({
      subgraph: [],
      entity_facts: [],
      note:
        "No graph match. Either no graph has been built for this KB yet (Knowledge → Graph → Build), " +
        "or the query mentions no entities present in the graph.",
    });
  }
  return JSON.stringify({
    subgraph: gc.subgraph,
    entity_facts: gc.entityFacts,
    note: "Triples are 'source predicate target'. Use them to answer multi-hop questions; cite snippets for grounding.",
  });
}

// web_search — Firecrawl when FIRECRAWL_API_KEY is configured (via the
// Firecrawl connector); falls back to DuckDuckGo Instant Answer otherwise.
// ============================================================================
export const webSearchTool: ToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web for up-to-date information. Use when the user asks about current events, " +
      "recent news, prices, market data, or any fact you don't reliably know. Returns a list of result " +
      "snippets with URLs. For full page content, follow up with web_browse on the most relevant URL.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results to return (1-10)", default: 5 },
      },
      required: ["query"],
    },
  },
};

export const webBrowseTool: ToolDef = {
  type: "function",
  function: {
    name: "web_browse",
    description:
      "Fetch and read a single web page as clean markdown. Use after web_search when you need the " +
      "full text of a specific result (e.g. an article, filing, blog post). Uses Firecrawl when a " +
      "key is configured; otherwise a built-in fetcher that reads server-rendered pages but does not " +
      "run JavaScript — such a page comes back marked `thin` with a note saying so.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute https:// URL to scrape" },
      },
      required: ["url"],
    },
  },
};

async function firecrawlSearch(
  query: string,
  limit: number,
  overrideKey?: string,
): Promise<string | null> {
  const key = overrideKey?.trim() || process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: Math.max(1, Math.min(limit, 10)) }),
    });
    if (!r.ok) {
      // Don't trap the loop with a Firecrawl-only error — let the caller
      // fall back to DuckDuckGo so the agent still gets *some* result.
      const t = await r.text().catch(() => "");
      console.warn(
        `[web_search] Firecrawl ${r.status}: ${t.slice(0, 200)} — falling back to DuckDuckGo`,
      );
      return null;
    }
    const j = (await r.json()) as {
      data?:
        | { web?: Array<{ url?: string; title?: string; description?: string }> }
        | Array<{ url?: string; title?: string; description?: string }>;
    };
    // v2 returns { data: { web: [...] } } typically; older shape returns { data: [...] }.
    let items: Array<{ url?: string; title?: string; description?: string }> = [];
    if (Array.isArray(j.data)) items = j.data;
    else if (j.data && Array.isArray(j.data.web)) items = j.data.web;
    return JSON.stringify({
      provider: "firecrawl",
      query,
      results: items.slice(0, limit).map((it) => ({
        title: it.title || null,
        url: it.url || null,
        snippet: it.description || null,
      })),
    });
  } catch (e) {
    console.warn(
      `[web_search] Firecrawl exception: ${(e as Error).message} — falling back to DuckDuckGo`,
    );
    return null;
  }
}

async function duckDuckGoSearch(query: string): Promise<string> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const r = await fetch(url, { headers: { "User-Agent": "AgentSwarm/1.0" } });
    if (!r.ok) return JSON.stringify({ error: `DuckDuckGo ${r.status}`, provider: "duckduckgo" });
    const j = (await r.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: { Text?: string; FirstURL?: string }[];
      Answer?: string;
    };
    const related = (j.RelatedTopics ?? [])
      .filter((t) => t.Text)
      .slice(0, 6)
      .map((t) => ({ text: t.Text, url: t.FirstURL }));
    return JSON.stringify({
      provider: "duckduckgo",
      query,
      heading: j.Heading || null,
      abstract: j.AbstractText || null,
      abstract_url: j.AbstractURL || null,
      direct_answer: j.Answer || null,
      related,
      note:
        !j.AbstractText && related.length === 0
          ? "No entity summary for this query. This built-in fallback is DuckDuckGo's Instant Answer API, which returns encyclopedia-style entries rather than ranked web results, so ordinary queries often come back empty. Connect Firecrawl on the Integrations page, or set a Brave/SerpAPI/Tavily key on the agent, for real web search."
          : undefined,
    });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message, provider: "duckduckgo" });
  }
}

// Per-call configuration that the chat route forwards from the agent's
// saved tool configs OR from the swarm node's `toolConfigs`. All fields
// are optional — when missing we fall back to the workspace-wide setup
// (e.g. process.env.FIRECRAWL_API_KEY).
export type ToolConfigs = {
  web_search?: { provider?: string; api_key?: string };
  web_browse?: { provider?: string; api_key?: string };
  // Allow-list of n8n workflow ids the model is permitted to invoke. When
  // present, the tool description steers the model to only those ids and
  // the handler refuses anything outside the list.
  n8n_workflow_ids?: string[];
  // Allow-list of MCP server names. Same idea — narrows the surface area.
  mcp_server_names?: string[];
  // Allow-list of data table names that the sql_query tool may read. When
  // present, the registry filters the schema summary AND the runtime table
  // catalog so the model sees ONLY those tables. Empty / undefined = every
  // table the user can read (own + public samples).
  sql_table_names?: string[];
  // Allow-list of semantic model NAMES the metric_query tool may read.
  // DENY BY DEFAULT: unlike sql_table_names, absent or empty means NOTHING,
  // and the tool is not registered at all. The catalog is injected into the
  // system prompt on every call, so an agent that was given no models should
  // cost nothing rather than advertise the whole account's metrics.
  metric_model_names?: string[];
};

async function braveSearch(query: string, limit: number, key: string): Promise<string> {
  try {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(Math.max(1, Math.min(limit, 10))));
    const r = await fetch(u, {
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
    });
    if (!r.ok)
      return JSON.stringify({
        provider: "brave",
        error: `${r.status}: ${(await r.text()).slice(0, 200)}`,
      });
    const j = (await r.json()) as {
      web?: { results?: Array<{ url?: string; title?: string; description?: string }> };
    };
    const items = j.web?.results ?? [];
    return JSON.stringify({
      provider: "brave",
      query,
      results: items.slice(0, limit).map((it) => ({
        title: it.title || null,
        url: it.url || null,
        snippet: it.description || null,
      })),
    });
  } catch (e) {
    return JSON.stringify({ provider: "brave", error: (e as Error).message });
  }
}

async function tavilySearch(query: string, limit: number, key: string): Promise<string> {
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: Math.max(1, Math.min(limit, 10)) }),
    });
    if (!r.ok)
      return JSON.stringify({
        provider: "tavily",
        error: `${r.status}: ${(await r.text()).slice(0, 200)}`,
      });
    const j = (await r.json()) as {
      results?: Array<{ url?: string; title?: string; content?: string }>;
    };
    return JSON.stringify({
      provider: "tavily",
      query,
      results: (j.results ?? []).slice(0, limit).map((it) => ({
        title: it.title || null,
        url: it.url || null,
        snippet: it.content || null,
      })),
    });
  } catch (e) {
    return JSON.stringify({ provider: "tavily", error: (e as Error).message });
  }
}

async function serpapiSearch(query: string, limit: number, key: string): Promise<string> {
  try {
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("q", query);
    u.searchParams.set("engine", "google");
    u.searchParams.set("api_key", key);
    u.searchParams.set("num", String(Math.max(1, Math.min(limit, 10))));
    const r = await fetch(u);
    if (!r.ok)
      return JSON.stringify({
        provider: "serpapi",
        error: `${r.status}: ${(await r.text()).slice(0, 200)}`,
      });
    const j = (await r.json()) as {
      organic_results?: Array<{ link?: string; title?: string; snippet?: string }>;
    };
    return JSON.stringify({
      provider: "serpapi",
      query,
      results: (j.organic_results ?? []).slice(0, limit).map((it) => ({
        title: it.title || null,
        url: it.link || null,
        snippet: it.snippet || null,
      })),
    });
  } catch (e) {
    return JSON.stringify({ provider: "serpapi", error: (e as Error).message });
  }
}

/**
 * Resolve a Firecrawl API key for this user from the Integrations page
 * (an `integrations` row of type `firecrawl`, api_key encrypted at rest).
 * The workspace-wide FIRECRAWL_API_KEY env var still takes precedence; this is
 * the UI alternative for when it isn't set. Best-effort — never throws.
 */
async function loadFirecrawlIntegrationKey(ctx: AgentToolContext): Promise<string | null> {
  try {
    const { data } = await ctx.sb
      .from("integrations")
      .select("config, is_active")
      .eq("type", "firecrawl")
      .eq("is_active", true)
      .maybeSingle();
    if (!data?.is_active) return null;
    const cfg = (await resolveIntegrationConfig(
      ctx.userId,
      "firecrawl",
      (data.config || {}) as Record<string, unknown>,
    )) as { api_key?: string };
    return (cfg.api_key || "").trim() || null;
  } catch {
    return null;
  }
}

/** Effective Firecrawl key: per-agent custom → workspace env → Integrations. */
async function resolveFirecrawlKey(
  ctx: AgentToolContext,
  customKey?: string,
): Promise<string | undefined> {
  const custom = (customKey || "").trim();
  if (custom) return custom;
  if (process.env.FIRECRAWL_API_KEY) return process.env.FIRECRAWL_API_KEY;
  return (await loadFirecrawlIntegrationKey(ctx)) || undefined;
}

export async function runWebSearch(
  ctx: AgentToolContext,
  args: { query: string; limit?: number },
  cfg?: ToolConfigs["web_search"],
): Promise<string> {
  const q = (args.query || "").trim();
  if (!q) return JSON.stringify({ error: "Empty query" });
  const limit = args.limit ?? 5;
  const provider = (cfg?.provider || "firecrawl_builtin").toLowerCase();
  const key = (cfg?.api_key || "").trim();

  if (provider === "brave" && key) return braveSearch(q, limit, key);
  if (provider === "tavily" && key) return tavilySearch(q, limit, key);
  if (provider === "serpapi" && key) return serpapiSearch(q, limit, key);

  // Firecrawl: per-agent custom key when provider=firecrawl_custom, else the
  // workspace-wide FIRECRAWL_API_KEY, else the user's Firecrawl integration.
  const fcKey = await resolveFirecrawlKey(ctx, provider === "firecrawl_custom" ? key : undefined);
  const fc = await firecrawlSearch(q, limit, fcKey);
  if (fc) return fc;
  return duckDuckGoSearch(q);
}

/**
 * web_browse via the built-in fetcher. Shapes its result like the Firecrawl
 * branch so the model sees one contract regardless of which path ran.
 */
async function nativeBrowse(url: string, upstreamError?: string): Promise<string> {
  try {
    const { nativeScrape } = await import("@/utils/nativeScrape.server");
    const r = await nativeScrape(url, { maxChars: 12000 });
    return JSON.stringify({
      provider: "native",
      url: r.finalUrl || r.url,
      title: r.title,
      markdown: r.markdown,
      thin: r.thin || undefined,
      note: r.note,
      upstream_error: upstreamError,
    });
  } catch (e) {
    return JSON.stringify({
      provider: "native",
      error: (e as Error).message,
      upstream_error: upstreamError,
    });
  }
}

export async function runWebBrowse(
  ctx: AgentToolContext,
  args: { url: string },
  cfg?: ToolConfigs["web_browse"],
): Promise<string> {
  const url = (args.url || "").trim();
  if (!/^https?:\/\//i.test(url))
    return JSON.stringify({ error: "Invalid URL — must start with http(s)://" });
  // This URL is chosen by the MODEL, so it is reachable by prompt injection
  // (including from a public embed). Refuse private/internal targets — notably
  // cloud metadata — before any provider path, direct or proxied.
  const safe = await assertPublicUrl(url);
  if (!safe.ok) return JSON.stringify({ error: safe.error });
  const provider = (cfg?.provider || "firecrawl_builtin").toLowerCase();
  const userKey = (cfg?.api_key || "").trim();

  // ScrapingBee alternative — requires a per-agent/per-node key.
  if (provider === "scrapingbee" && userKey) {
    try {
      const u = new URL("https://app.scrapingbee.com/api/v1/");
      u.searchParams.set("api_key", userKey);
      u.searchParams.set("url", url);
      u.searchParams.set("render_js", "true");
      const r = await fetch(u);
      const text = await r.text();
      if (!r.ok)
        return JSON.stringify({
          provider: "scrapingbee",
          error: `${r.status}: ${text.slice(0, 200)}`,
        });
      // Strip tags crudely so the model gets readable text. Caller typically wants markdown-ish.
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return JSON.stringify({
        provider: "scrapingbee",
        url,
        text: stripped.slice(0, 12000) + (stripped.length > 12000 ? "\n\n…(truncated)" : ""),
      });
    } catch (e) {
      return JSON.stringify({ provider: "scrapingbee", error: (e as Error).message });
    }
  }

  // Firecrawl path (default). Per-agent custom key → workspace env → the user's
  // Firecrawl integration (Integrations page).
  const key = await resolveFirecrawlKey(ctx, provider === "firecrawl_custom" ? userKey : undefined);
  if (!key) {
    // No key anywhere: fall back to the built-in fetcher rather than refusing.
    // web_search already degrades to a free provider instead of disappearing;
    // this makes web_browse behave the same way. It cannot run JavaScript, so
    // the result says so when a page comes back empty.
    return await nativeBrowse(url);
  }
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      // A key that is present but rejected (exhausted credits, 5xx) used to end
      // the call. The built-in fetcher can still read a server-rendered page,
      // so try it before giving up and keep the upstream reason in the result.
      const fallback = await nativeBrowse(url, `Firecrawl scrape ${r.status}: ${t.slice(0, 200)}`);
      return fallback;
    }
    const j = (await r.json()) as {
      data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } };
    };
    const md = j.data?.markdown || "";
    return JSON.stringify({
      provider: "firecrawl",
      url,
      title: j.data?.metadata?.title || null,
      // Cap at ~12k chars so the model can ingest without blowing context.
      markdown: md.length > 12000 ? md.slice(0, 12000) + "\n\n…(truncated)" : md,
    });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

// ============================================================================
// calculator — safe math expression evaluator (no eval, no network)
// ============================================================================
export const calculatorTool: ToolDef = {
  type: "function",
  function: {
    name: "calculator",
    description:
      "Evaluate a math expression. Supports +, -, *, /, %, **, parentheses, and the constants pi and e. " +
      "Use for any arithmetic, percentages, or unit conversions you can express as a formula. Always prefer this over guessing.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression, e.g. '(1234 * 1.085) / 12'" },
      },
      required: ["expression"],
    },
  },
};

export async function runCalculator(
  _ctx: AgentToolContext,
  args: { expression: string },
): Promise<string> {
  const raw = String(args.expression ?? "").trim();
  if (!raw) return JSON.stringify({ error: "Empty expression" });
  // Whitelist: digits, math ops, parens, dot, whitespace, and the words pi/e.
  const sanitized = raw.replace(/\bpi\b/gi, "Math.PI").replace(/\be\b/g, "Math.E");
  if (!/^[\sMath.PIE0-9+\-*/%().,]*$/.test(sanitized)) {
    return JSON.stringify({
      error:
        "Expression contains disallowed characters. Only numbers, + - * / % ** ( ) . pi e are allowed.",
    });
  }
  try {
    const value = Function(`"use strict"; return (${sanitized});`)();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return JSON.stringify({ error: "Result is not a finite number" });
    }
    return JSON.stringify({ expression: raw, result: value });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

// ============================================================================
// datetime — current time + timezone math (keyless)
// ============================================================================
export const datetimeTool: ToolDef = {
  type: "function",
  function: {
    name: "datetime",
    description:
      "Get the current date/time, optionally in a specific IANA timezone (e.g. 'America/New_York', 'Asia/Tokyo'). " +
      "Use whenever you need 'now', or to convert between timezones. Returns ISO and human-readable formats.",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone, defaults to UTC" },
      },
    },
  },
};

export async function runDatetime(
  _ctx: AgentToolContext,
  args: { timezone?: string },
): Promise<string> {
  const tz = (args.timezone || "UTC").trim();
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "long",
    });
    const offsetFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(now);
    const offset = offsetFmt.find((p) => p.type === "timeZoneName")?.value ?? "";
    return JSON.stringify({
      timezone: tz,
      iso_utc: now.toISOString(),
      epoch_ms: now.getTime(),
      human: fmt.format(now),
      utc_offset: offset,
    });
  } catch (e) {
    return JSON.stringify({ error: `Invalid timezone '${tz}': ${(e as Error).message}` });
  }
}

// ============================================================================
// weather — Open-Meteo (keyless, no signup)
// ============================================================================
export const weatherTool: ToolDef = {
  type: "function",
  function: {
    name: "weather",
    description:
      "Get current weather + 3-day forecast for a place. Pass either a free-text location ('Berlin', 'Sydney CBD') " +
      "or explicit lat/lon. Powered by Open-Meteo (no key needed). Returns temperature, conditions, wind, humidity.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City or place name (geocoded automatically)" },
        latitude: {
          type: "number",
          description: "Latitude in decimal degrees (skip location if set)",
        },
        longitude: {
          type: "number",
          description: "Longitude in decimal degrees (skip location if set)",
        },
      },
    },
  },
};

const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Rain showers",
  81: "Heavy rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm w/ slight hail",
  99: "Thunderstorm w/ heavy hail",
};

// Open-Meteo's keyless tier rate-limits per IP. On a shared server egress IP
// (e.g. Lovable's), that limit is consumed across all users, so transient 429
// (and occasional 503) responses are common. Retry a couple of times with
// exponential backoff + jitter before giving up — most limits are per-minute
// bursts that clear within a second or two.
async function fetchOpenMeteo(url: string | URL, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if ((r.status !== 429 && r.status !== 503) || attempt >= retries) return r;
    const delay = 400 * 2 ** attempt + Math.random() * 200;
    await new Promise((res) => setTimeout(res, delay));
  }
}

function weatherHttpError(status: number, service: string): string {
  if (status === 429 || status === 503) {
    return `The weather service (${service}) is temporarily busy. Please ask again in a few seconds.`;
  }
  return `${service} request failed (HTTP ${status}).`;
}

export async function runWeather(
  _ctx: AgentToolContext,
  args: { location?: string; latitude?: number; longitude?: number },
): Promise<string> {
  let lat = args.latitude;
  let lon = args.longitude;
  let resolvedName: string | undefined;
  if ((lat == null || lon == null) && args.location) {
    try {
      const g = await fetchOpenMeteo(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.location)}&count=1`,
      );
      if (!g.ok)
        return JSON.stringify({ error: weatherHttpError(g.status, "Open-Meteo geocoding") });
      const gj = (await g.json()) as {
        results?: Array<{ latitude: number; longitude: number; name: string; country?: string }>;
      };
      const hit = gj.results?.[0];
      if (!hit)
        return JSON.stringify({ error: `Could not find a location matching '${args.location}'` });
      lat = hit.latitude;
      lon = hit.longitude;
      resolvedName = `${hit.name}${hit.country ? ", " + hit.country : ""}`;
    } catch (e) {
      return JSON.stringify({ error: `Geocoding failed: ${(e as Error).message}` });
    }
  }
  if (lat == null || lon == null)
    return JSON.stringify({ error: "Provide either a location or both latitude and longitude" });
  try {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(lat));
    u.searchParams.set("longitude", String(lon));
    u.searchParams.set(
      "current",
      "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
    );
    u.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    u.searchParams.set("forecast_days", "3");
    u.searchParams.set("timezone", "auto");
    const r = await fetchOpenMeteo(u);
    if (!r.ok) return JSON.stringify({ error: weatherHttpError(r.status, "Open-Meteo") });
    const j = (await r.json()) as {
      current?: {
        temperature_2m: number;
        relative_humidity_2m: number;
        weather_code: number;
        wind_speed_10m: number;
      };
      daily?: {
        time: string[];
        weather_code: number[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
      };
    };
    return JSON.stringify({
      location: resolvedName,
      latitude: lat,
      longitude: lon,
      current: j.current
        ? {
            temperature_c: j.current.temperature_2m,
            humidity_pct: j.current.relative_humidity_2m,
            wind_kmh: j.current.wind_speed_10m,
            conditions: WEATHER_CODES[j.current.weather_code] ?? `code ${j.current.weather_code}`,
          }
        : null,
      forecast: (j.daily?.time ?? []).map((d, i) => ({
        date: d,
        high_c: j.daily!.temperature_2m_max[i],
        low_c: j.daily!.temperature_2m_min[i],
        conditions: WEATHER_CODES[j.daily!.weather_code[i]] ?? `code ${j.daily!.weather_code[i]}`,
      })),
    });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

// ============================================================================
// n8n_run_workflow
// ============================================================================
export const n8nRunWorkflowTool: ToolDef = {
  type: "function",
  function: {
    name: "n8n_run_workflow",
    description:
      "Execute one of the user's connected n8n workflows by ID. Returns the workflow execution result. " +
      "Use when the user asks to trigger an automation, send a notification, sync data, or run a saved workflow.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "The n8n workflow ID. Use list_n8n_workflows first if you don't know it.",
        },
        input: {
          type: "object",
          description: "JSON object passed as workflow input data.",
          additionalProperties: true,
        },
      },
      required: ["workflow_id"],
    },
  },
};

export const n8nListWorkflowsTool: ToolDef = {
  type: "function",
  function: {
    name: "list_n8n_workflows",
    description:
      "List the user's available n8n workflows (id, name, active flag). " +
      "Call this first when the user asks to run a workflow but doesn't specify the ID.",
    parameters: { type: "object", properties: {} },
  },
};

// ============================================================================
// send_notification — post to the user's connected notification channels
// ============================================================================
export const sendNotificationTool: ToolDef = {
  type: "function",
  function: {
    name: "send_notification",
    description:
      "Send a message to one of the user's connected notification channels (Slack, Microsoft Teams, " +
      "Discord, or a custom webhook — configured under Integrations → Notifications). " +
      "Use when the user asks to notify, alert, ping, or post an update to their team.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message body to send." },
        title: { type: "string", description: "Optional short title/headline." },
        channel: {
          type: "string",
          enum: ["slack", "teams", "discord", "webhook"],
          description: "Which connected channel to use. Omit to use the first connected one.",
        },
      },
      required: ["message"],
    },
  },
};

export async function runSendNotification(
  ctx: AgentToolContext,
  args: { message: string; title?: string; channel?: string },
): Promise<string> {
  const message = (args.message || "").trim();
  if (!message) return JSON.stringify({ error: "message is required" });
  // Explicit user scoping on top of RLS: on headless runs ctx.sb can be a
  // service-role client, and a notification must only ever leave through the
  // OWNER's channels.
  let q = ctx.sb
    .from("integrations")
    .select("provider, config, is_active")
    .eq("type", "notification")
    .eq("is_active", true);
  if (ctx.userId) q = q.eq("user_id", ctx.userId);
  const { data: channels } = await q;
  const list = channels ?? [];
  if (list.length === 0) {
    return JSON.stringify({
      error:
        "No notification channel connected. Tell the user to add one under Integrations → Notifications.",
    });
  }
  const pick = args.channel ? list.find((c) => c.provider === args.channel) : list[0];
  if (!pick) {
    return JSON.stringify({
      error: `Channel '${args.channel}' is not connected. Connected: ${list.map((c) => c.provider).join(", ")}`,
    });
  }
  try {
    const cfg = (await resolveIntegrationConfig(
      ctx.userId,
      "notification",
      (pick.config ?? {}) as Record<string, unknown>,
    )) as { webhook_url?: string };
    if (!cfg.webhook_url) return JSON.stringify({ error: "The channel has no webhook URL saved." });
    const { postNotification } = await import("@/utils/integrations/testAdapters.server");
    const res = await postNotification(pick.provider ?? "webhook", cfg.webhook_url, {
      title: (args.title || "Agent notification").slice(0, 200),
      body: message.slice(0, 2000),
    });
    return JSON.stringify(
      res.ok ? { sent: true, channel: pick.provider, detail: res.detail } : { error: res.detail },
    );
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

async function loadN8nIntegration(ctx: AgentToolContext) {
  const { data } = await ctx.sb
    .from("integrations")
    .select("config, is_active")
    .eq("type", "n8n")
    .eq("is_active", true)
    .maybeSingle();
  if (!data?.is_active) return null;
  // Decrypt webhook_token (webhook_token_enc) + resolve {{secret:}} refs.
  const cfg = (await resolveIntegrationConfig(
    ctx.userId,
    "n8n",
    (data.config || {}) as Record<string, unknown>,
  )) as {
    instance_url?: string;
    webhook_token?: string;
    auth_type?: string;
  };
  if (!cfg.instance_url) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const token = (cfg.webhook_token || "").trim();
  if (cfg.auth_type === "header" && token) headers["X-N8N-API-KEY"] = token;
  else if (cfg.auth_type === "basic" && token) headers.Authorization = `Basic ${btoa(token)}`;
  return { baseUrl: cfg.instance_url.replace(/\/+$/, ""), headers };
}

export async function runListN8nWorkflows(
  ctx: AgentToolContext,
  _args: Record<string, never>,
  allowList?: string[],
): Promise<string> {
  const cfg = await loadN8nIntegration(ctx);
  if (!cfg)
    return JSON.stringify({
      error: "n8n is not connected. Tell the user to add it in Integrations.",
    });
  try {
    const r = await safeFetch(`${cfg.baseUrl}/api/v1/workflows?limit=50`, {
      headers: cfg.headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok)
      return JSON.stringify({ error: `n8n ${r.status}: ${(await r.text()).slice(0, 200)}` });
    const j = (await r.json()) as { data?: { id: string; name: string; active: boolean }[] };
    let items = (j.data || []).map((w) => ({ id: w.id, name: w.name, active: w.active }));
    if (allowList && allowList.length > 0) {
      const allow = new Set(allowList.map((s) => s.trim()).filter(Boolean));
      items = items.filter((w) => allow.has(w.id));
    }
    return JSON.stringify({ workflows: items, count: items.length });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

export async function runN8nWorkflow(
  ctx: AgentToolContext,
  args: { workflow_id: string; input?: Record<string, unknown> },
  allowList?: string[],
): Promise<string> {
  const cfg = await loadN8nIntegration(ctx);
  if (!cfg) return JSON.stringify({ error: "n8n is not connected." });
  const id = (args.workflow_id || "").trim();
  if (!id) return JSON.stringify({ error: "workflow_id is required" });
  if (allowList && allowList.length > 0) {
    const allow = new Set(allowList.map((s) => s.trim()).filter(Boolean));
    if (!allow.has(id)) {
      return JSON.stringify({
        error: `Workflow '${id}' is not in this agent's allow-list. Permitted ids: ${Array.from(allow).join(", ")}`,
      });
    }
  }
  try {
    const r = await safeFetch(`${cfg.baseUrl}/api/v1/workflows/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify(args.input ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    if (!r.ok) return JSON.stringify({ error: `n8n ${r.status}: ${text.slice(0, 400)}` });
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    return JSON.stringify({ ok: true, result: parsed });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

// ============================================================================
// mcp_call_tool — Streamable HTTP MCP client
// ============================================================================
export const mcpListServersTool: ToolDef = {
  type: "function",
  function: {
    name: "list_mcp_servers",
    description:
      "List the user's connected MCP servers (name, status, endpoint). " +
      "Call before mcp_call_tool if you don't know what's available.",
    parameters: { type: "object", properties: {} },
  },
};

export const mcpCallToolTool: ToolDef = {
  type: "function",
  function: {
    name: "mcp_call_tool",
    description:
      "Invoke a tool on one of the user's connected MCP (Model Context Protocol) servers. " +
      "Use list_mcp_servers + mcp_list_tools first to discover what's available.",
    parameters: {
      type: "object",
      properties: {
        server_name: {
          type: "string",
          description: "Name of the MCP server (from list_mcp_servers)",
        },
        tool_name: { type: "string", description: "The MCP tool to invoke" },
        arguments: {
          type: "object",
          description: "Arguments object for the tool",
          additionalProperties: true,
        },
      },
      required: ["server_name", "tool_name"],
    },
  },
};

export const mcpListToolsTool: ToolDef = {
  type: "function",
  function: {
    name: "mcp_list_tools",
    description: "List the tools exposed by one connected MCP server.",
    parameters: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Name of the MCP server" },
      },
      required: ["server_name"],
    },
  },
};

async function loadMcpServer(ctx: AgentToolContext, name: string) {
  const { data } = await ctx.sb
    .from("mcp_servers")
    .select("name, endpoint, auth_type, auth_token, auth_token_enc, status")
    .eq("name", name)
    .maybeSingle();
  if (!data) return null;
  return data;
}

// Single MCP request over Streamable HTTP. The MCP spec requires the client
// to accept BOTH application/json and text/event-stream — without it many
// servers return 406. We always send JSON-RPC POST.
async function mcpRequest(
  endpoint: string,
  authType: string,
  authToken: string | null,
  body: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (authType === "token" && authToken) headers.Authorization = `Bearer ${authToken}`;
  try {
    // The endpoint is user-registered but fetched from inside the server's
    // network, so it goes through the SSRF guard with a bounded timeout.
    const r = await safeFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: `${r.status}: ${text.slice(0, 300)}` };
    // Some servers return SSE for tool call results; pull the last data: event.
    if (text.startsWith("event:") || text.includes("\ndata:")) {
      const lines = text.split("\n");
      let last = "";
      for (const l of lines) if (l.startsWith("data:")) last = l.slice(5).trim();
      try {
        return { ok: true, result: JSON.parse(last) };
      } catch {
        return { ok: true, result: last };
      }
    }
    try {
      return { ok: true, result: JSON.parse(text) };
    } catch {
      return { ok: true, result: text };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function runListMcpServers(
  ctx: AgentToolContext,
  _args: Record<string, never>,
  allowList?: string[],
): Promise<string> {
  const { data } = await ctx.sb.from("mcp_servers").select("name, endpoint, status, tools_count");
  let servers = data ?? [];
  if (allowList && allowList.length > 0) {
    const allow = new Set(allowList.map((s) => s.trim()).filter(Boolean));
    servers = servers.filter((s) => allow.has(s.name));
  }
  return JSON.stringify({ servers });
}

export async function runMcpListTools(
  ctx: AgentToolContext,
  args: { server_name: string },
  allowList?: string[],
): Promise<string> {
  if (allowList && allowList.length > 0) {
    const allow = new Set(allowList.map((s) => s.trim()).filter(Boolean));
    if (!allow.has(args.server_name)) {
      return JSON.stringify({
        error: `MCP server '${args.server_name}' is not in this agent's allow-list. Permitted: ${Array.from(allow).join(", ")}`,
      });
    }
  }
  const srv = await loadMcpServer(ctx, args.server_name);
  if (!srv) return JSON.stringify({ error: `Unknown MCP server: ${args.server_name}` });
  // Only HTTP/SSE endpoints can be called from this Worker; stdio:// is not callable.
  if (!/^https?:\/\//i.test(srv.endpoint)) {
    return JSON.stringify({
      error: `Endpoint ${srv.endpoint} is not callable from a server runtime. Only http(s):// MCP endpoints work here.`,
    });
  }
  const token = await resolveMcpAuthToken(srv);
  const r = await mcpRequest(srv.endpoint, srv.auth_type, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  if (!r.ok) return JSON.stringify({ error: r.error });
  return JSON.stringify(r.result);
}

export async function runMcpCallTool(
  ctx: AgentToolContext,
  args: { server_name: string; tool_name: string; arguments?: Record<string, unknown> },
  allowList?: string[],
): Promise<string> {
  if (allowList && allowList.length > 0) {
    const allow = new Set(allowList.map((s) => s.trim()).filter(Boolean));
    if (!allow.has(args.server_name)) {
      return JSON.stringify({
        error: `MCP server '${args.server_name}' is not in this agent's allow-list. Permitted: ${Array.from(allow).join(", ")}`,
      });
    }
  }
  const srv = await loadMcpServer(ctx, args.server_name);
  if (!srv) return JSON.stringify({ error: `Unknown MCP server: ${args.server_name}` });
  if (!/^https?:\/\//i.test(srv.endpoint)) {
    return JSON.stringify({
      error: `Endpoint ${srv.endpoint} is not callable from a server runtime.`,
    });
  }
  const token = await resolveMcpAuthToken(srv);
  const r = await mcpRequest(srv.endpoint, srv.auth_type, token, {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: args.tool_name, arguments: args.arguments ?? {} },
  });
  if (!r.ok) return JSON.stringify({ error: r.error });
  return JSON.stringify(r.result);
}

// ============================================================================
// Registry assembly — checks DB so we only advertise tools that are actually
// reachable for this user/agent. The model lists fewer hallucinated tools.
// ============================================================================
export type ToolHandler = (ctx: AgentToolContext, args: any) => Promise<string>;

export type ResolvedTools = {
  tools: ToolDef[];
  handlers: Map<string, ToolHandler>;
  enabled: {
    kb: boolean;
    web: boolean;
    web_browse: boolean;
    n8n: boolean;
    mcp: boolean;
    calculator: boolean;
    datetime: boolean;
    weather: boolean;
    sql: boolean;
    notify: boolean;
  };
  /**
   * Source-routing guidance built from what is ACTUALLY enabled, appended to
   * the system prompt by the chat route. Without it, a model facing several
   * data sources (tables + KB + web) tends to grab whichever tool has the
   * richest description — typically sql_query with its embedded schema — even
   * when the question is about external information the tables can't answer.
   */
  guidance: string;
};

// Curated tool ids that swarm nodes / agents can toggle individually. Anything
// not in this list is ignored — keeps the API honest and prevents the model
// from advertising tools that don't actually run.
export const TOOLABLE_IDS = [
  "kb_search",
  "kb_graph_search",
  "web_search",
  "web_browse",
  "n8n_run_workflow",
  "mcp_call_tool",
  "send_notification",
  "calculator",
  "datetime",
  "weather",
  "sql_query",
  "metric_query",
  "memory_remember",
  "memory_recall",
  "memory_forget",
  "memory_set",
  "memory_get",
] as const;
export type ToolableId = (typeof TOOLABLE_IDS)[number];

// `overrides.enabledTools` — when provided, only the listed tool ids are
// considered for inclusion (subject to the underlying capability being
// available — e.g. an n8n integration must still exist).
//
// `overrides.toolConfigs` — per-call config overrides applied at runtime:
//   • web_search / web_browse: alternative provider + API key
//   • n8n_workflow_ids: allow-list of permitted workflow ids
//   • mcp_server_names: allow-list of permitted MCP server names
//
// All overrides are forwarded into closures around the corresponding
// handler so the existing tool-loop in loop.server.ts doesn't need to
// know about them.
export async function resolveAgentTools(
  ctx: AgentToolContext,
  overrides?: {
    enabledTools?: ToolableId[] | null;
    toolConfigs?: ToolConfigs | null;
    // Per-call KB id allow-list (used by swarm nodes that reference a
    // sample/shared KB without having an agent record). When provided,
    // kb_search is wired up even if the agent itself has no KB.
    extraKbIds?: string[] | null;
    // Skills whose bodies were left OUT of the system prompt because their
    // combined size crossed the inline budget (see skillsPromptMode). The
    // prompt carries only an index of names and summaries; this registers the
    // use_skill tool that serves a body on demand. Purely request-scoped —
    // the handler closes over these objects and touches no storage, which is
    // also why it is safe on headless runs.
    deferredSkills?: Array<{ name: string; body: string }> | null;
  },
): Promise<ResolvedTools> {
  const tools: ToolDef[] = [];
  const handlers = new Map<string, ToolHandler>();

  // ── Deferred skill bodies ─────────────────────────────────────────────
  // Registered first and unconditionally when present: the system prompt has
  // already promised the model that use_skill exists, and a prompt that names
  // a tool the request does not carry trains the model to stop trusting the
  // prompt.
  {
    const deferred = (overrides?.deferredSkills ?? []).filter(
      (s) => s && typeof s.name === "string" && s.name && typeof s.body === "string",
    );
    if (deferred.length > 0) {
      const byName = new Map(deferred.map((s) => [s.name, s.body]));
      tools.push({
        type: "function",
        function: {
          name: "use_skill",
          description:
            "Load the full instructions for one of the skills listed in your skill index. " +
            "Call this before applying a skill — the index carries only summaries.",
          parameters: {
            type: "object",
            properties: {
              skill: {
                type: "string",
                description: "Exact skill name from the index.",
                enum: deferred.map((s) => s.name),
              },
            },
            required: ["skill"],
          },
        },
      });
      handlers.set("use_skill", async (_c, args) => {
        const name = typeof args?.skill === "string" ? args.skill : "";
        const skillBody = byName.get(name);
        if (!skillBody) {
          return JSON.stringify({
            error: `Unknown skill "${name}". Available: ${[...byName.keys()].join(", ")}`,
          });
        }
        return JSON.stringify({ skill: name, instructions: skillBody });
      });
    }
  }
  const enabled = {
    kb: false,
    web: false,
    web_browse: false,
    n8n: false,
    mcp: false,
    calculator: false,
    datetime: false,
    weather: false,
    sql: false,
    notify: false,
  };

  const allow = overrides?.enabledTools;
  const allows = (id: ToolableId) => !allow || allow.includes(id);
  const cfg = overrides?.toolConfigs ?? {};
  const extraKbIds = (overrides?.extraKbIds ?? []).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );

  // KB — wire up if the agent has a KB OR the caller passed extra KB ids.
  if (allows("kb_search")) {
    let agentHasKb = false;
    if (ctx.agentId) {
      const { data: agent } = await ctx.sb
        .from("agents")
        .select("knowledge_base_id, tools")
        .eq("id", ctx.agentId)
        .maybeSingle();
      const t = (agent?.tools ?? {}) as { knowledgeBaseIds?: unknown };
      const extra = Array.isArray(t.knowledgeBaseIds)
        ? (t.knowledgeBaseIds as unknown[]).length
        : 0;
      agentHasKb = !!agent?.knowledge_base_id || extra > 0;
    }
    if (agentHasKb || extraKbIds.length > 0) {
      tools.push(kbSearchTool);
      handlers.set("kb_search", (c, a) => runKbSearch(c, a, extraKbIds));
      enabled.kb = true;
    }
  }

  // Graph RAG search — only attached if a graph-enabled KB is wired AND the
  // tool is allow-listed. Mirrors the kb_search check so the model isn't
  // tempted to call a tool that returns nothing.
  if (allows("kb_graph_search")) {
    let agentHasKb = false;
    if (ctx.agentId) {
      const { data: agent } = await ctx.sb
        .from("agents")
        .select("knowledge_base_id, tools")
        .eq("id", ctx.agentId)
        .maybeSingle();
      const t = (agent?.tools ?? {}) as { knowledgeBaseIds?: unknown };
      const extra = Array.isArray(t.knowledgeBaseIds)
        ? (t.knowledgeBaseIds as unknown[]).length
        : 0;
      agentHasKb = !!agent?.knowledge_base_id || extra > 0;
    }
    if (agentHasKb || extraKbIds.length > 0) {
      tools.push(kbGraphSearchTool);
      handlers.set("kb_graph_search", (c, a) => runKbGraphSearch(c, a, extraKbIds));
    }
  }

  // Calculator / datetime / weather — always-on utilities (no key required).
  if (allows("calculator")) {
    tools.push(calculatorTool);
    handlers.set("calculator", runCalculator);
    enabled.calculator = true;
  }
  if (allows("datetime")) {
    tools.push(datetimeTool);
    handlers.set("datetime", runDatetime);
    enabled.datetime = true;
  }
  if (allows("weather")) {
    tools.push(weatherTool);
    handlers.set("weather", runWeather);
    enabled.weather = true;
  }

  // Memory tools — always advertised when allow-listed. Bound with the
  // conversationId from the tool context so memory_set/memory_get can read
  // and write the per-conversation scratchpad.
  const memCtxify = (h: (mctx: MemoryToolContext, a: any) => Promise<string>): ToolHandler =>
    ((c, a) => h(c as MemoryToolContext, a)) as ToolHandler;
  if (allows("memory_remember")) {
    tools.push(memoryRememberTool);
    handlers.set("memory_remember", memCtxify(runMemoryRemember));
  }
  if (allows("memory_recall")) {
    tools.push(memoryRecallTool);
    handlers.set("memory_recall", memCtxify(runMemoryRecall));
  }
  if (allows("memory_forget")) {
    tools.push(memoryForgetTool);
    handlers.set("memory_forget", memCtxify(runMemoryForget));
  }
  if (allows("memory_set")) {
    tools.push(memorySetTool);
    handlers.set("memory_set", memCtxify(runMemorySet));
  }
  if (allows("memory_get")) {
    tools.push(memoryGetTool);
    handlers.set("memory_get", memCtxify(runMemoryGet));
  }
  if (allows("web_search")) {
    tools.push(webSearchTool);
    handlers.set("web_search", (c, a) => runWebSearch(c, a, cfg.web_search));
    enabled.web = true;
  }

  // Web browse — advertise when a Firecrawl/ScrapingBee key is available from
  // ANY source: the workspace env var, a per-agent key (custom Firecrawl /
  // ScrapingBee), or the user's Firecrawl integration on the Integrations page.
  // Without this widening, agents that only connected Firecrawl in the UI (or
  // pasted their own key) wouldn't see the tool.
  // web_browse is no longer gated on a key. Without one it runs the built-in
  // fetcher, which reads server-rendered pages and reports when a page needs
  // JavaScript. Hiding the tool entirely meant an agent could not read a URL
  // it had just found with web_search, which degrades rather than disappears.
  if (allows("web_browse")) {
    tools.push(webBrowseTool);
    handlers.set("web_browse", (c, a) => runWebBrowse(c, a, cfg.web_browse));
    enabled.web_browse = true;
  }

  // n8n — only if user has an active n8n integration. Allow-list narrows what
  // the model can call AND is reflected in the tool description so the model
  // picks from a known set.
  if (allows("n8n_run_workflow")) {
    const { data: n8n } = await ctx.sb
      .from("integrations")
      .select("id")
      .eq("type", "n8n")
      .eq("is_active", true)
      .maybeSingle();
    if (n8n) {
      const allowList = cfg.n8n_workflow_ids?.filter((s) => s && s.trim()) ?? [];
      const runDesc =
        allowList.length > 0
          ? `${n8nRunWorkflowTool.function.description} ALLOWED workflow_ids for this agent: ${allowList.join(", ")}.`
          : n8nRunWorkflowTool.function.description;
      const runTool: ToolDef = {
        ...n8nRunWorkflowTool,
        function: { ...n8nRunWorkflowTool.function, description: runDesc },
      };
      tools.push(n8nListWorkflowsTool, runTool);
      handlers.set("list_n8n_workflows", (c, a) => runListN8nWorkflows(c, a, allowList));
      handlers.set("n8n_run_workflow", (c, a) => runN8nWorkflow(c, a, allowList));
      enabled.n8n = true;
    }
  }

  // Notifications — only if the user has at least one connected channel, so
  // the model never advertises a send it cannot deliver.
  if (allows("send_notification")) {
    let nq = ctx.sb
      .from("integrations")
      .select("id")
      .eq("type", "notification")
      .eq("is_active", true);
    if (ctx.userId) nq = nq.eq("user_id", ctx.userId);
    const { data: channels } = await nq.limit(1);
    if (channels && channels.length > 0) {
      tools.push(sendNotificationTool);
      handlers.set("send_notification", (c, a) =>
        runSendNotification(c, a as { message: string; title?: string; channel?: string }),
      );
      enabled.notify = true;
    }
  }

  // MCP — only if user has at least one MCP server with an http(s) endpoint.
  // Allow-list applies the same way.
  if (allows("mcp_call_tool")) {
    const { data: mcps } = await ctx.sb
      .from("mcp_servers")
      .select("endpoint, name")
      .eq("status", "connected");
    const httpMcps = (mcps ?? []).filter((m) => /^https?:\/\//i.test(m.endpoint));
    if (httpMcps.length > 0) {
      const allowList = cfg.mcp_server_names?.filter((s) => s && s.trim()) ?? [];
      const callDesc =
        allowList.length > 0
          ? `${mcpCallToolTool.function.description} ALLOWED server_names for this agent: ${allowList.join(", ")}.`
          : mcpCallToolTool.function.description;
      const callTool: ToolDef = {
        ...mcpCallToolTool,
        function: { ...mcpCallToolTool.function, description: callDesc },
      };
      tools.push(mcpListServersTool, mcpListToolsTool, callTool);
      handlers.set("list_mcp_servers", ((c, a) =>
        runListMcpServers(c, a, allowList)) as ToolHandler);
      handlers.set("mcp_list_tools", ((c, a) => runMcpListTools(c, a, allowList)) as ToolHandler);
      handlers.set("mcp_call_tool", ((c, a) => runMcpCallTool(c, a, allowList)) as ToolHandler);
      enabled.mcp = true;
    }
  }

  // sql_query — only if the user has at least one data table. We attach a
  // schema summary to the tool description so the LLM can write correct SQL
  // without first calling list_data_tables.
  if (allows("sql_query")) {
    // No explicit ownership filter: the client runs under the user's JWT, so
    // RLS returns their own tables, public samples, and IAM-shared tables.
    const { data: dt } = await ctx.sb.from("user_data_tables").select("name, columns");
    // Per-call allow-list — when set, restrict to those table names only.
    const allowedTableNames = (cfg.sql_table_names ?? []).map((s) => s.trim()).filter(Boolean);
    const visible =
      allowedTableNames.length > 0
        ? (dt ?? []).filter((t) => allowedTableNames.includes(t.name))
        : (dt ?? []);
    if (visible.length > 0) {
      const summary = visible
        .map((t) => {
          const cols = Array.isArray(t.columns)
            ? (t.columns as Array<{ name: string; type: string }>)
            : [];
          return `${t.name}(${cols.map((c) => `${c.name}:${c.type}`).join(", ")})`;
        })
        .join("; ");
      const sqlTool: ToolDef = {
        ...sqlQueryTool,
        function: {
          ...sqlQueryTool.function,
          description: `${sqlQueryTool.function.description}\n\nAvailable tables: ${summary}`,
        },
      };
      const allowSet = allowedTableNames.length > 0 ? new Set(allowedTableNames) : null;
      tools.push(listDataTablesTool, sqlTool);
      handlers.set("list_data_tables", (c, a) => runListDataTables(c, a, allowSet));
      handlers.set("sql_query", (c, a) => runSqlQuery(c, a, allowSet));
      enabled.sql = true;
    }
  }

  // Governed semantic metrics — the metric_query tool. The catalog (models +
  // metric / dimension names) is injected into the tool description so the
  // model picks names instead of writing SQL; the compiler guarantees the
  // definition.
  //
  // DENY BY DEFAULT. The agent must name the models it may read; enabling the
  // toggle alone does nothing. Registration is skipped entirely when the
  // allow-list is empty, so an unconfigured agent pays no tokens for a tool
  // description and a catalog it cannot use.
  if (allows("metric_query")) {
    const allowedModelNames = cfg.metric_model_names ?? [];
    const catalog = await semanticCatalogForCtx(ctx, allowedModelNames);
    if (catalog.count > 0) {
      const metricTool: ToolDef = {
        ...metricQueryTool,
        function: {
          ...metricQueryTool.function,
          description: `${metricQueryTool.function.description}\n\nSemantic catalog:\n${catalog.text}`,
        },
      };
      tools.push(metricTool);
      // The same list guards the handler. The catalog only shapes the prompt;
      // this is what actually refuses a model the agent was not given.
      handlers.set("metric_query", (c, a) => runMetricQuery(c, a, allowedModelNames));
    }
  }

  // External warehouse tools — same toggle as sql_query, available when the
  // user has connected at least one warehouse under /integrations. Queries
  // run server-side against the vendor API with decrypted credentials; the
  // model only ever sees result rows.
  if (allows("sql_query")) {
    const { data: whConns } = await ctx.sb
      .from("data_warehouse_connections")
      .select("name, provider")
      .eq("is_active", true);
    if (whConns && whConns.length > 0) {
      const connList = whConns.map((c) => `"${c.name}" (${c.provider})`).join(", ");
      tools.push(
        {
          type: "function",
          function: {
            name: "list_warehouse_tables",
            description:
              `List tables and columns in a connected external data warehouse. ` +
              `Available connections: ${connList}. Call this before writing warehouse SQL.`,
            parameters: {
              type: "object",
              properties: {
                connection: { type: "string", description: "Connection name" },
              },
              required: ["connection"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "warehouse_query",
            description:
              `Run a read-only SQL query (single SELECT/WITH statement) against a connected ` +
              `external data warehouse. Use fully-qualified schema.table names from ` +
              `list_warehouse_tables. Available connections: ${connList}.`,
            parameters: {
              type: "object",
              properties: {
                connection: { type: "string", description: "Connection name" },
                sql: { type: "string", description: "A single SELECT statement" },
              },
              required: ["connection", "sql"],
            },
          },
        },
      );
      handlers.set("list_warehouse_tables", async (c, a) => {
        try {
          const conn = await loadWarehouseConnectionForUser(
            c.sb,
            { name: String(a.connection ?? "") },
            c.userId,
          );
          const whTables = await listWarehouseTables(conn.config);
          return JSON.stringify({
            connection: conn.name,
            provider: conn.provider,
            tables: whTables.map((t) => ({
              table: `${t.schema}.${t.name}`,
              columns: t.columns.map((col) => `${col.name} ${col.type}`),
            })),
          });
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "Failed" });
        }
      });
      handlers.set("warehouse_query", async (c, a) => {
        try {
          const conn = await loadWarehouseConnectionForUser(
            c.sb,
            { name: String(a.connection ?? "") },
            c.userId,
          );
          const result = await executeWarehouseQuery(conn.config, String(a.sql ?? ""), 200);
          const LLM_ROW_CAP = 50;
          return JSON.stringify({
            connection: conn.name,
            columns: result.columns.map((col) => col.name),
            rows: result.rows.slice(0, LLM_ROW_CAP),
            row_count: result.row_count,
            truncated: result.truncated || result.row_count > LLM_ROW_CAP,
          });
        } catch (e) {
          return JSON.stringify({ error: e instanceof Error ? e.message : "Query failed" });
        }
      });
      enabled.sql = true;
    }
  }

  return { tools, handlers, enabled, guidance: buildRoutingGuidance(enabled, tools) };
}

/**
 * WHEN-to-use rules for the enabled sources. Kept short (a few lines) so it
 * steers routing without crowding out the agent's own system prompt.
 */
function buildRoutingGuidance(enabled: ResolvedTools["enabled"], tools: ToolDef[]): string {
  const has = (name: string) => tools.some((t) => t.function.name === name);
  const lines: string[] = [];
  if (enabled.sql) {
    lines.push(
      "- sql_query reads ONLY the user's own data tables listed in its description. " +
        "If the question needs information that is NOT in those tables (external products, " +
        "vendor pricing, market data, anything from the internet), do NOT write SQL against " +
        "imagined tables — use web_search instead, or say the data isn't connected.",
    );
  }
  if (enabled.web) {
    lines.push(
      "- web_search is for external, current, or public information (news, prices, product specs, " +
        "companies, docs). Prefer it whenever the answer isn't in the user's own tables/documents." +
        (enabled.web_browse
          ? " Follow up with web_browse to read the full text of the best result."
          : ""),
    );
  }
  if (enabled.kb) {
    lines.push(
      "- kb_search is for the user's uploaded documents (policies, reports, manuals). Use it for " +
        "questions about their own material — not for general or current-events questions.",
    );
  }
  if (has("metric_query")) {
    lines.push(
      "- metric_query answers governed business-metric questions from the semantic catalog — prefer " +
        "it over raw SQL when a listed metric matches.",
    );
  }
  if (has("list_warehouse_tables")) {
    lines.push(
      "- warehouse_query is for the connected external databases/warehouses — call " +
        "list_warehouse_tables first to see real table names; never guess them.",
    );
  }
  if (lines.length === 0) return "";
  return (
    "TOOL ROUTING — choose the source that actually holds the answer:\n" +
    lines.join("\n") +
    "\n- Combine sources when a task needs it (e.g. web research for figures, then calculator for " +
    "totals). If no tool fits, answer from general knowledge and say which data source would help."
  );
}
