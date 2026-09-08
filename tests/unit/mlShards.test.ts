// A distributed candidate search: several sandboxes try different algorithms
// and the job keeps the best one.
//
// Nearly everything pinned here is about a worker that does not come back.
// With one container a dead sandbox means a failed job and that is the end of
// it; with four, a dead sandbox means a job that must still produce a model,
// still say what it did not get to try, and still finish exactly once even
// though four callbacks are racing each other to be last.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ML_CANDIDATES,
  candidateCount,
  isShardableTask,
  mergeLeaderboards,
  pickWinner,
  planShards,
  shardArtifactPath,
  shardOf,
  shardWarnings,
} from "@/lib/mlShards";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("dealing the candidates out", () => {
  it("deals round-robin, not in blocks", () => {
    // The candidate list is ordered cheapest-first, so blocks would give
    // worker 0 every fast model and the last worker every slow one — and the
    // job takes as long as its slowest worker.
    const c = ["logistic_regression", "random_forest", "hist_gradient_boosting", "lightgbm"];
    expect(shardOf(c, 0, 2)).toEqual(["logistic_regression", "hist_gradient_boosting"]);
    expect(shardOf(c, 1, 2)).toEqual(["random_forest", "lightgbm"]);
  });

  it("covers every candidate exactly once, whatever the worker count", () => {
    const c = ["a", "b", "c", "d", "e"];
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const dealt = Array.from({ length: n }, (_, i) => shardOf(c, i, n)).flat();
      expect(dealt.sort(), `n=${n}`).toEqual([...c].sort());
    }
  });

  it("gives one worker everything", () => {
    expect(shardOf(["a", "b"], 0, 1)).toEqual(["a", "b"]);
  });
});

describe("how many workers to actually start", () => {
  it("never starts more workers than there are candidates", () => {
    // An idle sandbox still costs a container start and a session slot.
    const p = planShards({ requested: 8, candidates: 4, sessionsPerUser: 10 });
    expect(p.shards).toBe(4);
    expect(p.reason).toMatch(/only 4 candidates/);
  });

  it("never starts more than the runtime lets one user hold", () => {
    // This is the limit that actually bites: with 3 sessions per user, asking
    // for 8 means 5 fail to start and the job is worse than single-shard.
    const p = planShards({ requested: 8, candidates: 20, sessionsPerUser: 3, sessionsInUse: 1 });
    expect(p.shards).toBe(2);
    expect(p.reason).toMatch(/only 2 runtime sessions free/);
  });

  it("always plans at least one, and says nothing when it got what it asked", () => {
    expect(planShards({ requested: 4, candidates: 4, sessionsPerUser: 8 })).toEqual({
      shards: 4,
      reason: null,
    });
    expect(planShards({ requested: 0, candidates: 4, sessionsPerUser: 8 }).shards).toBe(1);
    expect(
      planShards({ requested: 4, candidates: 4, sessionsPerUser: 3, sessionsInUse: 9 }).shards,
    ).toBe(1);
  });
});

describe("picking the winner", () => {
  const o = (shard: number, value: number | null, ok = true, higher = true) => ({
    shard,
    ok,
    value,
    higher_is_better: higher,
    primary_metric: "f1_macro",
  });

  it("takes the best score in the metric's own direction", () => {
    expect(pickWinner([o(0, 0.7), o(1, 0.9), o(2, 0.8)])?.shard).toBe(1);
    const lower = [o(0, 3.0, true, false), o(1, 1.5, true, false)];
    expect(pickWinner(lower)?.shard).toBe(1);
  });

  it("breaks a tie on the lowest worker, so a re-run picks the same model", () => {
    // A winner that depends on which container answered first is not
    // reproducible, and reproducibility is most of what the registry is for.
    expect(pickWinner([o(2, 0.9), o(0, 0.9), o(1, 0.9)])?.shard).toBe(0);
  });

  it("ignores workers that failed or scored nothing", () => {
    expect(pickWinner([o(0, null, false), o(1, 0.4)])?.shard).toBe(1);
    expect(pickWinner([o(0, null), o(1, 0.4)])?.shard).toBe(1);
    expect(pickWinner([o(0, null, false), o(1, null, false)])).toBeNull();
  });
});

describe("the one leaderboard a user reads", () => {
  it("interleaves every worker's rows, failures last", () => {
    const merged = mergeLeaderboards([
      {
        shard: 0,
        rows: [
          { algorithm: "logistic_regression", value: 0.7, status: "ok", higher_is_better: true },
          { algorithm: "hist_gradient_boosting", value: null, status: "failed" },
        ],
      },
      {
        shard: 1,
        rows: [{ algorithm: "lightgbm", value: 0.9, status: "ok", higher_is_better: true }],
      },
    ]);
    expect(merged.map((r) => r.algorithm)).toEqual([
      "lightgbm",
      "logistic_regression",
      "hist_gradient_boosting",
    ]);
    // Which worker ran a row survives the merge: "why is there no lightgbm
    // row" is answered by "worker 2 died", and that is invisible otherwise.
    expect(merged[0].shard).toBe(1);
  });

  it("sorts a lower-is-better metric the other way", () => {
    const merged = mergeLeaderboards([
      { shard: 0, rows: [{ algorithm: "ridge", value: 9, status: "ok", higher_is_better: false }] },
      { shard: 1, rows: [{ algorithm: "lgbm", value: 2, status: "ok", higher_is_better: false }] },
    ]);
    expect(merged[0].algorithm).toBe("lgbm");
  });
});

describe("saying what the search missed", () => {
  it("names workers that never reported", () => {
    // Three of four finishing still produces a model; refusing it would waste
    // the work and the wait. But the leaderboard is then missing rows.
    const w = shardWarnings(
      [
        { shard: 0, ok: true },
        { shard: 1, ok: true },
      ],
      4,
    );
    expect(w[0]).toMatch(/2 of 4 search workers did not report back/);
  });

  it("names a worker that failed, with its error", () => {
    const w = shardWarnings(
      [
        { shard: 0, ok: true },
        { shard: 1, ok: false, error: "MemoryError" },
      ],
      2,
    );
    expect(w.join(" ")).toContain("Search worker 2 of 2 failed: MemoryError");
  });

  it("says nothing at all about a job that ran in one container", () => {
    expect(shardWarnings([{ shard: 0, ok: true }], 1)).toEqual([]);
  });
});

describe("where each worker writes its model", () => {
  it("gives every worker its own path, and leaves a single job's path alone", () => {
    const base = "s3://lake/ml-artifacts/m1/v3/model.joblib";
    expect(shardArtifactPath(base, 0, 1)).toBe(base);
    expect(shardArtifactPath(base, 2, 4)).toBe("s3://lake/ml-artifacts/m1/v3/shard2/model.joblib");
    // Two workers never collide, which is the whole point.
    expect(shardArtifactPath(base, 0, 4)).not.toBe(shardArtifactPath(base, 1, 4));
  });
});

describe("which searches can be split at all", () => {
  it("splits only the tasks whose candidates the server can enumerate", () => {
    // Clustering picks its k from the row count and forecasting its methods
    // from the shape of the series, both inside the sandbox — the server
    // cannot hand those workers "their" candidates.
    expect(isShardableTask("classification")).toBe(true);
    expect(isShardableTask("regression")).toBe(true);
    for (const t of ["clustering", "forecast", "anomaly", "recommendation"]) {
      expect(isShardableTask(t), t).toBe(false);
      expect(candidateCount(t), t).toBe(1);
    }
  });

  it("lists exactly the algorithms the trainer actually has", () => {
    // The server duplicates this list to plan workers and deal slices. If the
    // trainer gains an algorithm and this does not, that algorithm is silently
    // never trained in a distributed job — so read the names back out of the
    // trainer and compare.
    const py = rd("src/utils/ml/pyTrain.ts");
    const block = py.slice(py.indexOf("def _candidates("), py.indexOf("def _search_space("));
    const found = [...block.matchAll(/cands\.append\(\('([a-z_]+)'/g)].map((m) => m[1]);
    const classification = block.slice(0, block.indexOf("    else:"));
    const regression = block.slice(block.indexOf("    else:"));
    const namesIn = (s: string) =>
      [...s.matchAll(/cands\.append\(\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(0);
    expect(namesIn(classification).sort()).toEqual([...ML_CANDIDATES.classification].sort());
    expect(namesIn(regression).sort()).toEqual([...ML_CANDIDATES.regression].sort());
  });
});

describe("the wiring", () => {
  const train = rd("src/utils/ml/train.server.ts");
  const py = rd("src/utils/ml/pyTrain.ts");
  const migration = rd("supabase/migrations/20260878000000_ml_training_shards.sql");

  it("counts the finished workers in the database, in one statement", () => {
    // Of n simultaneous callbacks exactly one must see itself as last.
    // Read-then-write in the app would let two both believe they were.
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.ml_job_record_shard");
    expect(migration).toContain("jsonb_array_length(shard_results)");
    // A repeated callback for a shard already recorded matches nothing.
    expect(migration).toContain("NOT EXISTS");
    expect(train).toContain('supabaseAdmin.rpc("ml_job_record_shard"');
  });

  it("records how many workers actually started, not how many were planned", () => {
    // A job waiting for a worker that never existed hangs until the sweep.
    expect(train).toContain("shards: started.length");
    expect(train).toContain("shard_sessions: started");
  });

  it("writes the version through one function whichever way it trained", () => {
    // Two copies of the registry write would diverge on the first change.
    expect(train).toContain("async function writeTrainOutcome(");
    expect(train.match(/await writeTrainOutcome\(/g)?.length).toBe(2);
  });

  it("takes the shard from the session's own stash, never from the caller", () => {
    // A worker must not be able to claim it is a different one.
    expect(rd("src/routes/api/notebook.runtime.result.ts")).toContain(
      "m.finalizeMlJob(mlStash.job_id, outcome, mlStash.shard)",
    );
  });

  it("stops every worker when the job is cancelled", () => {
    const cancel = train.slice(train.indexOf("export async function cancelMlJob"));
    expect(cancel).toContain("shard_sessions");
    expect(cancel).toContain('.in("id", sessionIds)');
  });

  it("polls every worker's sandbox, not just the first", () => {
    // With n workers there are n callbacks that can be lost.
    const refresh = train.slice(train.indexOf("export async function refreshMlJob"));
    expect(refresh).toContain("shard_sessions");
    expect(refresh).toContain("mlJobStashOf(fresh.inputs)?.shard");
  });

  it("leaves a single-container job exactly as it was", () => {
    // The stash carries no shard, the bundle carries no candidate list, and
    // the artifact path is unchanged — so nothing about the common case moved.
    expect(train).toContain("...(plan.shards > 1 ? { shard, shards: plan.shards } : {})");
    expect(train).toContain("stash.shards && stash.shards > 1");
    expect(py).toContain("_candidates(task, prep, cfg.get('candidates'))");
    expect(py).toContain("def _candidates(task, prep, only=None):");
  });

  it("is a setting, not a constant, with the operator's other limits", () => {
    expect(rd("src/utils/notebookRuntime/config.server.ts")).toContain(
      'positive(data?.ml_train_workers) ?? envInt("ML_TRAIN_WORKERS") ?? 1',
    );
    expect(rd(".env.example")).toContain("ML_TRAIN_WORKERS");
    expect(rd("docs/SCALE_AND_LIMITS.md")).toContain("`ML_TRAIN_WORKERS`");
    expect(rd("src/components/admin/RuntimeTab.tsx")).toContain("Search workers");
  });
});
