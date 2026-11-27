// A change the assistant proposed (R553), carried out on its owner's yes. The
// inbox records the decision; this carries it out through actions.server,
// which checks the owner and the thing again, once.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Fail = { ok: false; error: string };

export const applyApprovedAssistantActionFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ approvalId: z.string().uuid() }).parse(input))
  .handler(
    async ({ context, data }): Promise<{ ok: true; message: string; link: string } | Fail> => {
      try {
        const { applyApprovedAssistantAction } = await import("@/utils/assistant/actions.server");
        return await applyApprovedAssistantAction(data.approvalId, context.userId);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Nothing was changed" };
      }
    },
  );
