// R467: the schema installs on a plain PostgreSQL, not only Supabase's image.
//
// Amazon RDS (and every managed Postgres) gives no superuser and has no
// pg_net, pgmq or supabase_vault. Measured with deploy/ci/rds-like/run.sh: on
// an RDS-shaped PostgreSQL 17 whose admin is not a superuser, the bootstrap,
// GoTrue, storage-api and all 292 migrations install, PostgREST serves them,
// RLS holds between users and service_role bypasses it. What keeps that true:
//
// - the four optional extensions are only ever created inside a guard that
//   skips them, and pg_cron jobs only scheduled where pg_cron exists;
// - vector, which the app needs, stays a hard requirement;
// - no pg_cron job outlives the migrations: retention is the app's, one
//   configurable rule on every database (20261113000000);
// - the bootstrap gives the admin the service roles before their schemas
//   (PostgreSQL 16+ refuses otherwise), and creates service_role BYPASSRLS;
// - the runner records migrations where the Supabase CLI looks.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const rd = (p: string) => readFileSync(p, "utf8");
const sqlOf = (f: string) => rd(`${DIR}/${f}`);
/** The file with comments and every DO block removed: what runs unguarded. */
const unguarded = (sql: string) =>
  sql.replace(/--[^\n]*/g, "").replace(/DO\s+(\$[A-Za-z_]*\$)[\s\S]*?\1\s*;/g, "");

const OPTIONAL = ["pg_net", "pg_cron", "supabase_vault", "pgmq"];

describe("a database without Supabase's extensions installs everything", () => {
  it("no migration creates an optional extension outside a guard", () => {
    const bare: string[] = [];
    for (const f of files) {
      const top = unguarded(sqlOf(f));
      for (const ext of OPTIONAL) {
        if (new RegExp(`CREATE\\s+EXTENSION[^;]*\\b${ext}\\b`, "i").test(top))
          bare.push(`${f}: ${ext}`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("every guard catches the failure instead of passing it on", () => {
    for (const f of files) {
      const sql = sqlOf(f);
      if (!OPTIONAL.some((e) => new RegExp(`CREATE\\s+EXTENSION[^;]*\\b${e}\\b`, "i").test(sql))) {
        continue;
      }
      expect(sql, f).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE NOTICE/);
    }
  });

  it("pg_cron is only called where it exists", () => {
    const bare = files.filter((f) => /\b(SELECT|PERFORM)\s+cron\./i.test(unguarded(sqlOf(f))));
    expect(bare).toEqual([]);
  });

  it("vector stays required: the app's embeddings need it", () => {
    const creates = files.filter((f) =>
      /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector\s*;/i.test(unguarded(sqlOf(f))),
    );
    expect(creates.length).toBeGreaterThan(0);
  });
});

describe("retention is the app's, on every database", () => {
  it("every pg_cron job a migration schedules, a later one unschedules", () => {
    const scheduled = new Map<string, string>();
    for (const f of files) {
      for (const m of sqlOf(f).matchAll(/cron\.schedule\(\s*'([^']+)'/g)) scheduled.set(m[1], f);
    }
    expect([...scheduled.keys()].sort()).toEqual([
      "cleanup-old-observability-data",
      "purge-old-swarm-runs",
    ]);
    const removal = sqlOf("20261113000000_retention_in_one_place.sql");
    for (const [job, from] of scheduled) {
      expect(removal, `${job} (from ${from}) is never unscheduled`).toContain(`'${job}'`);
      expect(files.indexOf("20261113000000_retention_in_one_place.sql")).toBeGreaterThan(
        files.indexOf(from),
      );
    }
    expect(removal).toMatch(/IF EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'\)/);
    expect(removal).toContain("cron.unschedule(jobid)");
  });

  it("the app's own purge keeps everything unless an admin says otherwise", () => {
    const retention = rd("src/utils/observability/retention.server.ts");
    expect(retention).toContain("0 (default) → keep forever");
    expect(retention).toContain("provenance_retention_days");
  });
});

describe("the bootstrap a managed Postgres's admin runs", () => {
  const boot = rd("deploy/aws/spec/bootstrap/rds-bootstrap.sql");

  it("joins the service roles before giving them schemas (PostgreSQL 16+)", () => {
    const grant = boot.indexOf(
      "GRANT supabase_auth_admin, supabase_storage_admin TO CURRENT_USER;",
    );
    expect(grant).toBeGreaterThan(-1);
    expect(grant).toBeLessThan(boot.indexOf("CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION"));
    expect(grant).toBeLessThan(boot.indexOf("CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION"));
  });

  it("creates the roles Supabase's services use, service_role with BYPASSRLS", () => {
    expect(boot).toContain("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    for (const r of [
      "anon",
      "authenticated",
      "authenticator",
      "supabase_auth_admin",
      "supabase_storage_admin",
    ]) {
      expect(boot).toContain(`'${r}'`);
    }
    expect(boot).toContain("GRANT anon, authenticated, service_role TO authenticator;");
    expect(boot).toContain("CREATE PUBLICATION supabase_realtime");
  });

  it("can run again: every create checks first", () => {
    const creates =
      boot.replace(/--[^\n]*/g, "").match(/CREATE (ROLE|SCHEMA|EXTENSION|PUBLICATION)[^\n]*/g) ??
      [];
    for (const c of creates) {
      const guarded = /IF NOT EXISTS/.test(c) || /^CREATE (ROLE|PUBLICATION)/.test(c); // roles and the publication go through \gexec with NOT EXISTS
      expect(guarded, c).toBe(true);
    }
    expect(boot.match(/\\gexec/g)?.length).toBe(4);
  });
});

const bash = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;

describe("the scripts parse", () => {
  // The runner once shipped with an apostrophe inside ${VAR:?message}, which
  // bash reads as an opening quote: it failed on its first line of work.
  it.skipIf(!bash)("bash -n accepts every script R467 added", () => {
    for (const f of [
      "docker/db-migrate/apply-migrations.sh",
      "deploy/ci/rds-like/run.sh",
      "deploy/ci/rds-like/init/00-rds-like.sh",
    ]) {
      const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
      expect(r.stderr, f).toBe("");
      expect(r.status, f).toBe(0);
    }
  });
});

describe("the migration runner", () => {
  const runner = rd("docker/db-migrate/apply-migrations.sh");

  it("records each migration where the Supabase CLI looks, one transaction per file", () => {
    expect(runner).toContain("supabase_migrations.schema_migrations");
    expect(runner).toContain('"${P[@]}" -1 -f "$f"');
    expect(runner).toContain("-v ON_ERROR_STOP=1");
  });

  it("is what the RDS-like check runs, against the repository's own migrations", () => {
    const run = rd("deploy/ci/rds-like/run.sh");
    expect(run).toContain("bash /db-migrate/apply-migrations.sh /migrations");
    expect(run).toContain('-v "$ROOT/supabase/migrations:/migrations:ro"');
    expect(run).toContain("-f /bootstrap/rds-bootstrap.sql");
    expect(run).toMatch(/PG=pgvector\/pgvector:[^@\s]+@sha256:[0-9a-f]{64}/);
  });
});
