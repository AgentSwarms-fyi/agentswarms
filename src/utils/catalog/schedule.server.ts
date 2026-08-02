// Scheduled Data Catalog crawls. Piggybacks on the same triggers as the
// BI refresh engine: the in-process 60s scheduler and /api/bi/cron both
// call processDueCatalogCrawls(). Each due source is re-crawled with the
// service role (credentials decrypt server-side; {{secret:}} refs resolve
// for the owning user) and the owner is notified when the crawl detects
// schema drift — new, removed or changed assets.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadWarehouseConnectionForUser } from "@/utils/warehouse/connections.server";
import {
  loadStorageConfig,
  runCrawl,
  type CatalogSourceRow,
  type CrawlChanges,
} from "./crawler.server";

const MIN_PROCESS_INTERVAL_MS = 60_000;
const SOURCES_PER_RUN = 3;

export function nextCrawlAt(schedule: string, from = new Date()): string | null {
  if (schedule === "daily") return new Date(from.getTime() + 24 * 3600_000).toISOString();
  if (schedule === "weekly") return new Date(from.getTime() + 7 * 24 * 3600_000).toISOString();
  return null;
}

/** Short human summary of a crawl diff (notification body). */
export function describeChanges(c: CrawlChanges): string {
  const line = (label: string, items: string[]) =>
    items.length === 0
      ? null
      : `${label}: ${items.slice(0, 6).join(", ")}${items.length > 6 ? ` +${items.length - 6} more` : ""}`;
  return [line("Added", c.added), line("Removed", c.removed), line("Schema changed", c.changed)]
    .filter(Boolean)
    .join("\n");
}

let lastProcessed = 0;
let processing = false;

/** Crawl every due catalog source (idempotent, internally throttled). */
export async function processDueCatalogCrawls(force = false): Promise<number> {
  const now = Date.now();
  if (processing) return 0;
  if (!force && now - lastProcessed < MIN_PROCESS_INTERVAL_MS) return 0;
  processing = true;
  lastProcessed = now;
  try {
    const { data: due } = await supabaseAdmin
      .from("catalog_sources")
      .select("*")
      .neq("crawl_schedule", "manual")
      .lte("next_crawl_at", new Date().toISOString())
      .order("next_crawl_at")
      .limit(SOURCES_PER_RUN);
    let ran = 0;
    for (const source of (due ?? []) as CatalogSourceRow[]) {
      // Push the next run out first so a hard failure can't tight-loop.
      await supabaseAdmin
        .from("catalog_sources")
        .update({ next_crawl_at: nextCrawlAt(source.crawl_schedule) })
        .eq("id", source.id);
      try {
        const stats = await runCrawl(
          source.user_id,
          source,
          async (connectionId) =>
            (await loadWarehouseConnectionForUser(supabaseAdmin, { connectionId }, source.user_id))
              .config,
          async (src) => loadStorageConfig(source.user_id, src),
        );
        const { added, removed, changed } = stats.changes;
        if (added.length + removed.length + changed.length > 0) {
          await supabaseAdmin.from("notifications").insert({
            user_id: source.user_id,
            kind: "catalog",
            title: `Catalog changes — "${source.name}"`,
            body: describeChanges(stats.changes).slice(0, 800),
            link: "/data-sql",
          });
        }
      } catch (e) {
        await supabaseAdmin.from("notifications").insert({
          user_id: source.user_id,
          kind: "error",
          title: `Scheduled catalog crawl failed — "${source.name}"`,
          body: (e as Error).message.slice(0, 500),
          link: "/data-sql",
        });
      }
      ran++;
    }
    return ran;
  } finally {
    processing = false;
  }
}
