// The browser checks run in CI, against the build (R324).
//
// A suite nobody runs is a file. These pin that CI builds the app, installs a
// browser and runs the Playwright checks; that the checks start the BUILT
// server; and that Vitest leaves them alone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const config = readFileSync("playwright.config.ts", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("CI", () => {
  const job = ci.slice(ci.indexOf("\n  e2e:"));

  it("has a browser job that builds, installs Chromium, then runs the checks", () => {
    expect(ci).toContain("\n  e2e:");
    const build = job.indexOf("run: npm run build");
    const browser = job.indexOf("run: npx playwright install --with-deps chromium");
    const checks = job.indexOf("run: npm run test:e2e");
    expect(build).toBeGreaterThan(0);
    expect(browser).toBeGreaterThan(build);
    expect(checks).toBeGreaterThan(browser);
  });

  it("uses no secrets: the build gets the same placeholders as verify", () => {
    expect(job).toContain("VITE_SUPABASE_URL: https://placeholder.supabase.co");
    expect(job).not.toMatch(/\$\{\{\s*secrets\./);
  });
});

describe("the checks", () => {
  it("start the built server, not the dev server", () => {
    expect(config).toContain('command: "node server.mjs"');
    expect(config).toContain('testDir: "tests/e2e"');
    expect(pkg.scripts["test:e2e"]).toBe("playwright test");
    expect(pkg.devDependencies["@playwright/test"]).toBeTruthy();
  });

  it("load each page once before the timed checks, which wait for that (R343)", () => {
    expect(config).toMatch(/name: "warm", testMatch: "warm\.setup\.ts"/);
    expect(config).toMatch(/testMatch: "\*\*\/\*\.spec\.ts",\s*dependencies: \["warm"\]/);
    const warm = readFileSync("tests/e2e/warm.setup.ts", "utf8");
    expect(warm).toContain('import { PAGES } from "./pages";');
    expect(warm).toMatch(/for \(const \{ path \} of PAGES\)/);
    expect(readFileSync("tests/e2e/public.spec.ts", "utf8")).toContain(
      'import { PAGES } from "./pages";',
    );
  });

  it("are left out of Vitest", () => {
    expect(readFileSync("vitest.config.ts", "utf8")).toMatch(/exclude: \[[^\]]*"tests\/e2e\/\*\*"/);
  });

  it("fail on a page error and a console error, not only on a missing heading", () => {
    const spec = readFileSync("tests/e2e/public.spec.ts", "utf8");
    expect(spec).toContain('page.on("pageerror"');
    expect(spec).toContain('if (msg.type() !== "error") return;');
    expect(spec).toContain("expect(problems, path).toEqual([]);");
  });
});
