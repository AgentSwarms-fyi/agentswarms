// Server context-gathering for AI document generation: pulls relevant knowledge
// base excerpts + the user's data tables (schemas + a small sample) so the
// client-side planner can ground a document in real, owned data. Runs under the
// caller's JWT — RLS scopes every read to what the user may see.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { retrieveCitationsServer } from "@/utils/tools/kb.server";
import { relevantExcerpt, searchQueryFromPrompt } from "@/utils/webResearch";
import {
  runWebSearch,
  runWebBrowse,
  type AgentToolContext,
  type ToolConfigs,
} from "@/utils/tools/registry.server";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
  return { sb, userId: data.user.id };
}

export type DocContextTable = {
  name: string;
  columns: string[];
  /**
   * Up to 8 sample rows, pre-serialized to a JSON STRING on the server.
   * Returning a string (not raw row objects) keeps the server-fn response safe
   * for seroval: arbitrary user data can contain keys like "constructor" that
   * otherwise break serialization ("Seroval Error").
   */
  sample: string;
};
export type DocContext = {
  kb: { name: string; snippet: string }[];
  tables: DocContextTable[];
  /**
   * Web research gathered when the prompt asks for external/current info
   * ("from the web", pricing, latest …). Search snippets, plus the scraped
   * main content of the top results when a Firecrawl key is available.
   */
  web?: { title: string | null; url: string | null; content: string }[];
  /**
   * Whether the prompt ASKED for web research, regardless of what came back.
   *
   * Without this, "no research was needed" and "research ran and found nothing"
   * are the same empty array, and the planner cannot tell them apart either. It
   * fills the gap from memory — a BoQ asking for live OCI pricing came back
   * with invented unit prices AND a "Sources (cite when presenting)" sheet
   * listing oracle.com URLs, because a search that returns nothing looks
   * exactly like a request that never needed one.
   */
  webAttempted?: boolean;
  /**
   * Why research came back empty (or thin), in the provider's own words —
   * e.g. "DuckDuckGo returned no summary. For richer results, link the
   * Firecrawl connector in Integrations."
   *
   * The stack was already producing this. gatherWebResearch parsed only
   * `results`/`abstract`/`related` and dropped `note` and `error`, so the one
   * honest signal about a failed search never left the function.
   */
  webNote?: string;
};

const MAX_TABLES = 8;
/** Pool the ranker chooses MAX_TABLES from — wide enough that a relevant table
 *  isn't cut off by recency before it can be scored. */
const TABLE_CANDIDATES = 60;
const SAMPLE_ROWS = 15;
const WEB_RESULTS = 6;
const WEB_PAGES = 2; // top results scraped in full (Firecrawl only)
// Per scraped page. Only WEB_PAGES of them are ever this long — the rest are
// ~150-char search snippets — so the planner's 18k CONTEXT budget is not at
// risk, and contextBlock must not re-truncate below this or the excerpt chosen
// here is discarded again.
const WEB_PAGE_CHARS = 3500;

// Run web research only when the prompt actually points at the web — every
// generation paying a search round-trip would be wasted latency for pure
// data-table documents.
const WEB_CUE =
  /\b(web|internet|online|www|latest|current|today|recent|news|market|price|prices|pricing|cost of|quote|rates?|research|look\s*up|search)\b/i;

/**
 * The agent's tool configuration AS STORED on `agents.tools.toolConfigs`.
 *
 * Deliberately not `ToolConfigs` from the registry: that is the MAPPED shape
 * the chat route passes to resolveAgentTools, and the two disagree on SQL —
 * stored is `sql_query.table_names`, mapped is `sql_table_names`. The web keys
 * are identical in both, which is why they can be forwarded straight through.
 */
type StoredToolConfigs = {
  web_search?: ToolConfigs["web_search"];
  web_browse?: ToolConfigs["web_browse"];
  sql_query?: { table_names?: unknown };
};

/**
 * Best-effort web research for the planner. Never throws.
 *
 * `cfg` is the AGENT's saved tool configuration and is not optional in
 * practice: without it runWebSearch defaults provider to "firecrawl_builtin",
 * which makes its `provider === "firecrawl_custom"` test false, so an agent's
 * own Firecrawl key is never passed and resolution falls through to the
 * workspace env var and the user's Firecrawl integration. An agent configured
 * with nothing but a custom key therefore searched via the DuckDuckGo fallback
 * and found nothing — see the note handling below.
 */
async function gatherWebResearch(
  ctx: AgentToolContext,
  prompt: string,
  cfg?: { search?: ToolConfigs["web_search"]; browse?: ToolConfigs["web_browse"] },
): Promise<{ items: DocContext["web"]; note?: string }> {
  try {
    // The SUBJECT, not the whole instruction. Searching the full request —
    // "…pricing for AMD E5 compute instances, then build a bill of quantities
    // for an example on-prem to OCI sizing exercise: line items with…" —
    // returned a YouTube video and a GPU-pricing blog; the same search for just
    // the subject returns Oracle's own E5 announcement.
    const query = searchQueryFromPrompt(prompt);
    const raw = await runWebSearch(ctx, { query, limit: WEB_RESULTS }, cfg?.search);
    const parsed = JSON.parse(raw) as {
      provider?: string;
      results?: { title?: string | null; url?: string | null; snippet?: string | null }[];
      // DuckDuckGo fallback shape:
      heading?: string | null;
      abstract?: string | null;
      abstract_url?: string | null;
      related?: { text?: string; url?: string }[];
      // Why it came back empty. Both were previously parsed away and lost —
      // the one honest signal the stack produced never left this function.
      note?: string | null;
      error?: string | null;
    };
    const out: NonNullable<DocContext["web"]> = [];
    for (const r of parsed.results ?? []) {
      if (r.snippet || r.title)
        out.push({ title: r.title ?? null, url: r.url ?? null, content: r.snippet ?? "" });
    }
    if (out.length === 0 && parsed.abstract) {
      out.push({
        title: parsed.heading ?? null,
        url: parsed.abstract_url ?? null,
        content: parsed.abstract,
      });
      for (const t of parsed.related ?? []) {
        if (t.text) out.push({ title: null, url: t.url ?? null, content: t.text });
      }
    }

    // Scrape the top results for real substance (search snippets rarely carry
    // the actual figures a BoQ/pricing document needs). Firecrawl-only; the
    // browse tool degrades to a JSON error we simply skip.
    const toScrape = out.filter((r) => r.url).slice(0, WEB_PAGES);
    let scrapeError: string | undefined;
    for (const r of toScrape) {
      try {
        const page = JSON.parse(await runWebBrowse(ctx, { url: r.url! }, cfg?.browse)) as {
          markdown?: string;
          text?: string;
          error?: string;
        };
        const body = (page.markdown || page.text || "").trim();
        // Keep the passage that answers the question, not the first N
        // characters. A vendor page opens with navigation and marketing and
        // puts the rate table near the end, so head-truncation delivered the
        // Oracle blog post to the planner with no currency figure in it at all.
        if (body) r.content = relevantExcerpt(body, query, WEB_PAGE_CHARS);
        // Keep the FIRST scrape failure. Search snippets rarely carry the
        // figures a priced document needs, so falling back to them silently is
        // how a BoQ ends up sourced from a page nobody actually read.
        else if (page.error && !scrapeError) scrapeError = page.error;
      } catch {
        /* keep the snippet */
      }
    }
    const items = out.slice(0, WEB_RESULTS);
    // Carry the reason out. An empty result and a result nobody could explain
    // are different problems, and the caller has to be able to say which.
    const note =
      items.length === 0
        ? parsed.error ||
          parsed.note ||
          `No results from ${parsed.provider ?? "the search provider"}.`
        : scrapeError
          ? `Search returned ${items.length} result(s) but the page scrape failed: ${scrapeError}`
          : undefined;
    return { items, note: note ?? undefined };
  } catch (e) {
    return { items: undefined, note: `Web research failed: ${(e as Error).message}` };
  }
}

export const gatherDocContext = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        prompt: z.string().min(1).max(4000),
        agent_id: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; context: DocContext } | { ok: false; error: string }> => {
      try {
        const { sb, userId } = await requireUser(data.access_token);

        // Knowledge base excerpts (best-effort — never fail the whole gather).
        let kb: { name: string; snippet: string }[] = [];
        try {
          const cites = await retrieveCitationsServer({
            sb,
            agentId: data.agent_id ?? null,
            query: data.prompt,
            userId,
            topK: 6,
          });
          kb = cites.map((c) => ({ name: c.documentName, snippet: c.snippet }));
        } catch {
          /* KB context is optional */
        }

        // The agent's saved tool configuration, read ONCE and used for every
        // tool doc-gen runs on the agent's behalf.
        //
        // This load used to sit below, serving only the SQL allow-list, so the
        // web tools ran with no configuration at all: runWebSearch defaulted
        // provider to "firecrawl_builtin", its "firecrawl_custom" branch never
        // fired, and an agent whose Firecrawl key lives here — not in the
        // workspace env or the Integrations page — silently searched via the
        // DuckDuckGo fallback. Doc-gen was the only caller dropping this;
        // /api/chat and swarm tool nodes have always passed it.
        let agentToolConfigs: StoredToolConfigs | null = null;
        if (data.agent_id) {
          const { data: agent } = await sb
            .from("agents")
            .select("tools")
            .eq("id", data.agent_id)
            .maybeSingle();
          agentToolConfigs =
            (agent?.tools as { toolConfigs?: StoredToolConfigs } | null)?.toolConfigs ?? null;
        }

        // Web research — when the prompt points at the web ("from web search",
        // pricing, latest …). Uses the same search/scrape stack as the agent
        // tools (Firecrawl → DuckDuckGo fallback), in parallel with nothing
        // else here so the tables read below stays cheap.
        let web: DocContext["web"];
        let webNote: string | undefined;
        const webAttempted = WEB_CUE.test(data.prompt);
        if (webAttempted) {
          const toolCtx: AgentToolContext = {
            userId,
            agentId: data.agent_id,
            authToken: data.access_token,
            sb,
          };
          const res = await gatherWebResearch(toolCtx, data.prompt, {
            search: agentToolConfigs?.web_search,
            browse: agentToolConfigs?.web_browse,
          });
          web = res.items;
          webNote = res.note;
        }

        // The agent's SQL allow-list, saved under
        // tools.toolConfigs.sql_query.table_names. When an agent restricts its
        // SQL tool to specific tables, a document generated by that agent must
        // obey the same restriction — otherwise doc-gen is a way around the
        // agent's own configuration, and the deck is built on data the agent
        // itself is not allowed to read.
        let allowedTableNames: string[] | null = null;
        {
          const raw = agentToolConfigs?.sql_query?.table_names;
          if (Array.isArray(raw)) {
            const names = raw.filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            );
            // An empty list means "no restriction", matching the chat tool path.
            if (names.length > 0) allowedTableNames = names.map((s) => s.trim());
          }
        }

        // Data tables the user can see (own + samples), with a small row sample.
        //
        // Ranked against the prompt, not by updated_at. Taking the 8 most
        // recently touched tables meant the deck was built on whatever had been
        // edited last — someone asking about revenue could get a deck about a
        // dimension table they happened to import that morning, and on an
        // account with few tables of its own the public samples crowded in.
        const tables: DocContextTable[] = [];
        const { data: candidates } = await sb
          .from("user_data_tables")
          .select("id, name, columns, is_sample, user_id, updated_at")
          .order("updated_at", { ascending: false })
          .limit(TABLE_CANDIDATES);

        const columnsOf = (t: { columns: unknown }): string[] =>
          Array.isArray(t.columns)
            ? (t.columns as unknown[])
                .map((c) => (typeof c === "string" ? c : ((c as { name?: string })?.name ?? "")))
                .filter(Boolean)
            : [];

        const promptTerms = new Set(
          data.prompt
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length > 2),
        );
        const scoreTable = (t: { name: string; is_sample?: boolean | null; columns: unknown }) => {
          const nameTerms = t.name
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
          let score = 0;
          for (const term of nameTerms) if (promptTerms.has(term)) score += 5;
          for (const col of columnsOf(t)) {
            for (const term of col.toLowerCase().split(/[^a-z0-9]+/)) {
              if (term.length > 2 && promptTerms.has(term)) score += 1;
            }
          }
          // A public sample is a fallback, never a competitor to the user's own
          // data — it only makes the cut when nothing of theirs is relevant.
          if (!t.is_sample) score += 2;
          return score;
        };

        // The allow-list is a hard filter applied before ranking — ranking only
        // decides which of the permitted tables to include, never whether a
        // restriction applies.
        const permitted = (candidates ?? []).filter(
          (t) => !allowedTableNames || allowedTableNames.includes(t.name),
        );

        const ranked = permitted
          .map((t, i) => ({ t, score: scoreTable(t), i }))
          // Recency breaks ties, so behaviour is unchanged when nothing matches.
          .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i))
          // An explicit allow-list is small and deliberate: honour all of it
          // rather than truncating the user's own choice at MAX_TABLES.
          .slice(0, allowedTableNames ? allowedTableNames.length : MAX_TABLES)
          .map((x) => x.t);

        for (const t of ranked) {
          const cols = columnsOf(t);
          // A dataset SHARED with this caller has no readable rows in
          // user_data_rows — RLS serves them only through shared_dataset_rows(),
          // which applies the grant's row filter and column mask. Selecting
          // directly returned an empty sample and the deck was built as if the
          // table had no data, with nothing saying why.
          const isShared = !t.is_sample && t.user_id !== userId;
          const rows = isShared
            ? await sb
                .rpc("shared_dataset_rows", { _table_id: t.id })
                .limit(SAMPLE_ROWS)
                .then(({ data }) => (data ?? []).map((row) => ({ row })))
            : await sb
                .from("user_data_rows")
                .select("row")
                .eq("table_id", t.id)
                .limit(SAMPLE_ROWS)
                .then(({ data }) => data ?? []);
          tables.push({
            name: t.name,
            columns: cols,
            // Pre-serialize on the server (see DocContextTable.sample) so the
            // server-fn response can't trip seroval on hostile row keys.
            sample: JSON.stringify(rows.map((r) => r.row).slice(0, 8)),
          });
        }

        return { ok: true, context: { kb, tables, web, webAttempted, webNote } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );
