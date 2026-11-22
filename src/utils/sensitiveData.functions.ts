// Hiding a dataset's personal columns from its shares (R521): the owner's
// button on the dataset page, and the owner's yes in the approvals inbox. Both
// run sensitiveShares.server's one implementation, which checks ownership
// against the dataset itself.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Hidden = { ok: true; changed: number; grants: number; columns: string[] };
type Fail = { ok: false; error: string };

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export const hideColumnsFromSharesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        datasetId: z.string().uuid(),
        columns: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<Hidden | Fail> => {
    try {
      const { hideColumnsFromShares } = await import("@/utils/data/sensitiveShares.server");
      return await hideColumnsFromShares(data.datasetId, data.columns, context.userId);
    } catch (e) {
      return { ok: false, error: message(e, "The columns could not be hidden") };
    }
  });

export const applyApprovedColumnHideFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ approvalId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }): Promise<Hidden | Fail> => {
    try {
      const { applyApprovedColumnHide } = await import("@/utils/data/sensitiveShares.server");
      return await applyApprovedColumnHide(data.approvalId, context.userId);
    } catch (e) {
      return { ok: false, error: message(e, "The columns could not be hidden") };
    }
  });
