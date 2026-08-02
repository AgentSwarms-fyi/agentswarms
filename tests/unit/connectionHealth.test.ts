// Scheduled health checks and credential age for data connections.
//
// The whole feature turns on ONE distinction: credential age must be measured
// from credentials_rotated_at, never updated_at. The health pass writes to
// every row it checks, and `updated_at` has a trigger, so measuring from it
// would report every credential as rotated moments ago — the signal inverts
// exactly where it matters, and nothing visibly breaks.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  credentialAgeDays,
  credentialMaxAgeDays,
  isCredentialStale,
} from "@/utils/integrations/connectionHealth.server";
import {
  CREDENTIAL_STALE_DAYS,
  credentialAgeDays as clientAgeDays,
} from "@/components/integrations/ConnectionHealthBadges";

const healthSrc = readFileSync("src/utils/integrations/connectionHealth.server.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260779000000_connection_health.sql", "utf8");

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
  delete process.env.CREDENTIAL_MAX_AGE_DAYS;
});
afterEach(() => {
  delete process.env.CREDENTIAL_MAX_AGE_DAYS;
});

describe("credential age", () => {
  it("counts whole days since rotation", () => {
    expect(credentialAgeDays(daysAgo(0))).toBe(0);
    expect(credentialAgeDays(daysAgo(1))).toBe(1);
    expect(credentialAgeDays(daysAgo(400))).toBe(400);
  });

  it("is null when never recorded, rather than zero", () => {
    // Zero would read as "rotated today" — the most reassuring possible answer
    // to a question we cannot actually answer.
    expect(credentialAgeDays(null)).toBeNull();
    expect(credentialAgeDays(undefined)).toBeNull();
    expect(credentialAgeDays("not a date")).toBeNull();
  });

  it("never goes negative on a clock skew", () => {
    expect(credentialAgeDays(new Date(Date.now() + 86_400_000).toISOString())).toBe(0);
  });

  it("flags a credential past the policy age", () => {
    expect(isCredentialStale(daysAgo(89))).toBe(false);
    expect(isCredentialStale(daysAgo(91))).toBe(true);
  });

  it("never flags one whose age is unknown", () => {
    // An unknown age is not evidence of staleness, and a warning on every
    // pre-migration row would be noise nobody could act on.
    expect(isCredentialStale(null)).toBe(false);
  });

  it("takes the policy age from the environment", () => {
    process.env.CREDENTIAL_MAX_AGE_DAYS = "30";
    expect(credentialMaxAgeDays()).toBe(30);
    expect(isCredentialStale(daysAgo(45))).toBe(true);
  });

  it("falls back to 90 days on a nonsense value", () => {
    for (const bad of ["", "soon", "0", "-5"]) {
      process.env.CREDENTIAL_MAX_AGE_DAYS = bad;
      expect(credentialMaxAgeDays(), `CREDENTIAL_MAX_AGE_DAYS=${bad}`).toBe(90);
    }
  });
});

describe("the client badge agrees with the server", () => {
  // The calculation is duplicated on purpose — importing the server module
  // into the browser bundle would drag in the Supabase admin client. That is a
  // reasonable trade only while the two actually agree.
  it("computes the same age", () => {
    for (const d of [0, 1, 45, 89, 90, 400]) {
      expect(clientAgeDays(daysAgo(d)), `${d} days`).toBe(credentialAgeDays(daysAgo(d)));
    }
    expect(clientAgeDays(null)).toBe(credentialAgeDays(null));
  });

  it("uses the same default threshold", () => {
    expect(CREDENTIAL_STALE_DAYS).toBe(credentialMaxAgeDays());
  });
});

describe("age is measured from the right column", () => {
  it("reads credentials_rotated_at and never updated_at", () => {
    expect(healthSrc).toContain("credentials_rotated_at");
    // The health writer must not touch it. If it did, every checked credential
    // would look brand new.
    const writer = healthSrc.slice(
      healthSrc.indexOf("async function recordResult"),
      healthSrc.indexOf("async function checkKind"),
    );
    expect(writer).not.toMatch(/credentials_rotated_at\s*:/);
    expect(writer).toContain("last_tested_at");
  });

  it("is set on save, where the credential actually changes", () => {
    for (const f of ["src/utils/warehouse.functions.ts", "src/utils/saas.functions.ts"]) {
      expect(readFileSync(f, "utf8"), `${f} never records a rotation`).toMatch(
        /credentials_rotated_at:\s*new Date\(\)\.toISOString\(\)/,
      );
    }
  });
});

describe("the probe is the product's own read path", () => {
  it("tests a warehouse with the real driver, not a bespoke check", () => {
    // A hand-written probe passes while the real query path is broken — which
    // is the only failure mode a health check exists to catch.
    expect(healthSrc).toContain("testWarehouseConnection");
    expect(healthSrc).toContain("loadWarehouseConnection");
  });

  it("tests an app source with the same call the UI's test button makes", () => {
    expect(healthSrc).toContain("listSaasStreams");
  });

  it("loads connections scoped to their OWNER", () => {
    // It runs under the service role with RLS off, so an id alone is not a
    // tenant boundary.
    expect(healthSrc).toContain("row.user_id");
    const probe = healthSrc.slice(
      healthSrc.indexOf("async function probe"),
      healthSrc.indexOf("async function recordResult"),
    );
    expect(probe).toContain('.eq("user_id", row.user_id)');
  });
});

describe("the pass stays bounded and advisory", () => {
  it("never disables a connection automatically", () => {
    // Disabling someone's production warehouse because a probe failed once is
    // not a decision a background job gets to make.
    const writer = healthSrc.slice(healthSrc.indexOf("async function recordResult"));
    expect(writer).not.toMatch(/is_active:\s*false/);
  });

  it("caps how many it checks per pass", () => {
    expect(healthSrc).toContain("MAX_CHECKS_PER_PASS");
    expect(healthSrc).toContain(".slice(0, MAX_CHECKS_PER_PASS)");
  });

  it("checks the least-recently-tested first", () => {
    // Without the sort, the same few rows get re-checked and the rest never do.
    expect(healthSrc).toContain("sort((a, b) => a.checkedAt - b.checkedAt)");
  });

  it("notifies only on a transition, not every failing pass", () => {
    // A connection broken for a week should not send seven identical alerts.
    expect(healthSrc).toContain('prev !== "error"');
  });

  it("can be turned off by the operator", () => {
    expect(healthSrc).toMatch(/CONNECTION_HEALTH_HOURS/);
    expect(healthSrc).toMatch(/\^\(0\|off\|false\|no\)\$/);
  });

  it("is registered on the shared scheduler pass", () => {
    // Unregistered, everything above is about code that never runs.
    const refresh = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
    expect(refresh).toContain("checkConnectionHealth(force)");
  });
});

describe("the migration", () => {
  it("backfills credential age from created_at, not now()", () => {
    // Defaulting to now() would reset every existing connection's age to zero
    // on deploy, hiding exactly the stale credentials this surfaces.
    expect(migration).toMatch(/SET credentials_rotated_at = created_at/);
    expect(migration).not.toMatch(/SET credentials_rotated_at = now\(\)/i);
  });

  it("adds the column to both connection tables", () => {
    for (const t of ["data_warehouse_connections", "saas_connections"]) {
      const adds = [...migration.matchAll(/ALTER TABLE public\.(\w+)[\s\S]*?;/g)]
        .filter((m) => m[0].includes("credentials_rotated_at"))
        .map((m) => m[1]);
      expect(adds, `${t} missing credentials_rotated_at`).toContain(t);
    }
  });

  it("gives app sources their own test columns, separate from sync", () => {
    expect(migration).toContain("last_test_status");
    expect(migration).toContain("last_tested_at");
  });

  it("indexes the scan so it is not a full table scan every pass", () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_dw_connections_health/i);
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_saas_connections_health/i);
  });

  it("is re-runnable", () => {
    // Every statement is guarded, so a partially-applied migration can be
    // replayed without hand-editing it.
    const alters = migration.match(/ADD COLUMN(?! IF NOT EXISTS)/g);
    expect(alters, "an unguarded ADD COLUMN would fail on re-run").toBeNull();
  });
});
