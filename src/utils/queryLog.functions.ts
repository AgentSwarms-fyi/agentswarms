// What the browser tells the query log (R531): a query the workbench ran in
// the browser's own engine, which the server never sees run. The server
// writes it, for the signed-in caller only and only as "workbench" in the
// browser; the figures are the browser's own, and such a query costs nothing
// to anyone but the machine that ran it.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const BrowserRun = z.object({
  sql: z.string().min(1).max(20_000),
  ok: z.boolean(),
  error: z.string().max(2_000).nullish(),
  rowCount: z.number().int().min(0).max(1_000_000_000).nullish(),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3_600_000)
    .nullish(),
});

export const recordBrowserQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => BrowserRun.parse(input))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { userId } = context as { userId: string };
    const { recordQueryRun } = await import("@/utils/queryLog/record.server");
    recordQueryRun({
      userId,
      via: "workbench",
      engine: "browser",
      sql: data.sql,
      ok: data.ok,
      error: data.error ?? null,
      rowCount: data.rowCount ?? null,
      durationMs: data.durationMs ?? null,
    });
    return { ok: true };
  });
