// Config for tests that reach a REAL Supabase project.
//
// A separate file rather than a flag, because `vitest run --dir tests/integration`
// does NOT work: the default config excludes tests/integration, and --dir
// narrows the search without lifting the exclude, so the run exits with
// "No test files found". A documented command that silently finds nothing is
// worse than no command.
//
//   npm run test:integration
//
// Never wired into CI. These tests need credentials and write real rows; the
// suite skips itself cleanly when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// absent, so running it without a project is a no-op rather than a failure.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": path.resolve(rootDir, "src") } },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // These talk to a network service and some deliberately wait for a lease
    // to expire, so they need more room than a unit test.
    testTimeout: 60_000,
    // One file at a time: several suites share limiter tables and clean up by
    // prefix, so parallel files would delete each other's rows mid-run.
    fileParallelism: false,
  },
});
