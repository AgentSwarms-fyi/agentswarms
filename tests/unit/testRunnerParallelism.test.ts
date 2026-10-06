// The gate has to be right more than it has to be quick.
//
// FOUND IN R237. Vitest's default for the forks pool is one fork per core minus
// one. On a machine also running the compose stack that oversubscribes: each
// fork carries its own module graph, three files take 40-48 s of wall time by
// themselves, and the 20 s PER-TEST timeout then fires on tests that take one
// to six seconds unloaded. The suite failed about every other run — always a
// timeout, never an assertion — and the victim moved around (aiAnalyst,
// sheetsSamples, docsFactCheck, nl2sqlEval, connectedIntegrations), which is
// what finally ruled out "those two tests are slow" and pointed at contention.
//
// Measured on 8 cores with ~6 GB free, nothing else running:
//
//   default (7 forks)   326 s   7 failures across 4 files
//   4 forks             220 s   all 9,181 pass
//   4 forks again       208 s   all 9,181 pass
//
// This file exists because the obvious "optimisation" is to raise the number,
// and the measurement says that makes the suite slower AND wrong. Every round
// in docs/ADVERSARIAL_LOG.md is only as good as a green gate read from the
// shell; the real risk is the day someone re-runs a genuine failure until it
// passes.
import os from "node:os";

import { describe, expect, it } from "vitest";

import config from "../../vitest.config";

const cores = os.availableParallelism?.() ?? os.cpus().length;

describe("the test runner's own parallelism", () => {
  // Vitest 4 moved the pool's options to the top level: `maxWorkers` is what
  // `poolOptions.forks.maxForks` was.
  it("uses at most half the machine's cores", () => {
    const maxForks = config.test?.maxWorkers;
    expect(typeof maxForks, "maxWorkers must be pinned, not left to the default").toBe("number");
    expect(maxForks).toBeGreaterThanOrEqual(1);
    expect(maxForks, `${cores} cores: more than half oversubscribes`).toBeLessThanOrEqual(
      Math.max(1, Math.floor(cores / 2)),
    );
  });

  it("never asks for more workers than vitest's own default would", () => {
    // On a 2-core CI runner the default is 1. A formula that returned 2 there
    // would make the small machine MORE parallel, which is the opposite of
    // what was measured.
    const maxForks = config.test?.maxWorkers as number;
    expect(maxForks).toBeLessThanOrEqual(Math.max(1, cores - 1));
  });

  it("pins the pool it was measured with", () => {
    // The cap was measured on the forks pool; switching pools silently drops
    // the cap and the flakiness comes back without this file noticing.
    expect(config.test?.pool).toBe("forks");
  });

  it("keeps a per-test timeout that catches a hang", () => {
    // The timeout is a hang detector. It was never the problem — it was the
    // messenger — so it stays tight now that the contention is gone.
    expect(config.test?.testTimeout).toBeLessThanOrEqual(30_000);
  });
});
