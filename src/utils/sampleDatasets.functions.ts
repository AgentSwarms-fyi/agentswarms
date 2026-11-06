// Filling in the shared sample datasets, for the page that shows them (R454). A caller
// says only whether to refill: what goes in is the server's own, so being signed in is
// all this asks.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure } from "@/utils/callerLookup.server";

export const seedSampleDatasetsFn = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z.object({ access_token: z.string().min(1), refill: z.boolean() }).parse(v),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; seeded: boolean } | { ok: false; error: string }> => {
      const { data: who, error } = await supabaseAdmin.auth.getUser(data.access_token);
      if (error || !who?.user) return { ok: false, error: callerFailure(error, "Unauthorized") };
      try {
        const { seedSampleDatasets } = await import("@/utils/data/sampleDatasets.server");
        return { ok: true, seeded: await seedSampleDatasets({ refill: data.refill }) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
