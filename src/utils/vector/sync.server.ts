// Keeping the external vector index in step with Postgres, by itself.
//
// Every embedding is a column on its `kb_chunks` row; Qdrant holds a copy, and
// a copy can fall behind. A volume lost or restored, an install switched to
// Qdrant after its documents were embedded (an older .env the installer has
// just wired, R417), a delete made while the index was down. Until R417 the
// symptom was retrieval quietly getting worse, and the repair was a superadmin
// pressing Re-index. Now three things happen without anybody:
//
//   - retrieval asks, per knowledge base, whether the index holds exactly the
//     vectors Postgres has (two exact counts, remembered for a few minutes),
//     and searches Postgres's own copy for any that it does not. The same
//     vectors, so the same answers, from the database;
//   - a knowledge base found out of step is repaired in the background: the
//     ids are compared, the missing vectors copied from Postgres (never
//     re-embedded) and the stale ones removed;
//   - the scheduler pass checks every knowledge base on the index every few
//     minutes, so one nobody is querying is repaired too.
//
// Every write is an upsert or a delete by id. Two workers repairing the same
// knowledge base at once do the work twice and leave the same result, and
// neither can make the other's search miss: a knowledge base is searched in
// the index only once its counts agree.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { externalIndex, storeKindByKnowledgeBase, vectorStoreIsExternal } from "./store.server";
import { parseEmbedding, type IndexMaintenance, type VectorPoint, type VectorStore } from "./types";

type Index = VectorStore & IndexMaintenance;

/** What one check found for one knowledge base. */
export type IndexVerdict = {
  knowledgeBaseId: string;
  /** Chunks with an embedding in Postgres: what the index should hold. */
  expected: number;
  /** Vectors the index holds for it. */
  held: number;
  checkedAt: number;
  /** Set when either count could not be read; the index is then not trusted. */
  error?: string;
};

export type RepairResult = { copied: number; removed: number };

export type IndexSyncSummary = {
  at: string;
  /** Knowledge bases whose vectors belong in the external index. */
  knowledgeBases: number;
  inStep: number;
  repaired: number;
  copied: number;
  removed: number;
  expected: number;
  held: number;
  /** "knowledge base id: reason", for the ones that could not be checked or repaired. */
  failures: string[];
};

/** A verdict is trusted this long. 0 trusts the index without checking. */
function checkTtlMs(): number {
  const raw = process.env.VECTOR_INDEX_CHECK_SECONDS;
  const n = raw === undefined || raw.trim() === "" ? 300 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 300_000;
}

/** How often the scheduler checks every knowledge base. 0 turns the sweep off. */
function sweepEveryMs(): number {
  const raw = process.env.VECTOR_INDEX_SYNC_MINUTES;
  const n = raw === undefined || raw.trim() === "" ? 10 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : 600_000;
}

/** Rows read from Postgres per request: ids, or ids with their vectors. */
const ID_PAGE = 1000;
const VECTOR_PAGE = 200;
/** Knowledge bases checked at once, in a sweep or a status read. */
const CHECK_CONCURRENCY = 8;

const verdicts = new Map<string, IndexVerdict>();
const checking = new Map<string, Promise<IndexVerdict>>();
const repairing = new Map<string, Promise<RepairResult>>();
let lastSweepAt = 0;
let lastSummary: IndexSyncSummary | null = null;

export function inStep(v: IndexVerdict): boolean {
  return !v.error && v.held === v.expected;
}

/** Chunks with an embedding: the number the index should hold for this knowledge base. */
async function expectedVectors(knowledgeBaseId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("kb_chunks")
    .select("id", { count: "exact", head: true })
    .eq("knowledge_base_id", knowledgeBaseId)
    .not("embedding", "is", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function checkNow(index: Index, knowledgeBaseId: string): Promise<IndexVerdict> {
  const at = Date.now();
  try {
    const [expected, held] = await Promise.all([
      expectedVectors(knowledgeBaseId),
      index.countByKnowledgeBase(knowledgeBaseId),
    ]);
    return { knowledgeBaseId, expected, held, checkedAt: at };
  } catch (e) {
    return {
      knowledgeBaseId,
      expected: 0,
      held: 0,
      checkedAt: at,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** A count that failed is retried this soon, whatever the check window says. */
const FAILED_CHECK_TTL_MS = 30_000;

/**
 * One check per knowledge base at a time, and a verdict younger than
 * `maxAgeMs` is reused. 0 always counts afresh. A FAILED count is reused for
 * 30 s at most: measured (R417), with the five-minute window a Qdrant that came
 * back was still bypassed for up to five minutes — right answers, from the
 * slower place.
 */
function check(index: Index, knowledgeBaseId: string, maxAgeMs: number): Promise<IndexVerdict> {
  const known = verdicts.get(knowledgeBaseId);
  const reuseFor = known?.error ? Math.min(maxAgeMs, FAILED_CHECK_TTL_MS) : maxAgeMs;
  if (known && reuseFor > 0 && Date.now() - known.checkedAt <= reuseFor) {
    return Promise.resolve(known);
  }
  const running = checking.get(knowledgeBaseId);
  if (running) return running;
  const started = checkNow(index, knowledgeBaseId)
    .then((v) => {
      verdicts.set(knowledgeBaseId, v);
      return v;
    })
    .finally(() => checking.delete(knowledgeBaseId));
  checking.set(knowledgeBaseId, started);
  return started;
}

/** Every chunk id with an embedding in this knowledge base. */
async function embeddedChunkIds(knowledgeBaseId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += ID_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("kb_chunks")
      .select("id")
      .eq("knowledge_base_id", knowledgeBaseId)
      .not("embedding", "is", null)
      .order("id", { ascending: true })
      .range(from, from + ID_PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as { id: string }[];
    for (const r of page) ids.add(r.id);
    if (page.length < ID_PAGE) return ids;
  }
}

/** Copy these chunks' vectors from Postgres into the index. Never re-embeds. */
async function copyChunks(index: Index, ids: string[]): Promise<number> {
  let copied = 0;
  for (let i = 0; i < ids.length; i += VECTOR_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("kb_chunks")
      .select("id, document_id, knowledge_base_id, embedding")
      .in("id", ids.slice(i, i + VECTOR_PAGE));
    if (error) throw new Error(error.message);
    const points: VectorPoint[] = [];
    for (const r of (data ?? []) as {
      id: string;
      document_id: string;
      knowledge_base_id: string;
      embedding: string | number[] | null;
    }[]) {
      // Deleted or re-chunked since the ids were read: nothing to copy, and the
      // next check settles it.
      const embedding = parseEmbedding(r.embedding);
      if (!embedding) continue;
      points.push({
        id: r.id,
        embedding,
        knowledgeBaseId: r.knowledge_base_id,
        documentId: r.document_id,
      });
    }
    await index.upsert(points);
    copied += points.length;
  }
  return copied;
}

/**
 * Make the index hold exactly the vectors Postgres has for one knowledge base.
 *
 * By id, never by emptying it first: a knowledge base being repaired is still
 * searched by whichever worker last found it in step, and an empty index in
 * between would be the miss this module exists to prevent. `rewrite` copies
 * every vector rather than only the missing ones — what Re-index asks for,
 * because a vector re-embedded in Postgres keeps its id, and only writing it
 * again replaces an old copy the index still holds.
 */
export async function repairKnowledgeBase(
  index: Index,
  knowledgeBaseId: string,
  opts: { rewrite?: boolean } = {},
): Promise<RepairResult> {
  const running = repairing.get(knowledgeBaseId);
  if (running && !opts.rewrite) return running;
  const started = (async () => {
    if (running) await running.catch(() => undefined);
    const [want, held] = await Promise.all([
      embeddedChunkIds(knowledgeBaseId),
      index.idsByKnowledgeBase(knowledgeBaseId),
    ]);
    const have = new Set(held);
    const toCopy = opts.rewrite ? [...want] : [...want].filter((id) => !have.has(id));
    const stale = held.filter((id) => !want.has(id));
    const copied = await copyChunks(index, toCopy);
    await index.deleteByIds(stale);
    // Counted again rather than assumed: a document embedded meanwhile is
    // the next check's business, and this verdict must say what is true now.
    verdicts.set(knowledgeBaseId, await checkNow(index, knowledgeBaseId));
    return { copied, removed: stale.length };
  })().finally(() => {
    if (repairing.get(knowledgeBaseId) === started) repairing.delete(knowledgeBaseId);
  });
  repairing.set(knowledgeBaseId, started);
  return started;
}

function repairInBackground(index: Index, knowledgeBaseId: string): void {
  repairKnowledgeBase(index, knowledgeBaseId).catch((e) =>
    console.warn(
      `[vector] could not bring knowledge base ${knowledgeBaseId} into step with Postgres:`,
      e instanceof Error ? e.message : e,
    ),
  );
}

/**
 * Of these knowledge bases, all routed to the external index, the ones it
 * cannot answer for yet. Retrieval searches Postgres's copy for those.
 *
 * A check that fails counts as out of step: Postgres always holds every
 * vector, so searching it is never wrong, only slower. Each one found out of
 * step is repaired in the background, so the next check finds it in step.
 */
export async function knowledgeBasesOutOfStep(knowledgeBaseIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const index = externalIndex();
  const ttl = checkTtlMs();
  if (!index || ttl === 0 || knowledgeBaseIds.length === 0) return out;
  const found = await Promise.all(knowledgeBaseIds.map((id) => check(index, id, ttl)));
  for (const v of found) {
    if (inStep(v)) continue;
    out.add(v.knowledgeBaseId);
    // A count that could not be read is an index that is down, and a repair
    // would only fail the same way; the next check after it returns repairs.
    if (!v.error) repairInBackground(index, v.knowledgeBaseId);
  }
  return out;
}

/** Every knowledge base whose vectors belong in the external index. */
async function knowledgeBasesOnTheIndex(): Promise<string[]> {
  const all: string[] = [];
  for (let from = 0; ; from += ID_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("knowledge_bases")
      .select("id")
      .order("id", { ascending: true })
      .range(from, from + ID_PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as { id: string }[];
    all.push(...page.map((r) => r.id));
    if (page.length < ID_PAGE) break;
  }
  const external: string[] = [];
  // The settings read is an IN over the ids, so it goes in pages too.
  for (let i = 0; i < all.length; i += VECTOR_PAGE) {
    const ids = all.slice(i, i + VECTOR_PAGE);
    const kinds = await storeKindByKnowledgeBase(supabaseAdmin, ids);
    for (const id of ids) if (vectorStoreIsExternal(kinds.get(id) ?? "pgvector")) external.push(id);
  }
  return external;
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Where the index stands, for the admin page: every knowledge base on it,
 * checked (or a verdict from the last few minutes reused). Repairs nothing.
 */
export async function indexReport(): Promise<{
  knowledgeBases: number;
  inStep: number;
  expected: number;
  held: number;
  outOfStep: IndexVerdict[];
  repairing: number;
  lastSweep: IndexSyncSummary | null;
} | null> {
  const index = externalIndex();
  if (!index) return null;
  const kbIds = await knowledgeBasesOnTheIndex();
  const ttl = checkTtlMs() || 300_000;
  const found = await inBatches(kbIds, CHECK_CONCURRENCY, (id) => check(index, id, ttl));
  return {
    knowledgeBases: kbIds.length,
    inStep: found.filter(inStep).length,
    expected: found.reduce((s, v) => s + v.expected, 0),
    held: found.reduce((s, v) => s + v.held, 0),
    outOfStep: found.filter((v) => !inStep(v)),
    repairing: repairing.size,
    lastSweep: lastSummary,
  };
}

/**
 * The scheduler's step: check every knowledge base on the index and repair the
 * ones out of step. Runs every VECTOR_INDEX_SYNC_MINUTES (the first pass after
 * a start always runs), or whenever `force` says so.
 */
export async function syncVectorIndex(opts: { force?: boolean } = {}): Promise<IndexSyncSummary> {
  const index = externalIndex();
  const every = sweepEveryMs();
  const due = opts.force || (every > 0 && Date.now() - lastSweepAt >= every);
  const empty: IndexSyncSummary = {
    at: new Date().toISOString(),
    knowledgeBases: 0,
    inStep: 0,
    repaired: 0,
    copied: 0,
    removed: 0,
    expected: 0,
    held: 0,
    failures: [],
  };
  if (!index || !due) return empty;
  lastSweepAt = Date.now();

  const kbIds = await knowledgeBasesOnTheIndex();
  // A sweep always counts afresh: it is what notices drift nobody queried.
  const found = await inBatches(kbIds, CHECK_CONCURRENCY, (id) => check(index, id, 0));
  const summary: IndexSyncSummary = { ...empty, knowledgeBases: kbIds.length };
  for (const v of found) {
    if (v.error) {
      summary.failures.push(`${v.knowledgeBaseId}: ${v.error}`);
      continue;
    }
    if (inStep(v)) continue;
    // One at a time: a sweep is background work and must not flood the
    // database with every collection's vectors at once.
    try {
      const r = await repairKnowledgeBase(index, v.knowledgeBaseId);
      summary.repaired += 1;
      summary.copied += r.copied;
      summary.removed += r.removed;
    } catch (e) {
      summary.failures.push(`${v.knowledgeBaseId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const id of kbIds) {
    const v = verdicts.get(id);
    if (!v) continue;
    summary.expected += v.expected;
    summary.held += v.held;
    if (inStep(v)) summary.inStep += 1;
  }
  if (summary.repaired > 0) {
    console.log(
      `[vector] brought ${summary.repaired} knowledge base(s) into step with Postgres: ` +
        `${summary.copied} vector(s) copied, ${summary.removed} removed`,
    );
  }
  lastSummary = summary;
  if (summary.failures.length > 0) {
    // Folded into the pass's own failures by the scheduler, so Monitoring's
    // scheduler row says the index could not be checked. Grouped by reason:
    // measured with Qdrant stopped (R417), every collection failed the same
    // way and the row listed 21 ids beside one sentence repeated.
    const reasons = new Map<string, number>();
    for (const f of summary.failures) {
      const reason = f.slice(f.indexOf(": ") + 2);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    throw new Error(
      `${summary.failures.length} knowledge base(s) could not be checked or repaired: ` +
        [...reasons]
          .slice(0, 3)
          .map(([reason, n]) => (n > 1 ? `${reason} (${n} of them)` : reason))
          .join("; "),
    );
  }
  return summary;
}

/** For tests: forget every verdict and the sweep clock. */
export function resetIndexSync(): void {
  verdicts.clear();
  checking.clear();
  repairing.clear();
  lastSweepAt = 0;
  lastSummary = null;
}
