// Where an answer's information actually came from.
//
// The chat route used to have exactly ONE notion of a source: the knowledge
// base documents pulled in by auto-RAG, emitted as `citations` whether or not
// the answer used them. So a question answered entirely from a web search still
// listed KB documents underneath it — confidently citing things it never read.
//
// A source is now whatever a tool RETURNED, tagged with what kind of thing it
// is, so the UI can show links for the web, documents for a knowledge base,
// tables for SQL and the server/tool for MCP — and several kinds together when
// the answer genuinely drew on several.
//
// Pure module (no `.server` suffix, no imports): the extraction rules are the
// part worth unit-testing, and `.server.ts` files are import-protected.

export type SourceKind = "kb" | "web" | "table" | "mcp" | "tool";

export type Source = {
  /** 1-based display order. KB sources keep the number the model was given. */
  index: number;
  kind: SourceKind;
  /** Link text / document name / table name / remote tool name. */
  title: string;
  /** Web only — the actual link. */
  url?: string;
  /** Collection, provider, MCP server, or the query that produced it. */
  detail?: string;
  snippet?: string;
  /** The tool that produced this source, for the "why is this here" case. */
  tool?: string;
};

export type RawSource = Omit<Source, "index">;

/**
 * Tools that compute or enumerate rather than retrieve. Listing "Calculator" as
 * a source is noise, and the MCP discovery calls describe what COULD be called,
 * not information the answer rests on.
 */
const NON_RETRIEVAL_TOOLS = new Set([
  "calculator",
  "datetime",
  "list_mcp_servers",
  "mcp_list_tools",
  "memory_remember",
  "memory_forget",
  "memory_set",
]);

const MAX_PER_TOOL = 8;
const SNIPPET_MAX = 240;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(v: unknown): string | undefined {
  const s = str(v).replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + "…" : s;
}

function parse(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[])
    : [];
}

/** Hostname of a URL, for the muted line under a web result. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Table names referenced by a SELECT. Deliberately a regex and not a parser:
 * this is a display label, and a wrong guess costs a slightly-off caption.
 */
export function tablesInSql(sql: string): string[] {
  const names = new Set<string>();
  const re = /\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * Cite a SELECT: one source per table it read, carrying the statement itself.
 *
 * Shared by the agent's `sql_query` tool and the Visual BI analyst, which
 * answer the same kind of question by different routes and were showing the
 * user different things — the tool cited `saas_sales` and its SQL, while a BI
 * chart arrived with no provenance at all. One builder, so "which table, and
 * what query" reads the same however the answer was produced.
 */
export function sqlTableSources(
  sql: string | undefined,
  rowCount: number | null,
  tool: string,
): RawSource[] {
  if (!sql || !sql.trim()) return [];
  const tables = tablesInSql(sql);
  const label = rowCount === null ? undefined : `${rowCount} row${rowCount === 1 ? "" : "s"}`;
  if (tables.length === 0) {
    return [{ kind: "table", title: "Query result", detail: label, snippet: clip(sql), tool }];
  }
  return tables.slice(0, MAX_PER_TOOL).map((t) => ({
    kind: "table" as const,
    title: t,
    detail: label,
    snippet: clip(sql),
    tool,
  }));
}

function webSources(result: Record<string, unknown>, tool: string): RawSource[] {
  const provider = str(result.provider) || undefined;
  const out: RawSource[] = [];

  // Firecrawl / Brave / Tavily / SerpAPI all normalise to { results: [...] }.
  for (const r of arr(result.results)) {
    const url = str(r.url);
    if (!url) continue;
    out.push({
      kind: "web",
      title: str(r.title) || hostOf(url) || url,
      url,
      detail: hostOf(url) || provider,
      snippet: clip(r.snippet ?? r.content ?? r.description),
      tool,
    });
  }

  // DuckDuckGo's instant-answer shape.
  const abstractUrl = str(result.abstract_url);
  if (abstractUrl) {
    out.push({
      kind: "web",
      title: str(result.heading) || hostOf(abstractUrl) || abstractUrl,
      url: abstractUrl,
      detail: hostOf(abstractUrl) || provider,
      snippet: clip(result.abstract),
      tool,
    });
  }
  for (const r of arr(result.related)) {
    const url = str(r.url);
    if (!url) continue;
    out.push({
      kind: "web",
      title: str(r.text) || hostOf(url) || url,
      url,
      detail: hostOf(url) || provider,
      tool,
    });
  }
  return out;
}

/**
 * Sources contributed by one tool call. `args` is the JSON the model sent,
 * `result` the JSON the handler returned; both are strings because that is what
 * the tool loop already has in hand.
 */
export function extractToolSources(name: string, args: string, result: string): RawSource[] {
  if (NON_RETRIEVAL_TOOLS.has(name)) return [];
  const res = parse(result);
  // A failed call grounded nothing.
  if (!res || typeof res.error === "string") return [];
  const a = parse(args) ?? {};

  switch (name) {
    case "web_search":
      return webSources(res, name).slice(0, MAX_PER_TOOL);

    case "web_browse": {
      const url = str(res.url) || str(a.url);
      if (!url) return [];
      return [
        {
          kind: "web",
          title: str(res.title) || hostOf(url) || url,
          url,
          detail: hostOf(url),
          snippet: clip(res.markdown ?? res.text ?? res.content),
          tool: name,
        },
      ];
    }

    case "kb_search":
    case "kb_graph_search": {
      const rows = arr(res.results).length ? arr(res.results) : arr(res.matches);
      return rows.slice(0, MAX_PER_TOOL).map((r) => ({
        kind: "kb" as const,
        title: str(r.documentName) || str(r.document_name) || "Document",
        detail: str(r.knowledgeBaseName) || str(r.knowledge_base_name) || undefined,
        snippet: clip(r.snippet ?? r.content ?? r.text),
        tool: name,
      }));
    }

    case "sql_query": {
      const sql = str(res.sql) || str(a.sql);
      const rowCount = typeof res.row_count === "number" ? res.row_count : null;
      return sqlTableSources(sql, rowCount, name);
    }

    case "metric_query": {
      const metrics = Array.isArray(a.metrics) ? a.metrics.map(str).filter(Boolean) : [];
      const title = metrics.length ? metrics.join(", ") : str(a.metric) || "Metric";
      return [{ kind: "table", title, detail: "Semantic layer", tool: name }];
    }

    case "mcp_call_tool": {
      const server = str(a.server_name) || "MCP server";
      const remote = str(a.tool_name) || "tool";
      return [{ kind: "mcp", title: remote, detail: server, tool: name }];
    }

    default:
      // Any other tool — n8n, weather, a custom skill — still grounded the
      // answer in something, so it is named rather than hidden.
      return [{ kind: "tool", title: prettyToolName(name), tool: name }];
  }
}

/** "n8n_run_workflow" → "N8n run workflow" — a label, not an identifier. */
export function prettyToolName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Bracketed citation numbers the answer actually used: "[1]", "[2,3]". */
export function citedIndexes(answer: string): Set<number> {
  const out = new Set<number>();
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    for (const part of m[1].split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
  }
  return out;
}

function dedupeKey(s: RawSource): string {
  return s.kind + "|" + (s.url || s.title.toLowerCase() + "|" + (s.detail || "").toLowerCase());
}

/**
 * Final source list for one answer.
 *
 * `kbSources` are auto-RAG candidates — retrieved BEFORE the model ran, so
 * their presence proves nothing about whether the answer used them. They are
 * kept when the answer cites them by number, or when nothing else grounded the
 * answer; otherwise a web/table/MCP answer would drag along a tail of unrelated
 * documents, which is the whole bug.
 *
 * KB indexes are preserved, never renumbered: the answer's inline [n] markers
 * point at them, and shifting the numbers would silently mislabel the text.
 */
export function buildSources(
  kbSources: Source[],
  toolSources: RawSource[],
  answer: string,
): Source[] {
  const seen = new Set<string>();
  const tools: RawSource[] = [];
  for (const s of toolSources) {
    const key = dedupeKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push(s);
  }

  const cited = citedIndexes(answer);
  const keptKb = kbSources.filter((k) => cited.has(k.index) || tools.length === 0);

  let next = keptKb.reduce((max, k) => Math.max(max, k.index), 0) + 1;
  return [...keptKb, ...tools.map((t) => ({ ...t, index: next++ }))];
}
