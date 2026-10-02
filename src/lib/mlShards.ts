// A distributed candidate search: the rules, with no database in them.
//
// WHAT IS DISTRIBUTED HERE, precisely. A training job tries several algorithms
// and then tunes the best of them, and until now it did all of that inside one
// sandbox, one candidate after another. The search is what gets spread across
// containers: worker w of n takes candidates w, w+n, w+2n… trains and tunes
// only those, and the job keeps whichever worker's model scored best.
//
// A SINGLE MODEL STILL TRAINS IN ONE CONTAINER. Nothing here splits one fit
// across machines — that needs a framework and a cluster, and claiming it
// would be a lie a user discovers the first time they train something that
// does not fit in memory. What this buys is wall-clock on the search, which is
// where the wizard's time actually goes.
//
// The awkward cases are all about a shard that does not come back, because
// with n sandboxes the chance that one dies is n times what it was.

/** One worker's outcome, as recorded on the job. */
export type ShardOutcome = {
  shard: number;
  ok: boolean;
  /** Present when ok: the winning candidate this worker found. */
  primary_metric?: string;
  value?: number | null;
  higher_is_better?: boolean;
  algorithm?: string;
  error?: string;
};

/**
 * Candidates for worker `index` of `count`, dealt round-robin.
 *
 * Round-robin rather than contiguous blocks: the candidate list is ordered
 * cheapest-first, so slicing it into blocks would hand worker 0 every fast
 * model and the last worker every slow one, and the job would take as long as
 * the slowest block. Dealing alternately spreads the expensive ones.
 */
export function shardOf<T>(items: T[], index: number, count: number): T[] {
  if (count <= 1) return items;
  return items.filter((_, i) => i % count === index);
}

/**
 * How many workers this job should actually use.
 *
 * Never more workers than candidates — an idle sandbox still costs a container
 * start and a slot somebody else's notebook wanted. And never more than the
 * runtime allows one user to hold at once, which is the limit that actually
 * bites: with the default of 3 sessions per user, asking for 8 workers means 5
 * of them fail to start and the job is worse than it was single-shard.
 */
export function planShards(opts: {
  requested: number;
  candidates: number;
  sessionsPerUser: number;
  sessionsInUse?: number;
}): { shards: number; reason: string | null } {
  const free = Math.max(1, opts.sessionsPerUser - (opts.sessionsInUse ?? 0));
  const wanted = Math.max(1, Math.floor(opts.requested) || 1);
  let shards = wanted;
  let reason: string | null = null;
  if (shards > opts.candidates) {
    shards = Math.max(1, opts.candidates);
    reason = `${wanted} workers requested but only ${opts.candidates} candidates to try`;
  }
  if (shards > free) {
    shards = free;
    reason = `${wanted} workers requested but only ${free} runtime session${free === 1 ? "" : "s"} free for this user`;
  }
  return { shards: Math.max(1, shards), reason };
}

/**
 * Which shard won.
 *
 * Ties break on the LOWEST shard index rather than arbitrarily, so re-running
 * a job on the same data picks the same model. A search whose winner depends
 * on which container happened to answer first is not reproducible, and
 * reproducibility is most of what the registry is for.
 */
export function pickWinner<T extends ShardOutcome>(outcomes: T[]): T | null {
  const scored = outcomes.filter(
    (o) => o.ok && typeof o.value === "number" && Number.isFinite(o.value),
  );
  if (scored.length === 0) return outcomes.find((o) => o.ok) ?? null;
  const higher = scored[0].higher_is_better !== false;
  return [...scored].sort((a, b) => {
    const av = a.value as number;
    const bv = b.value as number;
    if (av !== bv) return higher ? bv - av : av - bv;
    return a.shard - b.shard;
  })[0];
}

/**
 * The one leaderboard a user reads, from every worker's rows.
 *
 * Sorted the way a single-shard run sorts it — failures last, then by the
 * metric — so a distributed job's Versions tab looks like any other. The shard
 * a row came from is kept, because "why is there no lightgbm row" is answered
 * by "worker 2 died", and that is invisible otherwise.
 */
export function mergeLeaderboards<
  T extends {
    algorithm: string;
    value: number | null;
    status?: string;
    higher_is_better?: boolean;
  },
>(perShard: { shard: number; rows: T[] }[]): (T & { shard: number })[] {
  const rows = perShard.flatMap((s) => s.rows.map((r) => ({ ...r, shard: s.shard })));
  const higher =
    rows.find((r) => typeof r.higher_is_better === "boolean")?.higher_is_better ?? true;
  return rows.sort((a, b) => {
    const aBad = a.status && a.status !== "ok" ? 1 : 0;
    const bBad = b.status && b.status !== "ok" ? 1 : 0;
    if (aBad !== bBad) return aBad - bBad;
    const av = a.value;
    const bv = b.value;
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
    if (av !== bv) return higher ? bv - av : av - bv;
    return a.shard - b.shard;
  });
}

/**
 * What to tell the user when some workers did not come back.
 *
 * A partial search is a RESULT, not a failure: three of four workers finishing
 * still produces a model, and refusing it would waste the work and the wait.
 * But it must say so, because the leaderboard is then missing rows and a
 * "best" chosen from three quarters of the field is a weaker claim.
 */
export function shardWarnings(outcomes: ShardOutcome[], shards: number): string[] {
  if (shards <= 1) return [];
  const done = outcomes.length;
  const failed = outcomes.filter((o) => !o.ok);
  const out: string[] = [];
  if (done < shards) {
    out.push(
      `${shards - done} of ${shards} search workers did not report back; the leaderboard is missing their candidates.`,
    );
  }
  for (const f of failed) {
    out.push(
      `Search worker ${f.shard + 1} of ${shards} failed: ${(f.error ?? "unknown").slice(0, 200)}`,
    );
  }
  return out;
}

/** Where a worker uploads its own model, so two workers never collide. */
export function shardArtifactPath(base: string, shard: number, shards: number): string {
  if (shards <= 1) return base;
  return base.replace(/\/model\.joblib$/, `/shard${shard}/model.joblib`);
}

/**
 * The candidates a search tries, per task, named the way the trainer names
 * them.
 *
 * Duplicated from the Python trainer on purpose: the server has to know how
 * many candidates exist to decide how many workers are worth starting, and it
 * has to be able to tell each worker which ones are its own. The duplication
 * is pinned by a test that reads the names back out of the trainer source, so
 * adding an algorithm there without adding it here fails a test rather than
 * silently leaving it untrained.
 */
export const ML_CANDIDATES: Record<string, string[]> = {
  classification: ["logistic_regression", "random_forest", "hist_gradient_boosting", "lightgbm"],
  regression: ["ridge", "random_forest", "hist_gradient_boosting", "lightgbm"],
};

/**
 * Whether a task's search can be split at all.
 *
 * Only these two enumerate their candidates up front. Clustering picks its k
 * values from the row count and forecasting picks its methods from the shape
 * of the series, both at runtime inside the sandbox — so the server cannot
 * hand a worker "its" candidates, and inventing a protocol to negotiate that
 * would cost more than the search it would speed up. Those tasks run in one
 * container, which is what they did before.
 */
export function isShardableTask(task: string): boolean {
  return Object.prototype.hasOwnProperty.call(ML_CANDIDATES, task);
}

/** Candidate count a task's search will try, for planning workers. */
export function candidateCount(task: string): number {
  return ML_CANDIDATES[task]?.length ?? 1;
}
