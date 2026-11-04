// A swarm run's trace, read through the server (R449). What a run keeps is
// sealed under its owner's user key, which the browser does not hold. Each
// function acts for the signed-in caller on the caller's own rows only, as the
// tables' row-level security did for the browser.
//
// The answers keep what the pages made of them: a read that failed is an error,
// never an empty run, and one row that cannot be opened keeps its figures and
// says why rather than take the page with it.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { callerFailure } from "@/utils/callerLookup.server";
import { parseEvalScorecard, type QualityItem } from "@/lib/evalScorecard";

type Tables = Database["public"]["Tables"];

export type SwarmRunView = Tables["swarm_runs"]["Row"] & {
  body_sealed: boolean;
  body_unreadable: string | null;
};
export type SwarmStepView = Tables["swarm_run_steps"]["Row"] & {
  body_sealed: boolean;
  body_dropped: boolean;
  body_unreadable: string | null;
};
export type SwarmEdgeView = Tables["swarm_run_edges"]["Row"] & {
  body_unreadable: string | null;
};

async function callerId(accessToken: string): Promise<string | { error: string }> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { error: callerFailure(error, "Unauthorized") };
  return data.user.id;
}

const token = z.string().min(1);
// A run's id comes from the page's address, so anything can arrive. What cannot
// be an id is no run, which the page says in words, and not a validator's dump.
const runId = z.string().max(200);
const isRunId = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PageInput = z.object({
  access_token: token,
  run_id: runId,
  after: z.string().uuid().nullable(),
  size: z.number().int().min(1).max(1000),
});

/** One of the caller's runs, opened; null when it is not theirs or not there. */
export const getSwarmRun = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token, run_id: runId }).parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; run: SwarmRunView | null } | { ok: false; error: string }> => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      if (!isRunId(data.run_id)) return { ok: true, run: null };
      const { data: row, error } = await supabaseAdmin
        .from("swarm_runs")
        .select("*")
        .eq("id", data.run_id)
        .eq("user_id", user)
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!row) return { ok: true, run: null };
      const { openRunRow } = await import("@/utils/observability/sealedRuns.server");
      return { ok: true, run: (await openRunRow(row)) as SwarmRunView };
    },
  );

/** A page of one of the caller's runs' steps, by id, opened. */
export const listSwarmRunSteps = createServerFn({ method: "POST" })
  .validator((v: unknown) => PageInput.parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; steps: SwarmStepView[] } | { ok: false; error: string }> => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      if (!isRunId(data.run_id)) return { ok: true, steps: [] };
      let q = supabaseAdmin
        .from("swarm_run_steps")
        .select("*")
        .eq("run_id", data.run_id)
        .eq("user_id", user)
        .order("id", { ascending: true })
        .limit(data.size);
      if (data.after) q = q.gt("id", data.after);
      const { data: rows, error } = await q;
      if (error) return { ok: false, error: error.message };
      const { openStepRow } = await import("@/utils/observability/sealedRuns.server");
      const steps: SwarmStepView[] = [];
      for (const row of rows ?? []) steps.push((await openStepRow(row)) as SwarmStepView);
      return { ok: true, steps };
    },
  );

/** A page of one of the caller's runs' links, by id, opened. */
export const listSwarmRunEdges = createServerFn({ method: "POST" })
  .validator((v: unknown) => PageInput.parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; edges: SwarmEdgeView[] } | { ok: false; error: string }> => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      if (!isRunId(data.run_id)) return { ok: true, edges: [] };
      let q = supabaseAdmin
        .from("swarm_run_edges")
        .select("*")
        .eq("run_id", data.run_id)
        .eq("user_id", user)
        .order("id", { ascending: true })
        .limit(data.size);
      if (data.after) q = q.gt("id", data.after);
      const { data: rows, error } = await q;
      if (error) return { ok: false, error: error.message };
      const { openEdgeRow } = await import("@/utils/observability/sealedRuns.server");
      const edges: SwarmEdgeView[] = [];
      for (const row of rows ?? []) edges.push((await openEdgeRow(row)) as SwarmEdgeView);
      return { ok: true, edges };
    },
  );

type ScorecardRow = {
  started_at: string;
  output: string | null;
  swarm_runs: { swarm_name: string | null } | { swarm_name: string | null }[] | null;
};

/**
 * The caller's Evaluate scorecards from the last 30 days, oldest first. Only the
 * scores leave the server; what a step wrote around them does not. A key that
 * is gone is asked for once, not once per row, and what could not be opened is
 * counted so the panel can say so.
 */
export const listEvalScorecards = createServerFn({ method: "POST" })
  .validator((v: unknown) => z.object({ access_token: token }).parse(v))
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; items: QualityItem[]; unreadable: number } | { ok: false; error: string }
    > => {
      const user = await callerId(data.access_token);
      if (typeof user !== "string") return { ok: false, error: user.error };
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: rows, error } = await supabaseAdmin
        .from("swarm_run_steps")
        .select("id, started_at, output, swarm_runs(swarm_name)")
        .eq("user_id", user)
        .eq("node_kind", "evaluate")
        .gte("started_at", since)
        .order("started_at", { ascending: true })
        .limit(2000);
      if (error) return { ok: false, error: error.message };

      const { runWhere } = await import("@/utils/observability/sealedRuns.server");
      const { openText, sealedTextKid } = await import("@/utils/providers/crypto.server");
      const { DataKeyUnavailableError } = await import("@/utils/kms/keyHierarchy.server");
      const refused = new Set<string>();
      const items: QualityItem[] = [];
      let unreadable = 0;
      for (const row of (rows ?? []) as unknown as Array<ScorecardRow & { id: string }>) {
        const kid = row.output ? sealedTextKid(row.output) : null;
        if (kid && refused.has(kid)) {
          unreadable++;
          continue;
        }
        let output: string | null;
        try {
          output = row.output
            ? await openText(row.output, runWhere.step(row.id, "output"))
            : row.output;
        } catch (e) {
          unreadable++;
          if (kid && e instanceof DataKeyUnavailableError) refused.add(kid);
          continue;
        }
        const card = parseEvalScorecard(output);
        if (!card) continue;
        const run = Array.isArray(row.swarm_runs) ? row.swarm_runs[0] : row.swarm_runs;
        items.push({
          started_at: row.started_at,
          swarm_name: run?.swarm_name ?? "Untitled swarm",
          overall: card.overall,
          pass: card.pass,
          metrics: card.metrics,
        });
      }
      return { ok: true, items, unreadable };
    },
  );
