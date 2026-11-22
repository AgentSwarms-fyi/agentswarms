// The dataset page's one server read: what of the reader's is built on a
// dataset. Everything else on the page comes from reads that already exist
// (the dataset row, its sample, its checks and versions, its grants).
//
// Read with the reader's own token, so row-level security limits it to their
// own objects: an owner sees what they built on their dataset, a grantee what
// they built on the copy shared with them, and nobody sees anyone else's.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DatasetDependents } from "@/lib/datasetDependents";
import { agentsReading, analystsReading, type ReadersOf } from "@/lib/datasetPage";

export type DatasetUsage = DatasetDependents & {
  /** AI analysts that read it by name, and how many read every dataset. */
  analysts: ReadersOf;
  /** Agents whose SQL tool lists it, and how many may read every dataset. */
  agents: ReadersOf;
};

export const datasetUsageFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({ tableId: z.string().uuid(), tableName: z.string().trim().min(1).max(200) })
      .parse(input),
  )
  .handler(
    async ({
      context,
      data,
    }): Promise<{ ok: true; usage: DatasetUsage } | { ok: false; error: string }> => {
      try {
        const { computeDatasetDependents } = await import("@/utils/data/datasetDependents.server");
        const sb = context.supabase;
        const [deps, analysts, agents] = await Promise.all([
          computeDatasetDependents(sb, data.tableId, data.tableName),
          sb.from("ai_analysts").select("id, name, source"),
          sb.from("agents").select("id, name, tools"),
        ]);
        return {
          ok: true,
          usage: {
            ...deps,
            analysts: analystsReading(analysts.data ?? [], data.tableName),
            agents: agentsReading(agents.data ?? [], data.tableName),
          },
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "What uses it could not be read",
        };
      }
    },
  );
