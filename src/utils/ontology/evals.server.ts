// The verified questions as a test suite: semantic CI for an ontology.
//
// A verified question stores the plan that answered it and a digest of the
// answer. Running the suite re-plans nothing: each stored plan is compiled
// against the model in hand (the owner's draft) and run as the owner, and the
// answer is compared with the digest — the same rows ("same"), different rows
// ("changed": new data, or a definition that moved), or no answer at all
// ("error": the model no longer has what the plan names). Evaluate runs it on
// demand; Publish runs it before a version is frozen, so a change that breaks
// a question people rely on is seen before agents and shares get it.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import type { OntologyAccess } from "@/utils/ontology/access.server";
import { answerDigest, runPlan } from "@/utils/ontology/ask.server";
import { askPlanSchema } from "@/lib/ontology/catalog";
import type { CompileOpts } from "@/lib/ontology/compile";

export type EvalStatus = "same" | "changed" | "error";

export type EvalOutcome = {
  id: string;
  question: string;
  status: EvalStatus;
  rows?: number;
  error?: string;
};

export type EvalSummary = {
  total: number;
  same: number;
  changed: number;
  errors: number;
  results: EvalOutcome[];
};

/** Questions run per evaluation; the rest wait for the next. */
export const EVAL_MAX_QUESTIONS = 500;

/**
 * Run every verified question of `ontologyId` against `access.spec` as
 * `userId`, record each result on its question, and return them.
 */
export async function runVerifiedQuestions(
  userId: string,
  access: OntologyAccess,
  opts: CompileOpts,
  ontologyId: string,
): Promise<EvalSummary> {
  const { data: rows, error } = await supabaseAdmin
    .from("ontology_questions")
    .select("id, question, query, expected")
    .eq("ontology_id", ontologyId)
    .order("created_at", { ascending: true })
    .limit(EVAL_MAX_QUESTIONS);
  if (error) throw new Error(`Could not read the verified questions: ${error.message}`);
  const results: EvalOutcome[] = [];
  for (const q of rows ?? []) {
    const ranAt = new Date().toISOString();
    let outcome: EvalOutcome;
    const plan = askPlanSchema.safeParse(q.query);
    if (!plan.success || plan.data.kind === "refuse") {
      outcome = {
        id: q.id,
        question: q.question,
        status: "error",
        error: "The stored plan is no longer valid",
      };
    } else {
      try {
        const ans = await runPlan(userId, access, opts, plan.data, { verified: null, model: null });
        const d = answerDigest(ans.rows);
        const exp = q.expected as { hash?: string } | null;
        outcome = {
          id: q.id,
          question: q.question,
          status: exp?.hash === d.hash ? "same" : "changed",
          rows: d.rows,
        };
      } catch (e) {
        outcome = {
          id: q.id,
          question: q.question,
          status: "error",
          error: (e as Error).message.slice(0, 500),
        };
      }
    }
    results.push(outcome);
    await supabaseAdmin
      .from("ontology_questions")
      .update({
        last_result: {
          status: outcome.status,
          ...(outcome.rows !== undefined ? { rows: outcome.rows } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ran_at: ranAt,
        } as unknown as Json,
      })
      .eq("id", q.id);
  }
  return {
    total: results.length,
    same: results.filter((r) => r.status === "same").length,
    changed: results.filter((r) => r.status === "changed").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  };
}
