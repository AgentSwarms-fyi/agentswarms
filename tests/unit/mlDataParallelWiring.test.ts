// Training one model across containers, checked in the source.
//
// The rules are in tests/unit/mlDataParallel.test.ts and the averaging is
// checked against a hand-computed oracle inside the runtime image. These are
// the promises neither of those can keep, and they are mostly about a job now
// having THREE phases where it had one:
//
//   search        workers try different algorithms on the same rows
//   parallel_fit  workers refit the winner on disjoint slices of the rows
//   assemble      one container averages their fits into a single model
//
// Two failures matter more than the rest. A job that loses its way between
// phases hangs until the orphan sweep, with containers running. And a fit that
// silently reads the wrong rows produces a model that looks ordinary and was
// trained on something nobody intended.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const TRAIN = rd("src/utils/ml/train.server.ts");
const PY = rd("src/utils/ml/pyTrain.ts");
const MIGRATION = rd("supabase/migrations/20260912000000_ml_data_parallel.sql");
const LIB = rd("src/lib/mlDataParallel.ts");

/** Source with line comments stripped, for anything the prose also mentions. */
const codeOnly = (src: string) => src.replace(/^\s*\/\/.*$/gm, "");

describe("when a job splits its rows at all", () => {
  it("only after the search had to sample", () => {
    // That is precisely the case this exists for. A dataset that fitted was
    // already trained on in full, and splitting it would pay container starts
    // to make the model slightly worse.
    const fn = TRAIN.slice(TRAIN.indexOf("async function planParallelFit"));
    expect(fn.slice(0, 900)).toContain("if (!winner.training_sampled) return null;");
  });

  it("and only where averaging two answers means anything", () => {
    // The same reason shadowing refuses to compare clustering: cluster 3 of
    // one worker's fit has nothing to do with cluster 3 of another's.
    const fn = TRAIN.slice(TRAIN.indexOf("async function planParallelFit"));
    expect(fn.slice(0, 1200)).toContain(
      'if (model.task !== "classification" && model.task !== "regression") return null;',
    );
  });

  it("the decision is the pure rule, not a second copy of it", () => {
    const fn = TRAIN.slice(TRAIN.indexOf("async function planParallelFit"));
    expect(fn.slice(0, 2000)).toContain("parallelPlan({");
    expect(LIB).toContain("export const MIN_ROWS_PER_WORKER");
  });

  it("the job's own finishing workers do not block its own split", () => {
    // FOUND BY RUNNING IT. A session is marked finished AFTER its callback, so
    // at the moment the last search worker reports, every search container is
    // still counted as in use and the allowance looks full. The split was
    // refused with "this instance allows only one training container", and
    // whether it happened depended on how fast the other sessions had been
    // reaped — the same job split on one run and did not on the next.
    const fn = TRAIN.slice(TRAIN.indexOf("async function planParallelFit"));
    expect(fn.slice(0, 2200)).toContain(
      "const own = new Set((job.shard_sessions ?? []) as string[]);",
    );
    expect(fn.slice(0, 2200)).toContain("filter((sess) => !own.has(sess.id)).length");
  });

  it("and a refusal leaves the job finishing the way it always did", () => {
    // Not an error: the searched model is a real model, and the person asked
    // for a model rather than for a particular way of producing one.
    const fn = TRAIN.slice(TRAIN.indexOf("async function planParallelFit"));
    expect(fn.slice(0, 2500)).toContain("if (!planned.ok) {");
    expect(fn.slice(0, 2500)).toContain("return null;");
  });
});

describe("a worker reads its own rows and nobody else's", () => {
  it("hashed, not windowed", () => {
    // LIMIT/OFFSET with no ORDER BY does not promise a stable order, and
    // DuckDB parallelises a scan, so two containers issuing the same windowed
    // query overlap on some rows and miss others. Nothing downstream notices.
    expect(codeOnly(PY)).toContain("part = cfg.get('partition') or {}");
    expect(codeOnly(PY)).toContain("WHERE ' + part['sql'] + ') AS _part'");
    expect(codeOnly(PY)).not.toMatch(/LIMIT %d OFFSET %d/);
  });

  it("wrapped as a subquery, because the body may already have a WHERE", () => {
    // The prep step can leave the source as `rel WHERE (...)` or as a
    // subquery, and 'WHERE a WHERE b' is not a query.
    const py = codeOnly(PY);
    expect(py).toContain("body = '(SELECT * FROM ' + body + ' WHERE '");
  });

  it("and the row count is re-read for the slice, not inherited", () => {
    // The worker must report the rows IT read. Reporting the table's total
    // would have every worker claim the whole dataset.
    const py = codeOnly(PY);
    const block = py.slice(py.indexOf("part = cfg.get('partition')"));
    expect(block.slice(0, 600)).toContain(
      "total = int(con.execute('SELECT count(*) FROM ' + body)",
    );
  });

  it("the partition columns are the features ONLY, sorted", () => {
    // feature_schema also lists the target and every column the prep step
    // dropped, and those are not promised to exist in the frame a worker
    // reads — a prep step with its own SQL selects what it likes. Reading a
    // real feature_schema is what showed this: the comment claimed the filter
    // and the code took every name.
    const fn = TRAIN.slice(TRAIN.indexOf("function partitionColumns"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain('.filter((f) => f?.role === "feature")');
    expect(body).toContain("].sort()");
  });

  it("and a fit with nothing safe to hash on is refused, not run unsplit", () => {
    // A null predicate means every worker reads EVERY row and their fits are
    // averaged over the same data several times over, which nothing
    // downstream could detect.
    const fn = TRAIN.slice(TRAIN.indexOf("async function planParallelFit"));
    expect(fn).toContain("no feature columns to hash on");
  });

  it("and a parallel worker gets ONE algorithm with tuning off", () => {
    // Re-tuning per slice would give the workers different hyper-parameters,
    // and averaging those is averaging different models.
    const block = TRAIN.slice(TRAIN.indexOf('stash.phase === "parallel_fit"'));
    expect(block.slice(0, 900)).toContain("candidates: [b.job.parallel_algorithm]");
    expect(block.slice(0, 900)).toContain('tuning: "none"');
  });
});

describe("the phases hand over exactly once", () => {
  it("the claim is in the database, not in the application", () => {
    expect(MIGRATION).toContain("WHERE id = _job AND phase = _from");
    const fn = TRAIN.slice(TRAIN.indexOf("async function advancePhase"));
    expect(fn.slice(0, 900)).toContain('supabaseAdmin.rpc("ml_job_advance_phase"');
    expect(fn.slice(0, 900)).toContain("return Boolean(row?.claimed);");
  });

  it("and clears the previous phase's results in the same statement", () => {
    // Otherwise a worker from the NEXT phase reports into the PREVIOUS
    // phase's results, "n of n reported" becomes true early, and a model is
    // assembled out of half the slices.
    const sql = MIGRATION.slice(MIGRATION.indexOf("CREATE OR REPLACE FUNCTION"));
    const stmt = sql.slice(sql.indexOf("UPDATE public.ml_training_jobs"), sql.indexOf("RETURNING"));
    expect(stmt).toContain("shard_results = '[]'::jsonb");
    expect(stmt).toContain("shard_sessions = '{}'");
    expect(stmt).toContain("phase = _to");
  });

  it("a report is only counted by the phase it was started for", () => {
    // FOUND BY RUNNING IT. Clearing shard_results between phases makes an
    // already-recorded shard eligible again, so a RETRIED callback from the
    // phase that just ended was accepted into the one that just began and
    // counted toward completing it. Live, a search worker's duplicate report
    // completed parallel_fit while the second slice's container was still
    // being created: the job assembled from one slice plus a leftover search
    // result and recorded the version as trained on zero rows.
    const SHARD = rd("supabase/migrations/20260914000000_ml_shard_phase.sql");
    expect(SHARD).toContain("AND phase = _phase");
    // The worker's own stash says which phase it belongs to — not the job,
    // which has already moved on by the time a late report arrives.
    expect(TRAIN).toContain('_phase: phase ?? "search",');
    expect(rd("src/routes/api/notebook.runtime.result.ts")).toContain(
      "m.finalizeMlJob(mlStash.job_id, outcome, mlStash.shard, mlStash.phase)",
    );
  });

  it("and the phase survives being parsed out of the stash", () => {
    // FOUND BY RUNNING IT, and it is the reason the guard above looked broken.
    // mlJobStashOf rebuilds the stash field by field rather than spreading it,
    // so anything not named there is silently dropped. The phase was dropped,
    // every callback reported itself as "search", the recording refused it —
    // correctly — and parallel_fit sat at 0 of 2 with both containers already
    // gone. A guard is only as good as the field reaching it.
    const TYPES = rd("src/utils/ml/types.ts");
    const fn = TYPES.slice(TYPES.indexOf("export function mlJobStashOf"));
    expect(fn.slice(0, 1800)).toContain("...(known ? { phase } : {}),");
    // And a single-container phase keeps its count, or the assemble cannot
    // report as that phase's worker at all.
    expect(fn.slice(0, 1800)).toContain("known ? shards >= 1 : shards > 1");
  });

  it("and every worker past the search reports through the shard path", () => {
    // ALSO FOUND BY RUNNING IT. The assemble phase runs ONE container, and a
    // condition of `shards > 1` sent it down the single-worker path instead —
    // which writes the job's outcome directly from a result that has no
    // leaderboard and no metrics, bypassing the phase machinery entirely.
    expect(TRAIN).toContain('(job.shards ?? 1) > 1 || (job.phase ?? "search") !== "search"');
  });

  it("the merge reads the phase BEFORE recording the worker", () => {
    // Recording is what makes a worker the last one. Reading the phase
    // afterwards would read the phase the job had already moved to.
    const fn = TRAIN.slice(TRAIN.indexOf("const { data: job } = await supabaseAdmin"));
    expect(fn.indexOf('.from("ml_training_jobs")')).toBeLessThan(
      fn.indexOf('rpc("ml_job_record_shard"'),
    );
  });

  it("and every phase has somewhere to go", () => {
    expect(TRAIN).toContain('if (job?.phase === "parallel_fit") {');
    expect(TRAIN).toContain('if (job?.phase === "assemble") {');
    expect(TRAIN).toContain("async function finishParallelFit(");
    expect(TRAIN).toContain("async function finishAssemble(");
  });
});

describe("nothing leaves the person without a model", () => {
  it("a parallel fit that will not start keeps the searched one", () => {
    const fn = TRAIN.slice(TRAIN.indexOf("if (started.length > 0) {"));
    expect(fn.slice(0, 1600)).toContain("this is the sampled fit.");
  });

  it("every slice failing keeps the searched one", () => {
    const fn = TRAIN.slice(TRAIN.indexOf("async function finishParallelFit"));
    expect(fn.slice(0, 2000)).toContain("if (good.length === 0) {");
    expect(fn.slice(0, 2000)).toContain("keeping the searched fit");
  });

  it("and no container to assemble keeps the searched one", () => {
    const fn = TRAIN.slice(TRAIN.indexOf("async function finishParallelFit"));
    expect(fn).toContain("no container was free to combine them");
  });

  it("but SOME slices failing is not fatal — the rest are averaged", () => {
    // Three of four slices is still more rows than the sample the search used.
    const fn = TRAIN.slice(TRAIN.indexOf("async function finishParallelFit"));
    expect(fn.slice(0, 1200)).toContain(
      "const good = entries.filter((e) => e.ok && e.result?.artifact_uri);",
    );
  });
});

describe("what the assembled model claims about itself", () => {
  it("the parts are digest-checked before they are trusted", () => {
    // An assembled model is only as trustworthy as the least-checked thing
    // inside it, and a prediction checks the model it answers from.
    const py = codeOnly(PY);
    const fn = py.slice(py.indexOf("def _assemble("));
    expect(fn.slice(0, 1800)).toContain("Refusing to assemble it.");
    expect(fn.slice(0, 1800)).toContain("hashlib.sha256(blob).hexdigest()");
  });

  it("the assemble result is shaped like a result the application accepts", () => {
    // FOUND BY READING isTrainResult, not by a test: it requires a metrics
    // object, and without one every assemble would be recorded as a failed
    // worker and the job would fall back to the sampled fit every time —
    // silently, and looking exactly like "the slices could not be combined".
    const py = codeOnly(PY);
    const fn = py.slice(py.indexOf("def _assemble("));
    expect(fn).toContain("'metrics': {}");
    for (const key of ["'ok': True", "'artifact_uri'", "'artifact_sha256'"]) {
      expect(fn, key).toContain(key);
    }
    // And the validator still wants exactly those, so the two stay in step.
    const guard = TRAIN.slice(TRAIN.indexOf("function isTrainResult"));
    const body = guard.slice(0, guard.indexOf("\n}"));
    expect(body).toContain("r.ok === true");
    expect(body).toContain('typeof r.artifact_uri === "string"');
    expect(body).toContain('typeof r.artifact_sha256 === "string"');
    // BOTH halves of the metrics check, asserted separately. `toContain("r.metrics")`
    // alone is satisfied by the typeof line, so a mutation pass walked the
    // truthiness check out of the source and this guard did not notice —
    // `typeof null === "object"`, so a worker reporting `metrics: null` would
    // have been accepted as a result and the assemble recorded as a fit with
    // no metrics at all, which is the very thing this test exists to prevent.
    expect(body).toContain("r.metrics &&");
    expect(body).toContain('typeof r.metrics === "object"');
  });

  it("and writes to a path of its own, never over the search's artifact", () => {
    // shardArtifactPath returns the UNSUFFIXED base for a single worker, and
    // the assemble runs in one container — so it would land exactly where a
    // single-worker search put its model. Invisible while everything
    // succeeds, quietly destructive when it does not: a container dying
    // mid-upload leaves a corrupt file at the path the fallback is about to
    // record the SEARCH's digest for, and every prediction then refuses.
    expect(LIB).toContain("export function assembledArtifactPath(");
    // Asserted on the pieces rather than on one span, so a reflow by the
    // formatter cannot fail a test about where a file is written.
    expect(TRAIN).toContain("assembledArtifactPath(mlArtifactUri(");
    expect(TRAIN).toContain('stash.phase === "assemble",');
    // And the branch is taken on the assemble flag, not on the shard count,
    // which for one container is indistinguishable from a one-worker search.
    const env = TRAIN.slice(TRAIN.indexOf("ML_ARTIFACT_URI:"));
    expect(env.slice(0, 300)).toContain("assembled");
  });

  it("the parts survive the transition that consumes them", () => {
    // FOUND BY RUNNING IT. Advancing to the assemble phase CLEARS
    // shard_results — it has to, or the slices' entries make the assemble
    // phase look finished before its container has said anything. But the
    // slices' artifacts ARE the assemble's input, and the container reads the
    // job fresh from the database after the transition. It found an empty
    // list and raised "Nothing to assemble: no worker reported a fitted
    // model". The transition that starts the assemble had destroyed what the
    // assemble is for.
    const PARTS = rd("supabase/migrations/20260915000000_ml_parallel_parts.sql");
    expect(PARTS).toContain("parallel_parts = COALESCE(_parts, parallel_parts)");
    // In the SAME statement as the clear, or there is a window where the job
    // is in the assemble phase with nothing to assemble.
    const stmt = PARTS.slice(
      PARTS.indexOf("UPDATE public.ml_training_jobs"),
      PARTS.indexOf("WHERE id = _job"),
    );
    expect(stmt).toContain("shard_results = '[]'::jsonb");
    expect(stmt).toContain("parallel_parts =");
    const fn = TRAIN.slice(TRAIN.indexOf("function assembleParts"));
    expect(fn.slice(0, 900)).toContain("job.parallel_parts as unknown as ShardEntry[]");
    expect(fn.slice(0, 900)).not.toContain("job.shard_results");
  });

  it("the parts are ordered, so the artifact does not depend on network timing", () => {
    // A model whose digest depends on the order callbacks arrived in cannot
    // be compared against itself later.
    const fn = TRAIN.slice(TRAIN.indexOf("function assembleParts"));
    expect(fn.slice(0, 900)).toContain(".sort((a, b) => a.shard - b.shard)");
  });

  it("it stops calling itself sampled, and drops the warning that said so", () => {
    // The search's "trained on a sample" line described a fit that is no
    // longer the model being shipped.
    const fn = TRAIN.slice(TRAIN.indexOf("async function finishAssemble"));
    expect(fn).toContain("training_sampled: false,");
    expect(fn).toContain('.filter((w) => !w.startsWith("Trained on a "))');
  });

  it("and says what it actually covered, and what pasting is", () => {
    const fn = TRAIN.slice(TRAIN.indexOf("async function finishAssemble"));
    expect(fn).toContain("parallelWarnings(plan)");
    expect(LIB).toContain("not identical to one fit over everything");
  });

  it("the metrics are the search's, not re-measured on the slices", () => {
    // Each worker's holdout is its own slice, so a metric averaged over them
    // would be measured on data each fit had seen a neighbour of. The
    // search's holdout is the one number nothing optimised against.
    const fn = TRAIN.slice(TRAIN.indexOf("async function finishAssemble"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("...search,");
    expect(body).not.toContain("metrics:");
  });
});

describe("the averaged model answers as one model", () => {
  it("a list of pipelines is wrapped at load time, not pickled", () => {
    // A class defined in this program pickles by reference to a module that
    // does not exist when the artifact is loaded.
    const py = codeOnly(PY);
    expect(py).toContain("def _paste(pipes, task):");
    expect(py).not.toMatch(/^class /m);
    expect(py).toContain("if isinstance(pipe, list):");
    expect(py).toContain("pipe = _paste(pipe, art.get('task'))");
  });

  it("probabilities are averaged by LABEL, not by column position", () => {
    // A rare class can be missing from one worker's slice entirely. Lining the
    // matrices up by position would average different classes together and
    // report the result as a confident answer.
    const py = codeOnly(PY);
    const fn = py.slice(py.indexOf("def _paste(pipes, task):"));
    expect(fn.slice(0, 2600)).toContain("index = dict((c, i) for i, c in enumerate(seen))");
    expect(fn.slice(0, 2600)).toContain("out[:, index[c]] += pr[:, j]");
  });

  it("and never asks a numpy array whether it is truthy", () => {
    // `getattr(...) or []` raises "the truth value of an array with more than
    // one element is ambiguous". Found by running the real program.
    const py = codeOnly(PY);
    const fn = py.slice(py.indexOf("def _paste(pipes, task):"));
    expect(fn.slice(0, 2600)).not.toMatch(/classes_', \[\]\) or \[\]/);
    expect(fn.slice(0, 2600)).toContain("if cls is not None else []");
  });
});
