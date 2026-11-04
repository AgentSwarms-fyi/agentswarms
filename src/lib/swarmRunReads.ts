// A swarm run's trace, for Swarm Traces and Quality trends. Since R449 what a run
// keeps is sealed under the user's key, which the browser does not hold, so it
// is read through the server (src/utils/swarmRuns.functions.ts); this gives it
// back as `{ data, error }`, as Supabase did, so the pages' error handling stays
// what it was.
import { withToken } from "@/lib/chatHistory";
import {
  getSwarmRun,
  listEvalScorecards,
  listSwarmRunEdges,
  listSwarmRunSteps,
} from "@/utils/swarmRuns.functions";

/** One of the signed-in user's runs. */
export async function runById(id: string) {
  const r = await withToken((t) => getSwarmRun({ data: { access_token: t, run_id: id } }));
  return { data: r.data?.run ?? null, error: r.error };
}

/** A page of a run's steps, by id. */
export async function runSteps(runId: string, after: string | null, size: number) {
  const r = await withToken((t) =>
    listSwarmRunSteps({ data: { access_token: t, run_id: runId, after, size } }),
  );
  return { data: r.data?.steps ?? null, error: r.error };
}

/** A page of a run's links, by id. */
export async function runEdges(runId: string, after: string | null, size: number) {
  const r = await withToken((t) =>
    listSwarmRunEdges({ data: { access_token: t, run_id: runId, after, size } }),
  );
  return { data: r.data?.edges ?? null, error: r.error };
}

/** The signed-in user's Evaluate scorecards from the last 30 days. */
export async function evalScorecards() {
  const r = await withToken((t) => listEvalScorecards({ data: { access_token: t } }));
  return { data: r.data ?? null, error: r.error };
}
