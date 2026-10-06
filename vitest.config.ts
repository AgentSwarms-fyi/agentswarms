// Test runner config, deliberately separate from vite.config.ts.
//
// The app build loads the TanStack Start plugin, which generates a route tree
// and rewires the module graph for SSR. None of that is wanted (or safe) in a
// unit test run, so tests get a minimal config: path aliases and nothing else.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Half the machine, never more than vitest's own default.
 *
 * FOUND IN R237. Vitest's default for the forks pool is one fork per core
 * minus one, and on a developer machine running the compose stack that
 * oversubscribes badly: each fork carries its own module graph, three test
 * files take 40-48 seconds of wall time on their own, and everything else
 * queues behind them. The 20-second per-test timeout then fires on tests that
 * take one to six seconds unloaded, so the suite failed roughly every other
 * run with a TIMEOUT and never an assertion. Measured on 8 cores with ~6 GB
 * free, nothing else running:
 *
 *   default (7 forks)   326 s   7 failures across 4 files
 *   4 forks             220 s   all 9,181 pass
 *   4 forks again       208 s   all 9,181 pass
 *
 * So this is not a speed-for-determinism trade: the oversubscribed run was
 * both flaky AND a third slower, because the contention it created cost more
 * than the extra workers won. Raising this number is very unlikely to make the
 * suite faster, and has twice been observed to make it wrong.
 *
 * A gate that is wrong half the time is worse than a slow one: every round in
 * docs/ADVERSARIAL_LOG.md depends on reading it, and the real risk is the day
 * someone re-runs a GENUINE failure until it passes.
 */
const cores = os.availableParallelism?.() ?? os.cpus().length;
const maxForks = Math.max(1, Math.floor(cores / 2));

export default defineConfig({
  // An explicit alias rather than vite-tsconfig-paths: the tsconfig `include`
  // globs cover src/ only, so the plugin doesn't apply the "@/" mapping to
  // files under tests/. Hard-coding it here is one line and never surprises.
  resolve: { alias: { "@": path.resolve(rootDir, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests reach a real Supabase project and are opt-in — they
    // must never run by accident in CI, where they would either fail on
    // missing credentials or, worse, write to whatever project happened to be
    // configured.
    exclude: ["tests/integration/**", "node_modules/**", "dist/**"],
    pool: "forks",
    // Vitest 4 moved the pool's options to the top level: `maxWorkers` is
    // what `poolOptions.forks.maxForks` was.
    maxWorkers: maxForks,
    testTimeout: 20_000,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: process.env.CI ? { junit: "./test-results/junit.xml" } : undefined,
  },
});
