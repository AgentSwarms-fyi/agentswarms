// RPC surface for decision provenance: "where did this answer come from?"
//
// One call returns the whole chain a decision touched -- the model turns, the
// data reads, the approvals, the cost -- keyed by the id stamped on every row
// while the decision was underway. See provenance/decision.server.ts for the
// model; this file only exposes it to a signed-in owner.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getDecisionChain, type DecisionChain } from "@/utils/provenance/decision.server";
import { getPassport, type Passport } from "@/utils/provenance/passport.server";
import { replayDecision as runReplay, type ReplayResult } from "@/utils/provenance/replay.server";

export type { DecisionChain } from "@/utils/provenance/decision.server";

export const getDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ decisionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<DecisionChain | null> => {
    // Owner-scoped inside: a decision id from another tenant yields null, not
    // a 403 that would confirm the id exists.
    return getDecisionChain(context.userId, data.decisionId);
  });

/**
 * The same chain as a portable, signed document.
 *
 * Separate from getDecision because the passport is an artifact someone keeps
 * and sends on: it carries the exact bytes that were signed, so a recipient can
 * verify it without this instance re-deriving anything.
 */
export const getPassportForDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ decisionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Passport | null> => {
    return getPassport(context.userId, data.decisionId);
  });

/**
 * Re-run the decision's data reads and report what has changed.
 *
 * Deliberately not folded into getDecision: assembling a chain reads rows,
 * while this EXECUTES queries against the warehouse. Those have different
 * costs and different failure modes, and a screen that quietly ran queries
 * every time someone opened a trace would be a bad neighbour.
 */
export const replayDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ decisionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<ReplayResult | null> => {
    return runReplay(context.userId, data.decisionId);
  });

export type { ReplayResult } from "@/utils/provenance/replay.server";
