// Test runner config, deliberately separate from vite.config.ts.
//
// The app build loads the TanStack Start plugin, which generates a route tree
// and rewires the module graph for SSR. None of that is wanted (or safe) in a
// unit test run, so tests get a minimal config: path aliases and nothing else.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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
    testTimeout: 20_000,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: process.env.CI ? { junit: "./test-results/junit.xml" } : undefined,
  },
});
