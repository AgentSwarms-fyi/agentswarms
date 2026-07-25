// Server context-gathering for AI document generation: pulls relevant knowledge
// base excerpts + the user's data tables (schemas + a small sample) so the
// client-side planner can ground a document in real, owned data. Runs under the
// caller's JWT — RLS scopes every read to what the user may see.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { retrieveCitationsServer } from "@/utils/tools/kb.server";

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
};

const MAX_TABLES = 8;
const SAMPLE_ROWS = 15;

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

        return { ok: true, context: { kb, tables } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );
