// Writes one row of the query log (R531). Called where every query passes:
// the warehouse driver seam, the lakehouse statement runner, the server's
// local engine, the object-store reader, and the workbench's report of what
// it ran in the browser.
//
// The SERVICE ROLE writes, because the table has no client write policy: a
// record of what a query cost is not something its owner may edit. It never
// throws and never waits on the caller: a query that ran is never failed, or
// slowed, by its record failing to land.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { queryLogRow, scanPricesFrom, estimateScanCost, type QueryRun } from "@/lib/queryLog";

export type { QueryRun };

export function recordQueryRun(run: QueryRun): void {
  // A query nobody is attached to (a catalog crawl, a connection test) is
  // housekeeping, not anyone's history.
  if (!run.userId) return;
  try {
    const row = queryLogRow(run);
    void Promise.resolve(supabaseAdmin.from("query_log").insert(row)).then(
      ({ error }) => {
        if (error) console.warn("[query-log] not recorded:", error.message);
      },
      (e: unknown) => console.warn("[query-log] not recorded:", (e as Error)?.message ?? e),
    );
  } catch (e) {
    console.warn("[query-log] not recorded:", (e as Error)?.message ?? e);
  }
}

/** The cost of a query that read `bytes` on `engine`, at this server's prices. */
export function scanCostHere(engine: string, bytes: number | null | undefined) {
  return estimateScanCost(engine, bytes, scanPricesFrom(process.env));
}
