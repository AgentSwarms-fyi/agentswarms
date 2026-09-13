// Training ONE model on more rows than one container can hold.
//
// NO IMPORTS, like the other src/lib/ml*.ts modules.
//
// WHAT THIS IS NOT. src/lib/mlShards.ts spreads the algorithm SEARCH across
// containers: worker w tries candidates w, w+n, w+2n and the best one wins.
// Every one of those workers reads the same rows, and a single fit still
// happens in a single container. That is a different thing from this, and the
// two can run in the same job one after the other.
//
// WHAT THIS IS. The rows are split instead of the candidates: worker w fits
// the SAME algorithm on its own disjoint slice, and the answer is the average
// of what the workers say. That is PASTING — bagging on disjoint partitions —
// and it is a real ensemble method rather than a trick. It is also not the
// same estimator you would get by fitting once on everything, and the honest
// comparison is not against that estimator at all:
//
//   A SINGLE FIT ON ALL THE ROWS IS NOT ON OFFER. It is precisely the thing
//   that does not fit. What the platform does today is reservoir-sample down
//   to what one container holds and fit once on the sample, so THAT is the
//   baseline, and against it pasting is measurably better.
//
// Measured in the runtime image, 400k rows, 25k per container, F1 macro
// against a common holdout — pasting minus sampling:
//
//   hist_gradient_boosting   4 workers  +0.0100
//   hist_gradient_boosting   8 workers  +0.0110
//   hist_gradient_boosting  16 workers  +0.0086
//   logistic_regression      8 workers  -0.0007
//
// Two things follow from those numbers and are built into the rules below.
// More workers is not monotonically better — 16 was worse than 8, because
// what governs the cost is how many rows each worker still gets. And a linear
// model gains nothing, because it had already seen enough rows to converge;
// it does not LOSE anything either, which is why this is allowed rather than
// restricted to trees.

/**
 * A thousands separator that does not depend on where the server is.
 *
 * NOT `toLocaleString()`. These strings are STORED on the model version and
 * read back by whoever opens it later, so a locale-sensitive one would have
 * the same model describe itself differently depending on which machine wrote
 * the warning. Caught on a machine resolving to en-IN, where a million renders
 * as "10,00,000" — correct there, and not what the next reader expects.
 *
 * The panel keeps using toLocaleString for numbers it renders live: that one
 * SHOULD follow the reader.
 */
function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What a data-parallel fit would actually do. */
export type ParallelPlan = {
  /** Containers that will each fit the model on their own slice. */
  workers: number;
  /** Rows each of them reads. The last may read fewer. */
  rowsPerWorker: number;
  /** Rows the fit will see in total — `workers * rowsPerWorker`, capped. */
  rowsUsed: number;
  /** Rows there are altogether, so a warning can say what was left. */
  totalRows: number;
};

/**
 * Rows a worker must still get for its fit to be worth anything.
 *
 * There is no cliff to find — the cost rises smoothly as the slices get
 * thinner, so this is a line drawn on a curve rather than a discovered
 * threshold. Measured in the runtime image on 320,000 training rows,
 * hist_gradient_boosting, F1 macro against a common holdout, pasted minus a
 * single fit on all of them:
 *
 *   160,000 rows each  -0.0000      10,000 rows each  -0.0123
 *    80,000            -0.0015       5,000            -0.0207
 *    40,000            -0.0035       2,500            -0.0339
 *    20,000            -0.0082
 *
 * 25,000 sits at roughly half a point of F1, which is small next to the point
 * the split BUYS against the sample fit that is the real alternative. Below
 * it the platform refuses and samples the old way, because a fast answer that
 * is worse than the slow one is not a feature.
 */
export const MIN_ROWS_PER_WORKER = 25_000;

/**
 * Is a data-parallel fit worth doing, and at what width?
 *
 * Returns a refusal rather than a plan when it is not, because "we quietly did
 * something else" is how a person ends up believing their model saw data it
 * never saw.
 */
export function parallelPlan(args: {
  /** Rows the training query would return. */
  totalRows: number;
  /** Rows one container holds — the sample ceiling used today. */
  perWorker: number;
  /** Most containers this caller may hold at once. */
  maxWorkers: number;
  /** Floor under rows per worker. Defaults to the measured one. */
  minRowsPerWorker?: number;
}): { ok: true; plan: ParallelPlan } | { ok: false; reason: string } {
  const total = Math.floor(args.totalRows);
  const per = Math.floor(args.perWorker);
  const maxW = Math.floor(args.maxWorkers);
  const floor = Math.floor(args.minRowsPerWorker ?? MIN_ROWS_PER_WORKER);

  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: "The training query returned no rows." };
  }
  if (!Number.isFinite(per) || per <= 0) {
    return { ok: false, reason: "No row ceiling is configured for a container." };
  }
  if (maxW < 2) {
    return { ok: false, reason: "This instance allows only one training container at a time." };
  }
  if (total <= per) {
    // The whole point is rows that do NOT fit. Splitting a dataset that fits
    // would pay k container starts to make the model slightly worse.
    return {
      ok: false,
      reason: `All ${grouped(total)} rows fit in one container, so splitting them would only cost accuracy.`,
    };
  }

  // Enough workers to cover the rows, never more than allowed.
  const workers = Math.min(maxW, Math.ceil(total / per));
  const rowsUsed = Math.min(total, workers * per);
  const rowsPerWorker = Math.ceil(rowsUsed / workers);

  if (rowsPerWorker < floor) {
    return {
      ok: false,
      reason: `Each worker would see only ${grouped(rowsPerWorker)} rows, below the ${grouped(floor)} needed for the split to be worth it.`,
    };
  }
  return { ok: true, plan: { workers, rowsPerWorker, rowsUsed, totalRows: total } };
}

/**
 * What a person should be told about a plan, in words rather than figures.
 *
 * Says what was left out when the rows still exceed what the workers hold: the
 * fit is on far more data than before and is still not on all of it, and both
 * halves of that are worth knowing.
 */
export function parallelWarnings(plan: ParallelPlan): string[] {
  const out: string[] = [];
  if (plan.rowsUsed < plan.totalRows) {
    out.push(
      `Trained on ${grouped(plan.rowsUsed)} of ${grouped(plan.totalRows)} rows, ` +
        `split across ${plan.workers} containers. The rest were left out: ${plan.workers} containers ` +
        `hold this many rows between them.`,
    );
  } else {
    out.push(
      `Trained on all ${grouped(plan.totalRows)} rows, split across ${plan.workers} containers.`,
    );
  }
  out.push(
    "Each container fitted the same algorithm on its own share of the rows and the answers are " +
      "averaged. That is not identical to one fit over everything, but it beats fitting once on a " +
      "sample, which is what a dataset this size would otherwise get.",
  );
  return out;
}

/**
 * The SQL predicate selecting worker `index`'s share of the rows.
 *
 * HASHED, not LIMIT/OFFSET, and the difference is correctness rather than
 * taste. `LIMIT n OFFSET k` with no ORDER BY does not promise a stable order:
 * DuckDB parallelises a scan, so two containers issuing the same query can
 * see rows in different orders and their "disjoint" windows then overlap on
 * some rows and miss others. Nothing downstream would notice — the fit would
 * simply be on the wrong data, weighted wrongly, and the score would look
 * ordinary. Ordering the whole table instead would make every worker sort
 * millions of rows to read a fraction of them.
 *
 * Hashing the row decides which worker owns it without any ordering at all.
 * Identical rows land together, which is right: they are the same evidence and
 * splitting them across workers would weight duplicates differently.
 *
 * Slices are approximately, not exactly, equal. Each worker reports the rows
 * it actually read, so the record says what happened rather than what was
 * planned.
 */
export function partitionSql(columns: string[], index: number, workers: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= workers || workers < 1) return null;
  if (workers === 1) return "TRUE";
  const cols = columns.filter((c) => typeof c === "string" && c.length > 0);
  if (cols.length === 0) return null;
  // Quoted the way every other identifier in this codebase is, so a column
  // called `") OR 1=1 --` is a column name and nothing else.
  const hashed = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(", ");
  return `(hash(${hashed}) % ${workers}) = ${index}`;
}

/**
 * Which worker a row with this hash belongs to.
 *
 * The arithmetic the SQL performs, in a form a test can sweep. Kept in step
 * with `partitionSql` by tests rather than by comment: if the two disagree,
 * the rows a worker trains on are not the rows anybody thinks it trained on.
 */
export function workerForHash(hash: bigint, workers: number): number {
  if (workers < 1) return 0;
  const w = BigInt(workers);
  const m = hash % w;
  return Number(m < 0n ? m + w : m);
}

/**
 * Where the assembled model is written.
 *
 * ITS OWN PATH, never the base one. The assemble step runs in a single
 * container, and `shardArtifactPath` returns the unsuffixed base path for a
 * single worker — which is exactly where a single-worker SEARCH put its
 * artifact. Overwriting it would be invisible while everything succeeds and
 * quietly destructive when it does not: a container that dies mid-upload
 * leaves a corrupt file at the path the fallback is about to record the
 * SEARCH's digest for, and every prediction then refuses with a digest
 * mismatch on a model that was never assembled.
 */
export function assembledArtifactPath(base: string): string {
  return base.replace(/\/model\.joblib$/, "/assembled/model.joblib");
}
