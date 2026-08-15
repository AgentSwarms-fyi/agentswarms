// Columnar mirror of a dataset: Parquet in object storage, cached on local
// disk, read directly by DuckDB.
//
// THE PROBLEM THIS SOLVES. Rows are stored as one JSONB document each. To
// answer any question we paged every row out over PostgREST — 1,000 at a time,
// so 250 sequential round trips for a 250k-row table — and rebuilt an
// in-memory table. That cost is paid per query, it dwarfs the actual
// computation, and it is why the row caps are as low as they are.
//
// A Parquet mirror replaces those round trips with one compressed columnar
// read that DuckDB projects and filters directly.
//
// THIS IS A CACHE, NEVER A SYSTEM OF RECORD. user_data_rows remains the truth.
// Every read falls back to it when the mirror is absent, stale, or unreadable,
// so a broken mirror can only ever cost speed. `parquet_synced_at` must be at
// least as new as `data_loaded_at` for the mirror to be used — a write that
// fails to refresh the mirror degrades to the slow path rather than serving
// stale numbers.
//
// SECURITY: these objects hold the FULL table with no row filter or column
// mask applied. The bucket is private, nothing is ever signed for a browser,
// and the local cache lives under a server-only directory. Any future
// direct-download path would bypass shared_dataset_rows() and hand a grantee
// the unmasked table.

import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  describeEviction,
  planEviction,
  resolveMode,
  type EvictionPlan,
  type MirrorEntry,
  type StorageMode,
} from "@/lib/capacityPlan";

const BUCKET = "datasets";

/** Datasets below this many rows are not worth mirroring — the round trip to
 *  storage costs more than paging them out of Postgres. */
function minRowsToMirror(): number {
  // An UNSET or blank value must mean "use the default". Number("") is 0, which
  // passes an `n >= 0` test and would silently set the threshold to zero —
  // mirroring every tiny dataset. .env.example ships keys as "" by convention,
  // so that is the common case, not an edge one.
  const raw = (process.env.PARQUET_MIN_ROWS ?? "").trim();
  if (!raw) return 5_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5_000;
}

/**
 * Ceiling on this NODE's on-disk scratch cache. Oldest files evicted past it.
 *
 * Not to be confused with the workspace mirror budget below. This one bounds a
 * local directory and is keyed on file mtime; that one bounds how much of a
 * workspace's data is materialised at all and is keyed on last USE. A node
 * losing a scratch file re-downloads it; a workspace losing a mirror falls back
 * to the row store. Two different costs, two different policies.
 */
function cacheMaxBytes(): number {
  const n = Number(process.env.PARQUET_CACHE_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 2 * 1024 * 1024 * 1024;
}

/**
 * How many bytes of mirrors one workspace may hold. 0 = unlimited.
 *
 * Blank must mean "no budget", not zero — .env keys ship as "" and Number("")
 * is 0, which a naive read would turn into "evict everything".
 */
function mirrorBudgetBytes(): number {
  const raw = (process.env.MIRROR_BUDGET_BYTES ?? "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Above this many rows, `auto` leaves a dataset on direct query. */
function maxRowsToMirror(): number {
  const raw = (process.env.PARQUET_MAX_ROWS ?? "").trim();
  if (!raw) return 5_000_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 5_000_000;
}

export function parquetEnabled(): boolean {
  // Tied to the DuckDB flag: nothing else can read Parquet, so mirroring
  // without it would be pure cost.
  return !/^(0|false|no)$/i.test(process.env.PARQUET_MIRROR ?? "1");
}

/**
 * Where mirrors live on local disk.
 *
 * Exported because it is also the ONLY directory the local DuckDB engine is
 * permitted to touch — `duckdb.server.configureSandbox` passes it to
 * `allowed_directories`. Two definitions of "the cache" would mean the engine
 * being allowed to read a directory the mirror does not use, or refusing to
 * read the one it does.
 */
export function cacheDir(): string {
  return process.env.PARQUET_CACHE_DIR || path.join(tmpdir(), "agentswarms-parquet");
}

/** Storage key for a dataset's mirror. */
export function objectKey(userId: string, tableId: string): string {
  return `${userId}/${tableId}.parquet`;
}

/**
 * Local cache filename.
 *
 * The sync timestamp is part of the name, so a refreshed mirror lands beside
 * the old one rather than overwriting a file a concurrent query is reading —
 * and a stale entry can never be mistaken for a current one.
 */
function cacheFile(tableId: string, syncedAt: string): string {
  const stamp = createHash("sha1").update(syncedAt).digest("hex").slice(0, 12);
  return path.join(cacheDir(), `${tableId}.${stamp}.parquet`);
}

// ── Writing ──────────────────────────────────────────────────────────────

export type MirrorResult = { rows: number; bytes: number } | null;

/**
 * Rewrite a dataset's Parquet mirror from its current rows.
 *
 * Best-effort by contract: returns null instead of throwing, because every
 * caller is finishing a successful data write and a mirror failure must not
 * turn that into a failed upload or a failed refresh.
 */
export async function refreshDatasetMirror(args: {
  userId: string;
  tableId: string;
}): Promise<MirrorResult> {
  if (!parquetEnabled()) return null;
  try {
    const { data: table } = await supabaseAdmin
      .from("user_data_tables")
      .select("id, name, columns, user_id, data_loaded_at, storage_mode")
      .eq("id", args.tableId)
      .maybeSingle();
    if (!table || table.user_id !== args.userId) return null;

    const { count } = await supabaseAdmin
      .from("user_data_rows")
      .select("id", { count: "exact", head: true })
      .eq("table_id", args.tableId);
    const rowCount = count ?? 0;

    // The owner's choice decides, and `auto` falls back to the size heuristic
    // this function used to apply unconditionally. A dataset set to `direct`
    // is never mirrored no matter how convenient a mirror would be — that is
    // the whole point of the setting existing.
    const decision = resolveMode({
      mode: (table.storage_mode as StorageMode) ?? "auto",
      rows: rowCount,
      minRows: minRowsToMirror(),
      maxRows: maxRowsToMirror(),
    });
    if (decision.mode === "direct") {
      // Any existing mirror is now wrong for this dataset's mode, so drop it
      // rather than leave something that looks usable.
      await dropDatasetMirror(args).catch(() => {});
      return null;
    }

    // Page the rows out ONCE, here, off the query path.
    const rows: Record<string, unknown>[] = [];
    const PAGE = 1000;
    for (let start = 0; ; start += PAGE) {
      const { data: chunk, error } = await supabaseAdmin
        .from("user_data_rows")
        .select("row")
        .eq("table_id", args.tableId)
        .range(start, start + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!chunk || chunk.length === 0) break;
      rows.push(...chunk.map((c) => c.row as Record<string, unknown>));
      if (chunk.length < PAGE) break;
    }
    if (rows.length === 0) return null;

    const columns = Array.isArray(table.columns)
      ? (table.columns as { name: string; type: "number" | "string" | "date" }[])
      : [];

    await mkdir(cacheDir(), { recursive: true });
    const scratch = path.join(cacheDir(), `write-${args.tableId}-${Date.now()}.parquet`);

    const { writeTableToParquet } = await import("@/utils/data/duckdb.server");
    await writeTableToParquet({ name: "src", columns, rows }, scratch);

    const bytes = (await stat(scratch)).size;
    const body = await import("node:fs/promises").then((m) => m.readFile(scratch));
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(objectKey(args.userId, args.tableId), body, {
        upsert: true,
        contentType: "application/vnd.apache.parquet",
      });
    await rm(scratch, { force: true });
    if (upErr) throw new Error(upErr.message);

    const syncedAt = new Date().toISOString();
    await supabaseAdmin
      .from("user_data_tables")
      .update({ parquet_synced_at: syncedAt, parquet_rows: rows.length, parquet_bytes: bytes })
      .eq("id", args.tableId);

    return { rows: rows.length, bytes };
  } catch (e) {
    console.warn(`[parquet] mirror refresh failed for ${args.tableId}:`, (e as Error).message);
    return null;
  }
}

/** Remove a dataset's mirror. Called when it goes stale or the dataset dies. */
export async function dropDatasetMirror(args: { userId: string; tableId: string }): Promise<void> {
  await supabaseAdmin.storage.from(BUCKET).remove([objectKey(args.userId, args.tableId)]);
  await supabaseAdmin
    .from("user_data_tables")
    .update({ parquet_synced_at: null, parquet_rows: null, parquet_bytes: null })
    .eq("id", args.tableId);
}

// ── Reading ──────────────────────────────────────────────────────────────

export type MirrorMeta = {
  tableId: string;
  userId: string;
  parquet_synced_at: string | null;
  data_loaded_at: string | null;
};

/** A mirror is usable only when it is at least as new as the last row write. */
export function mirrorIsCurrent(meta: MirrorMeta): boolean {
  if (!meta.parquet_synced_at) return false;
  if (!meta.data_loaded_at) return true;
  return Date.parse(meta.parquet_synced_at) >= Date.parse(meta.data_loaded_at);
}

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Record that a mirror was read, at most once a minute per dataset.
 *
 * Fire-and-forget and deliberately coarse: this feeds an eviction ranking, not
 * an audit trail, and a write on every query would put a database round-trip
 * on the read path to improve a heuristic by nothing.
 */
const lastTouch = new Map<string, number>();
const TOUCH_INTERVAL_MS = 60_000;
function touchMirror(tableId: string): void {
  const now = Date.now();
  if (now - (lastTouch.get(tableId) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouch.set(tableId, now);
  void supabaseAdmin
    .from("user_data_tables")
    .update({ parquet_last_used_at: new Date(now).toISOString() })
    .eq("id", tableId)
    .then(
      () => {},
      () => {},
    );
}

/**
 * Drop mirrors until a workspace fits its budget.
 *
 * Returns what it dropped so the caller can SAY so. Eviction costs speed and
 * never correctness — an evicted dataset still answers from the row store —
 * but "your dashboard got slower and nobody mentioned it" is its own kind of
 * dishonesty, so nothing here is silent.
 */
export async function enforceMirrorBudget(userId: string): Promise<EvictionPlan | null> {
  const budget = mirrorBudgetBytes();
  if (!parquetEnabled() || budget <= 0) return null;
  const { data: rows } = await supabaseAdmin
    .from("user_data_tables")
    .select("id, name, storage_mode, parquet_bytes, parquet_rows, parquet_last_used_at")
    .eq("user_id", userId)
    .not("parquet_bytes", "is", null);

  const entries: MirrorEntry[] = (rows ?? []).map((r) => ({
    tableId: r.id,
    name: r.name,
    bytes: Number(r.parquet_bytes ?? 0),
    rows: Number(r.parquet_rows ?? 0),
    mode: (r.storage_mode as StorageMode) ?? "auto",
    lastUsedAt: r.parquet_last_used_at,
  }));

  const plan = planEviction(entries, budget);
  for (const e of plan.evict) {
    await dropDatasetMirror({ userId, tableId: e.tableId }).catch(() => {});
  }
  return plan;
}

/**
 * Local path to a dataset's Parquet, downloading it if needed.
 *
 * Returns null whenever the mirror can't be used, which the caller treats as
 * "read the rows the old way". Concurrent callers for the same file share one
 * download rather than racing.
 */
export async function localParquetPath(meta: MirrorMeta): Promise<string | null> {
  if (!parquetEnabled() || !mirrorIsCurrent(meta)) return null;
  const target = cacheFile(meta.tableId, meta.parquet_synced_at!);
  // Stamp the READ, not the write. Eviction ranks by last use, and ranking by
  // last refresh would evict the stable table nobody changes precisely because
  // nobody changes it — while it is being queried every hour.
  touchMirror(meta.tableId);
  if (existsSync(target)) return target;

  const existing = inFlight.get(target);
  if (existing) return existing;

  const job = (async (): Promise<string | null> => {
    try {
      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .download(objectKey(meta.userId, meta.tableId));
      if (error || !data) return null;
      const buf = Buffer.from(await data.arrayBuffer());
      await mkdir(cacheDir(), { recursive: true });
      // Write to a scratch name and rename: a reader must never observe a
      // half-written Parquet, and rename is atomic within a directory.
      const scratch = `${target}.${process.pid}.part`;
      await writeFile(scratch, buf);
      await rename(scratch, target);
      void evictCache().catch(() => {});
      return target;
    } catch (e) {
      console.warn(`[parquet] download failed for ${meta.tableId}:`, (e as Error).message);
      return null;
    } finally {
      inFlight.delete(target);
    }
  })();
  inFlight.set(target, job);
  return job;
}

// ── Scheduled maintenance ────────────────────────────────────────────────

/**
 * Heal mirrors the write paths could not.
 *
 * Browser-side saves (CSV upload, warehouse import, the in-browser prep save)
 * write rows through RLS and have no way to rebuild a mirror. They do bump
 * `data_loaded_at`, so the mirror is correctly IGNORED as stale — but it would
 * stay stale for ever without this. Also removes objects for datasets that no
 * longer exist, which nothing else would ever clean up.
 *
 * Bounded per pass so one sweep can never monopolise the scheduler.
 */
export async function sweepDatasetMirrors(): Promise<{
  refreshed: number;
  removed: number;
  evicted: number;
}> {
  if (!parquetEnabled()) return { refreshed: 0, removed: 0, evicted: 0 };
  const PER_PASS = 5;
  let refreshed = 0;
  let removed = 0;
  let evicted = 0;

  try {
    // Stale: a mirror exists but predates the last row write.
    const { data: stale } = await supabaseAdmin
      .from("user_data_tables")
      .select("id, user_id, parquet_synced_at, data_loaded_at")
      .not("parquet_synced_at", "is", null)
      .order("data_loaded_at", { ascending: false })
      .limit(200);
    for (const t of stale ?? []) {
      if (refreshed >= PER_PASS) break;
      if (!t.user_id) continue;
      if (
        mirrorIsCurrent({
          tableId: t.id,
          userId: t.user_id,
          parquet_synced_at: t.parquet_synced_at,
          data_loaded_at: t.data_loaded_at,
        })
      ) {
        continue;
      }
      const res = await refreshDatasetMirror({ userId: t.user_id, tableId: t.id });
      if (res) refreshed++;
    }
  } catch (e) {
    console.warn("[parquet] stale sweep failed:", (e as Error).message);
  }

  try {
    // Orphans: an object whose dataset was deleted. Listing is per user
    // folder, so this walks a bounded slice of users each pass.
    const { data: folders } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: 50 });
    for (const folder of folders ?? []) {
      const { data: objects } = await supabaseAdmin.storage
        .from(BUCKET)
        .list(folder.name, { limit: 200 });
      const ids = (objects ?? [])
        .map((o) => o.name.replace(/\.parquet$/, ""))
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      if (ids.length === 0) continue;
      const { data: alive } = await supabaseAdmin
        .from("user_data_tables")
        .select("id")
        .in("id", ids);
      const live = new Set((alive ?? []).map((t) => t.id));
      const dead = ids.filter((id) => !live.has(id));
      if (dead.length > 0) {
        await supabaseAdmin.storage
          .from(BUCKET)
          .remove(dead.map((id) => `${folder.name}/${id}.parquet`));
        removed += dead.length;
      }
    }
  } catch (e) {
    console.warn("[parquet] orphan sweep failed:", (e as Error).message);
  }

  // Budget: bring each workspace that holds mirrors back under its ceiling.
  // Runs last, after refreshes, so it measures the sizes that actually exist
  // rather than the ones that existed before this pass rewrote them.
  try {
    if (mirrorBudgetBytes() > 0) {
      const { data: owners } = await supabaseAdmin
        .from("user_data_tables")
        .select("user_id")
        .not("parquet_bytes", "is", null)
        .limit(500);
      const seen = new Set<string>();
      for (const o of owners ?? []) {
        if (!o.user_id || seen.has(o.user_id)) continue;
        seen.add(o.user_id);
        const plan = await enforceMirrorBudget(o.user_id);
        if (!plan || plan.evict.length === 0) continue;
        evicted += plan.evict.length;
        // Named, not silent: a dashboard that got slower with no explanation
        // is its own kind of dishonesty.
        const { notifyUser } = await import("@/utils/notify.server");
        await notifyUser(o.user_id, {
          title: "Mirrors evicted to stay within the capacity budget",
          body: describeEviction(plan) ?? "",
          link: "/data-sql",
          kind: "info",
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("[parquet] budget sweep failed:", (e as Error).message);
  }

  return { refreshed, removed, evicted };
}

/** Drop the oldest cached files once the directory exceeds its ceiling. */
async function evictCache(): Promise<void> {
  const dir = cacheDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const files: { file: string; size: number; mtime: number }[] = [];
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith(".parquet")) continue;
    try {
      const s = await stat(path.join(dir, name));
      files.push({ file: path.join(dir, name), size: s.size, mtime: s.mtimeMs });
      total += s.size;
    } catch {
      /* vanished under us */
    }
  }
  const limit = cacheMaxBytes();
  if (total <= limit) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= limit) break;
    await rm(f.file, { force: true }).catch(() => {});
    total -= f.size;
  }
}
