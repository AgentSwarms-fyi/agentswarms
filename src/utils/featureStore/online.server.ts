/**
 * Filling the online store, and reading from it.
 *
 * The refresh is the ONLY thing here that touches the lakehouse, and it goes
 * through `runLakehouseStatement` like every other read: the owner's schema
 * access, the row-level policies, the row cap and the audit row all still
 * apply, because a serving path that opened its own connection would be a way
 * to read a table the caller cannot read.
 *
 * The read path touches nothing but the store. That is the point of it.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ageMinutes,
  completenessNote,
  DEFAULT_MAX_KEYS,
  DEFAULT_STALE_MINUTES,
  keyTtlSeconds,
  metaKey,
  nextPageRows,
  onlineKey,
  REFRESH_PAGE_ROWS,
  shouldContinue,
  storeRefusal,
  viewDefinition,
  viewKeyPattern,
  type OnlineMeta,
  type Refusal,
  type RefreshProgress,
} from "@/lib/featureStore";
import {
  keyFingerprint,
  keyLabel,
  scanSql,
  type FeatureKey,
  type FeatureView,
} from "@/lib/featureViews";
import { call, featureStoreUrl, one, storeStatus } from "@/utils/featureStore/client.server";
import { runLakehouseStatement } from "@/utils/lakehouse/core.server";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** How stale this view's rows may be: its own setting, else the instance's. */
export function staleMinutesFor(view: { online_max_staleness_minutes?: number | null }): number {
  return (
    view.online_max_staleness_minutes ??
    envInt("FEATURE_STORE_STALE_MINUTES", DEFAULT_STALE_MINUTES)
  );
}

export function maxKeys(): number {
  return envInt("FEATURE_STORE_MAX_KEYS", DEFAULT_MAX_KEYS);
}

type ViewRow = FeatureView & {
  online_enabled?: boolean;
  online_max_staleness_minutes?: number | null;
};

async function readMeta(viewId: string): Promise<OnlineMeta | null> {
  const raw = await one(["GET", metaKey(viewId)]);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as OnlineMeta;
  } catch {
    return null;
  }
}

/**
 * Read features for keys from the store.
 *
 * Returns null when the store cannot answer AT ALL — not configured, breaker
 * open, never refreshed, view changed, or stale — and the caller reads the
 * lakehouse. Returns rows plus the keys it did not hold, so a partially
 * populated store still saves the round trips it can.
 */
export async function readOnline(
  view: ViewRow,
  keys: FeatureKey[],
): Promise<{
  rows: Record<string, unknown>[];
  misses: FeatureKey[];
  meta: OnlineMeta;
} | null> {
  if (!view.online_enabled || !featureStoreUrl()) return null;
  if (storeStatus().breakerOpen) return null;

  const meta = await readMeta(view.id);
  const refusal = storeRefusal(meta, viewDefinition(view), new Date(), staleMinutesFor(view));
  if (refusal || !meta) return null;

  const fingerprints = keys.map((k) => keyFingerprint(view, k));
  const got = await one(["MGET", ...fingerprints.map((f) => onlineKey(view.id, f))]);
  if (!Array.isArray(got) || got.length !== keys.length) return null;

  const rows: Record<string, unknown>[] = [];
  const misses: FeatureKey[] = [];
  got.forEach((v, i) => {
    if (typeof v !== "string") {
      misses.push(keys[i]);
      return;
    }
    try {
      rows.push(JSON.parse(v) as Record<string, unknown>);
    } catch {
      // A value that will not parse is a value that must not be served. It
      // counts as a miss, so the key is read from the lakehouse instead.
      misses.push(keys[i]);
    }
  });
  return { rows, misses, meta };
}

/** Why the store did not answer, for the panel and the logs. */
export async function refusalFor(view: ViewRow): Promise<Refusal | "off" | "unreachable" | null> {
  if (!view.online_enabled) return "off";
  if (!featureStoreUrl() || storeStatus().breakerOpen) return "unreachable";
  const meta = await readMeta(view.id);
  return storeRefusal(meta, viewDefinition(view), new Date(), staleMinutesFor(view));
}

export type RefreshResult =
  | { ok: true; rows: number; sourceRows: number | null; note: string | null; seconds: number }
  | { ok: false; error: string };

/**
 * Copy the view's latest row per key into the store.
 *
 * Paged by KEY, never by offset, and every page is one pipelined write. The
 * scan reports how many rows shared each key, which is what lets a view whose
 * key is not unique be refused rather than half-copied — the SQL's own comment
 * explains why that mattered.
 */
export async function refreshView(view: ViewRow, userId: string): Promise<RefreshResult> {
  const started = Date.now();
  if (!featureStoreUrl()) {
    return { ok: false, error: "No online feature store is configured (FEATURE_STORE_URL)." };
  }

  const cap = maxKeys();
  const ttl = keyTtlSeconds(staleMinutesFor(view));
  const progress: RefreshProgress = { written: 0, pages: 0, reachedEnd: false };
  let after: FeatureKey | null = null;

  // Written to a fresh generation? No — the same keys are overwritten in place
  // and the TTL expires whatever a later refresh no longer writes. A
  // generation counter would be cleaner in theory and would double the store's
  // memory at the moment of the swap, which on a bounded store means evicting
  // the very rows being rebuilt.
  while (shouldContinue(progress, cap)) {
    const want = nextPageRows(progress, cap, REFRESH_PAGE_ROWS);
    if (want === 0) break;

    let page;
    try {
      page = await runLakehouseStatement(userId, scanSql(view, after, want), {
        rowCap: want,
        auditVia: "feature-store-refresh",
        useCache: false,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    const names = page.columns.map((c) => c.name);
    const rows = (page.rows as unknown[][]).map((r) => {
      const row: Record<string, unknown> = {};
      names.forEach((n, i) => (row[n] = r[i]));
      return row;
    });
    if (rows.length === 0) {
      progress.reachedEnd = true;
      break;
    }

    // A key that is not unique, on a view that claims it is. Refused rather
    // than resolved: which of the two rows would be served is decided by
    // nothing the owner chose, and the model would never know.
    if (!view.timestamp_column) {
      const dup = rows.find((r) => Number(r._fv_n) > 1);
      if (dup) {
        return {
          ok: false,
          error:
            `${view.name} has more than one row for ${keyLabel(view, dup as FeatureKey)}. ` +
            `Give the view a timestamp column so the latest row wins, or make the key unique.`,
        };
      }
    }

    const writes: (string | number)[][] = rows.map((row) => {
      const stored: Record<string, unknown> = {};
      // Only the declared columns, and never the scan's own bookkeeping: _fv_n
      // is how the page reported duplicates, not a feature anybody trained on.
      for (const c of [...view.key_columns, ...view.feature_columns]) stored[c] = row[c];
      return [
        "SET",
        onlineKey(view.id, keyFingerprint(view, row as FeatureKey)),
        JSON.stringify(stored),
        "EX",
        ttl,
      ];
    });
    const acks = await call(writes);
    if (!acks) {
      return {
        ok: false,
        error: `The online store stopped answering after ${progress.written} keys — ${storeStatus().error ?? "no reason given"}.`,
      };
    }

    progress.written += rows.length;
    progress.pages += 1;
    const last = rows[rows.length - 1];
    after = Object.fromEntries(
      view.key_columns.map((c) => [c, last[c] as string | number]),
    ) as FeatureKey;
    if (rows.length < want) progress.reachedEnd = true;
  }

  const meta: OnlineMeta = {
    refreshed_at: new Date().toISOString(),
    rows: progress.written,
    source_rows: progress.reachedEnd ? progress.written : null,
    def: viewDefinition(view),
  };
  const wroteMeta = await one(["SET", metaKey(view.id), JSON.stringify(meta), "EX", ttl]);
  if (wroteMeta === null) {
    return { ok: false, error: "The online store did not accept this view's refresh marker." };
  }

  return {
    ok: true,
    rows: meta.rows,
    sourceRows: meta.source_rows,
    note: completenessNote(meta),
    seconds: (Date.now() - started) / 1000,
  };
}

/** Forget everything stored for a view — on delete, or when its shape changes. */
export async function dropView(viewId: string): Promise<void> {
  if (!featureStoreUrl()) return;
  let cursor = "0";
  for (let guard = 0; guard < 10_000; guard++) {
    const res = await one(["SCAN", cursor, "MATCH", viewKeyPattern(viewId), "COUNT", 500]);
    if (!Array.isArray(res) || res.length !== 2) return;
    const [next, found] = res as [string, string[]];
    if (Array.isArray(found) && found.length > 0) await call([["DEL", ...found]]);
    cursor = String(next);
    if (cursor === "0") return;
  }
}

/** What the panel shows about a view's store. */
export async function onlineSummary(view: ViewRow): Promise<{
  configured: boolean;
  enabled: boolean;
  meta: OnlineMeta | null;
  ageMinutes: number | null;
  refusal: Refusal | "off" | "unreachable" | null;
  note: string | null;
  staleAfterMinutes: number;
}> {
  const configured = featureStoreUrl() !== null;
  const meta = configured && !storeStatus().breakerOpen ? await readMeta(view.id) : null;
  return {
    configured,
    enabled: Boolean(view.online_enabled),
    meta,
    ageMinutes: meta ? ageMinutes(meta, new Date()) : null,
    refusal: await refusalFor(view),
    note: meta ? completenessNote(meta) : null,
    staleAfterMinutes: staleMinutesFor(view),
  };
}

/** Keep the row's own record of its store in step with what was written. */
export async function recordRefresh(
  viewId: string,
  userId: string,
  r: RefreshResult,
): Promise<void> {
  await supabaseAdmin
    .from("feature_views")
    .update(
      r.ok
        ? {
            online_refreshed_at: new Date().toISOString(),
            online_rows: r.rows,
            online_source_rows: r.sourceRows,
            online_error: null,
          }
        : { online_error: r.error },
    )
    .eq("id", viewId)
    .eq("user_id", userId);
}
