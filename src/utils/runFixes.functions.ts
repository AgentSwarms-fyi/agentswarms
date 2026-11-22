// What failed and how to fix it (R525): the Runs page asks, its owner applies,
// or the owner's yes in the approvals inbox carries out a suggestion. All go
// through runFixes.server, which checks ownership against the thing itself.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { FixVerdict } from "@/lib/runFixes";

const target = z.object({
  type: z.enum(["data_monitor", "etl_pipeline"]),
  id: z.string().uuid(),
});
const fix = z.discriminatedUnion("fix", [
  z.object({ fix: z.literal("pause") }),
  z.object({
    fix: z.literal("timestamp_column"),
    column: z.string().trim().min(1).max(128),
    from: z.string().max(128).nullable(),
  }),
]);

type Fail = { ok: false; error: string };
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export const diagnoseRunFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ target }).parse(input))
  .handler(async ({ context, data }): Promise<{ ok: true; verdict: FixVerdict } | Fail> => {
    try {
      const { diagnoseRun } = await import("@/utils/runFixes.server");
      const verdict = await diagnoseRun(data.target, context.userId);
      return verdict ? { ok: true, verdict } : { ok: false, error: "It is not here, or not yours" };
    } catch (e) {
      return { ok: false, error: message(e, "It could not be read") };
    }
  });

export const applyRunFixFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ target, fix }).parse(input))
  .handler(async ({ context, data }): Promise<{ ok: true; message: string } | Fail> => {
    try {
      const { applyRunFix } = await import("@/utils/runFixes.server");
      return await applyRunFix(data.target, data.fix, context.userId);
    } catch (e) {
      return { ok: false, error: message(e, "The change was not made") };
    }
  });

export const applyApprovedRunFixFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ approvalId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }): Promise<{ ok: true; message: string } | Fail> => {
    try {
      const { applyApprovedRunFix } = await import("@/utils/runFixes.server");
      return await applyApprovedRunFix(data.approvalId, context.userId);
    } catch (e) {
      return { ok: false, error: message(e, "The change was not made") };
    }
  });
