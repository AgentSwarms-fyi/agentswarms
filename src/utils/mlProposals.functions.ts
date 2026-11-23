// A model proposed in chat, trained on its owner's yes (R527). The inbox
// records the decision; this carries it out, through proposeTraining.server,
// which checks the owner and the table again.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Fail = { ok: false; error: string; modelId?: string };

export const applyApprovedTrainingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ approvalId: z.string().uuid() }).parse(input))
  .handler(
    async ({ context, data }): Promise<{ ok: true; modelId: string; message: string } | Fail> => {
      try {
        const { applyApprovedTraining } = await import("@/utils/ml/proposeTraining.server");
        return await applyApprovedTraining(data.approvalId, context.userId);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Training did not start" };
      }
    },
  );
