// Browser end-to-end checks: a real Chromium against the BUILT app (R324).
//
// The unit suite reads code and runs it in Node; scripts/ui-smoke.mjs renders
// every route on the server. Neither runs the client: a page that renders on
// the server and then throws while hydrating, or whose navigation is broken
// in the browser, passed both. These load the built server (`npm run build`
// first) in Chromium and fail on an uncaught page error, a console error, an
// error boundary, or a client-side navigation that does not happen.
//
// They need no backend and no secrets, so they run in CI on a fork: the pages
// covered are the public ones, which render without a session.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 4173);

const browser = {
  ...devices["Desktop Chrome"],
  // CI installs Playwright's Chromium (`npx playwright install chromium`).
  // E2E_CHANNEL=chrome drives the Chrome already installed instead, so a
  // local run needs no browser download.
  ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
};

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "test-results/e2e-report" }]]
    : "list",
  outputDir: "test-results/e2e",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    // Each page loaded once before the checks, so they time pages, not the
    // server's first start (R343: warm.setup.ts says what that cost).
    { name: "warm", testMatch: "warm.setup.ts", use: { ...browser } },
    {
      name: "chromium",
      testMatch: "**/*.spec.ts",
      dependencies: ["warm"],
      use: { ...browser },
    },
  ],
  webServer: {
    command: "node server.mjs",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      WEB_CONCURRENCY: "1",
      // No scheduler: these checks start nothing on a timer.
      DISABLE_INPROCESS_SCHEDULER: "1",
    },
  },
});
