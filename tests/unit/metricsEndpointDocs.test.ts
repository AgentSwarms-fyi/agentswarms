// The names on /api/metrics are an operator's API.
//
// Nobody reads a metric name; they paste it into an alert rule, and a metric
// that does not exist does not error — the expression matches no series and the
// alert never fires. A dashboard shows an empty panel that looks like calm. So
// a wrong name in the documentation or the shipped alert pack is a monitoring
// gap that presents as good news, which is the worst way for a fact to be
// wrong.
//
// Both directions are checked. A name used outside the endpoint that the
// endpoint never emits is a rule that silently watches nothing; a name emitted
// and mentioned nowhere is a metric nobody knows they have.
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const NAME = /\bagentswarms_[a-z0-9_]+/g;

const emitted = new Set(rd("src/routes/api/metrics.ts").match(NAME) ?? []);

/** Everywhere else a metric name is written: prose, and the alert pack. */
const CONSUMERS = [
  "docs/DEPLOYMENT.md",
  "docs/SCALE_AND_LIMITS.md",
  "deploy/prometheus/alerts.yml",
  ...readdirSync("src/routes")
    .filter((f) => f.startsWith("docs.") && f.endsWith(".tsx"))
    .map((f) => `src/routes/${f}`),
];

describe("the names on /api/metrics", () => {
  it("finds some, so an empty scrape cannot pass as agreement", () => {
    // Mutation-checked: pointing this at a file with no metrics made every
    // assertion below vacuously true.
    expect(emitted.size).toBeGreaterThan(5);
  });

  it("is the only source of names anything else uses", () => {
    const wrong: string[] = [];
    for (const file of CONSUMERS) {
      for (const name of new Set(rd(file).match(NAME) ?? [])) {
        if (!emitted.has(name)) wrong.push(`${file}: ${name}`);
      }
    }
    expect(
      wrong,
      `named outside the endpoint but never emitted — an alert on one of these never fires: ${wrong.join(", ")}`,
    ).toEqual([]);
  });

  it("has every metric written down somewhere an operator reads", () => {
    const seen = new Set(CONSUMERS.flatMap((f) => rd(f).match(NAME) ?? []));
    const unmentioned = [...emitted].filter((n) => !seen.has(n));
    expect(
      unmentioned,
      `emitted but documented nowhere, so nobody knows it exists: ${unmentioned.join(", ")}`,
    ).toEqual([]);
  });
});
