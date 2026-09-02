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

export type { DecisionChain } from "@/utils/provenance/decision.server";

export const getDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ decisionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<DecisionChain | null> => {
    // Owner-scoped inside: a decision id from another tenant yields null, not
    // a 403 that would confirm the id exists.
    return getDecisionChain(context.userId, data.decisionId);
  });
