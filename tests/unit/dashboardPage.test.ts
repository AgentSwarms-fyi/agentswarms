// The dashboard page, held to what it is for.
//
// It exists to answer one question — is this deployment healthy, and what is
// it costing — so the tests here are mostly about ORDER and UNITS: what the
// page puts first, and whether the numbers it prints mean what they say.
//
// The page it replaced was measured before it was changed: 3,241px tall, with
// the first figure read from the deployment at y=2,039, behind a 920px grid of
// static feature tiles that the sidebar already lists. Those tiles are the
// thing this file mostly guards against coming back.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { activityMetrics } from "@/lib/dashboardActivity";

const page = readFileSync("src/routes/_authenticated/dashboard.tsx", "utf8");
/** The page with its comments stripped, for asserting an ABSENCE. */
const code = page
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");

describe("the numbers mean what they say", () => {
  it("prints the success rate in the unit the metric is already in", () => {
    // FOUND IN A SCREENSHOT, not by a type. `activityMetrics` returns a
    // PERCENTAGE (it rounds `ok / decided * 100` itself), and the first
    // version of this page multiplied it by 100 again and rendered "10000%".
    // Both sides typecheck, so only rendering it caught it.
    const rows = [
      { status: "success", latency_ms: 10, cost_usd: 0, created_at: new Date().toISOString() },
      { status: "error", latency_ms: 10, cost_usd: 0, created_at: new Date().toISOString() },
      // Cancelled leaves the denominator entirely.
      { status: "cancelled", latency_ms: 10, cost_usd: 0, created_at: new Date().toISOString() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[];
    const m = activityMetrics({ rows, truncated: false });
    expect(m.successRate).toBe(50);

    // So the page must not scale it again.
    expect(code).not.toMatch(/successRate \* 100/);
    expect(code).toMatch(/\$\{metrics\.successRate\}%/);
  });

  it("compares the rate against percentage thresholds, not fractions", () => {
    // The same mistake in the other direction: thresholds of 0.95/0.8 against
    // a 0-100 value paint every rate above 1% green.
    expect(code).toMatch(/metrics\.successRate >= 95/);
    expect(code).toMatch(/metrics\.successRate >= 80/);
    expect(code).not.toMatch(/successRate >= 0\.\d/);
  });

  it("renders the budget cap it fetches", () => {
    // The old page read `budget_settings.monthly_cap_usd`, used it only to
    // decide whether to show a pill, and never printed it — so the one number
    // an owner wants, how much of the month is gone, was computed and thrown
    // away.
    expect(code).toMatch(/budget\.cap/);
    expect(code).toMatch(/budget\.spend/);
    expect(code).toMatch(/progress=\{budgetPct\}/);
  });
});

describe("what the page leads with", () => {
  it("puts the status band and the figures above everything else", () => {
    const band = code.indexOf("<StatusBand");
    const kpis = code.indexOf("<KpiTile");
    const surface = code.indexOf("<PlatformSurface");
    const spend = code.indexOf("<SpendPanel");
    expect(band, "the status band is gone").toBeGreaterThan(-1);
    expect(kpis).toBeGreaterThan(band);
    // Everything that is a list of things you own comes after the answer to
    // "is it working".
    expect(surface).toBeGreaterThan(kpis);
    expect(spend).toBeGreaterThan(kpis);
  });

  it("no longer carries a second copy of the navigation", () => {
    // Twelve static feature tiles, a static embedding callout and four static
    // swarm templates: ~1,500px of brochure in front of the data, identical on
    // day one and day four hundred, duplicating the sidebar.
    expect(code).not.toContain("FEATURE_GROUPS");
    expect(code).not.toContain("SWARM_TEMPLATES");
    expect(code).not.toContain("Explore the platform");
    expect(code).not.toContain("Web Embedding");
  });

  it("says the platform is healthy out loud, not only when it is not", () => {
    const band = readFileSync("src/components/dashboard/StatusBand.tsx", "utf8");
    expect(band).toContain("Everything is running");
    // A band that renders only on failure teaches nobody it exists, and its
    // absence reads as "not loaded yet".
    expect(band).toMatch(/checked /);
  });
});

describe("the two states are different pages", () => {
  it("shows a checklist, not a console full of zeroes, to a new account", () => {
    // Five zeroes, a flat 2px sparkline and three "no runs yet" messages is
    // what the old page showed on day one. That reads as broken, not as new.
    expect(code).toMatch(/const firstRun =/);
    expect(code).toMatch(/firstRun \?\s*\(?\s*<FirstRun/);
    // Derived from real state, so a tick is not something the page can be
    // wrong about.
    for (const signal of ["traces.length === 0", "counts.agents === 0", "counts.pipelines === 0"]) {
      expect(code, `firstRun ignores ${signal}`).toContain(signal);
    }
  });

  it("orders the checklist by what depends on what", () => {
    const first = readFileSync("src/components/dashboard/FirstRun.tsx", "utf8");
    expect(first).toContain("findIndex");
    // Only the next step gets a button; a checklist where every row shouts is
    // a menu, and the sidebar is already the menu.
    expect(first).toMatch(/i === next/);
    const steps = code.slice(code.indexOf("const steps: Step[]"));
    const order = ["Connect a model provider", "Build an agent", "Run it once"].map((t) =>
      steps.indexOf(t),
    );
    expect(order.every((n) => n > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("the platform's own surface is counted, not advertised", () => {
  it("names the data half, which the old page never mentioned as yours", () => {
    // It listed nine agent-side features and none of ETL, the lakehouse, SQL
    // models, ML, workflows or monitors as things you might already be running.
    for (const label of [
      "ETL pipelines",
      "Lakehouse",
      "SQL models",
      "ML models",
      "Workflows",
      "Data monitors",
    ]) {
      expect(code, `${label} is missing from the surface`).toContain(label);
    }
  });

  it("counts them from tables rather than hard-coding a list", () => {
    for (const table of ["ml_models", "workflows", "sql_models", "data_monitors"]) {
      expect(code).toContain(`countOf("${table}")`);
    }
    // And a deployment that has not migrated one of them gets 0, not a page
    // that fails to render.
    expect(code).toMatch(/async function countOf[\s\S]{0,300}catch \{\s*return 0;/);
  });

  it("surfaces the failures those tables already record", () => {
    for (const q of ["data_incidents", "last_run_status", "last_status"]) {
      expect(code).toContain(q);
    }
  });
});

describe("the chart is a chart", () => {
  it("uses the charting library the rest of the app uses", () => {
    const chart = readFileSync("src/components/dashboard/ActivityChart.tsx", "utf8");
    expect(chart).toContain('from "recharts"');
    // It was 24 divs with an inline height percentage: no axis, no real
    // tooltip, and a flat 2px line for a quiet day that read as a failure.
    expect(code).not.toMatch(/minHeight: "2px"/);
    expect(chart).toContain("YAxis");
  });

  it("labels each bucket with the hour it covers", () => {
    const chart = readFileSync("src/components/dashboard/ActivityChart.tsx", "utf8");
    // bucketHour(index, now) — passing only the index silently typechecked in
    // neither direction, but reversing the index would have mislabelled every
    // bar by a day.
    expect(chart).toMatch(/bucketHour\(i, now\)/);
  });
});
