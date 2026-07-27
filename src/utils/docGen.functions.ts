// Server context-gathering for AI document generation: pulls relevant knowledge
// base excerpts + the user's data tables (schemas + a small sample) so the
// client-side planner can ground a document in real, owned data. Runs under the
// caller's JWT — RLS scopes every read to what the user may see.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { retrieveCitationsServer } from "@/utils/tools/kb.server";
import { runWebSearch, runWebBrowse, type AgentToolContext } from "@/utils/tools/registry.server";

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
};

const MAX_TABLES = 8;
const SAMPLE_ROWS = 15;
const WEB_RESULTS = 6;
const WEB_PAGES = 2; // top results scraped in full (Firecrawl only)
const WEB_PAGE_CHARS = 3500;

// Run web research only when the prompt actually points at the web — every
// generation paying a search round-trip would be wasted latency for pure
// data-table documents.
const WEB_CUE =
  /\b(web|internet|online|www|latest|current|today|recent|news|market|price|prices|pricing|cost of|quote|rates?|research|look\s*up|search)\b/i;

/** Best-effort web research for the planner. Never throws. */
async function gatherWebResearch(
  ctx: AgentToolContext,
  prompt: string,
): Promise<DocContext["web"]> {
  try {
    const raw = await runWebSearch(ctx, { query: prompt.slice(0, 300), limit: WEB_RESULTS });
    const parsed = JSON.parse(raw) as {
      provider?: string;
      results?: { title?: string | null; url?: string | null; snippet?: string | null }[];
      // DuckDuckGo fallback shape:
      heading?: string | null;
      abstract?: string | null;
      abstract_url?: string | null;
      related?: { text?: string; url?: string }[];
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
    for (const r of toScrape) {
      try {
        const page = JSON.parse(await runWebBrowse(ctx, { url: r.url! })) as {
          markdown?: string;
          text?: string;
          error?: string;
        };
        const body = (page.markdown || page.text || "").trim();
        if (body) r.content = body.slice(0, WEB_PAGE_CHARS);
      } catch {
        /* keep the snippet */
      }
    }
    return out.slice(0, WEB_RESULTS);
  } catch {
    return undefined;
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

        // Web research — when the prompt points at the web ("from web search",
        // pricing, latest …). Uses the same search/scrape stack as the agent
        // tools (Firecrawl → DuckDuckGo fallback), in parallel with nothing
        // else here so the tables read below stays cheap.
        let web: DocContext["web"];
        if (WEB_CUE.test(data.prompt)) {
          const toolCtx: AgentToolContext = {
            userId,
            agentId: data.agent_id,
            authToken: data.access_token,
            sb,
          };
          web = await gatherWebResearch(toolCtx, data.prompt);
        }

        // Data tables the user can see (own + samples), with a small row sample.
        const tables: DocContextTable[] = [];
        const { data: tbls } = await sb
          .from("user_data_tables")
          .select("id, name, columns")
          .order("updated_at", { ascending: false })
          .limit(MAX_TABLES);
        for (const t of tbls ?? []) {
          const cols = Array.isArray(t.columns)
            ? (t.columns as unknown[])
                .map((c) => (typeof c === "string" ? c : ((c as { name?: string })?.name ?? "")))
                .filter(Boolean)
            : [];
          const { data: rows } = await sb
            .from("user_data_rows")
            .select("row")
            .eq("table_id", t.id)
            .limit(SAMPLE_ROWS);
          tables.push({
            name: t.name,
            columns: cols,
            // Pre-serialize on the server (see DocContextTable.sample) so the
            // server-fn response can't trip seroval on hostile row keys.
            sample: JSON.stringify((rows ?? []).map((r) => r.row).slice(0, 8)),
          });
        }

        return { ok: true, context: { kb, tables, web } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );
