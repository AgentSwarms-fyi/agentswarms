// Masking columns in a lakehouse share (R554): the owner's own control in the
// Shares dialog, and a suggestion they approved in the inbox. Both go through
// shareMasking.server's one writer, which checks the share's owner itself.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Fail = { ok: false; error: string };
type Masked = { ok: true; masked: string[]; added: string[] };

const failure = (e: unknown): Fail => ({
  ok: false,
  error: e instanceof Error ? e.message : "Nothing was masked",
});

export const maskShareColumnsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        shareTableId: z.string().uuid(),
        columns: z.array(z.string().trim().min(1).max(128)).min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<Masked | Fail> => {
    try {
      const { maskShareColumns } = await import("./shareMasking.server");
      return await maskShareColumns(data.shareTableId, data.columns, context.userId);
    } catch (e) {
      return failure(e);
    }
  });

export const applyApprovedShareMaskFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ approvalId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }): Promise<(Masked & { shareId: string }) | Fail> => {
    try {
      const { applyApprovedShareMask } = await import("./shareMasking.server");
      return await applyApprovedShareMask(data.approvalId, context.userId);
    } catch (e) {
      return failure(e);
    }
  });
