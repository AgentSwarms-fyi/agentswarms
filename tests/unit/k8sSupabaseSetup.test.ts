// The Kubernetes installer's Supabase half.
//
// WHY IT USES A CHART. Supabase self-hosted is a dozen services — Kong, Studio,
// Postgres, PostgREST, Realtime, Storage, Meta, GoTrue, Edge Functions,
// Logflare, Vector, Imgproxy, MinIO — whose bootstrap SQL, roles and per-service
// environment move between versions. An earlier draft of this script shipped
// hand-written manifests for them and needed five fixes before Postgres would
// start: wrong UID (105, not the official image's 999), a conflicting PGDATA,
// volume ownership that fsGroup does not fix, `:latest` defaulting to
// imagePullPolicy Always, and finally the role bootstrap (`authenticator`,
// `anon`, `supabase_auth_admin` …) that a bare supabase/postgres image does not
// create. Every one of those was upstream's wiring, re-derived by hand and
// destined to fall behind. The community chart tracks it; we do not.
//
// These tests pin the decision and the two runtime lookups that couple our
// script to the chart's naming — both verified against `helm template` output
// for chart 0.7.2, not assumed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(process.cwd(), "scripts/setup-k8s.sh"), "utf8");

describe("Supabase comes from the community chart", () => {
  it("installs from the published Helm repo, at a pinned version", () => {
    expect(script).toContain("https://supabase-community.github.io/supabase-kubernetes");
    expect(script).toContain("helm upgrade --install");
    // Unpinned would mean a different Supabase on every install, and no way to
    // reproduce a working one.
    expect(script).toMatch(/SUPABASE_CHART_VERSION:-\d+\.\d+\.\d+/);
    expect(script).toContain('--version "$CHART_VERSION"');
  });

  it("ships no hand-maintained Supabase manifests", () => {
    // The whole point of the change: one copy of Supabase's wiring, upstream's.
    expect(
      existsSync(resolve(process.cwd(), "deploy/k8s/supabase")),
      "deploy/k8s/supabase should not exist — Supabase is installed via Helm",
    ).toBe(false);
  });

  it("keeps OUR components as plain manifests", () => {
    // Four Deployments we own and understand; a chart would be ceremony.
    expect(existsSync(resolve(process.cwd(), "deploy/k8s/app/agentswarms.yaml"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "deploy/k8s/app/services.yaml"))).toBe(true);
    expect(script).toContain("deploy/k8s/app/agentswarms.yaml");
    expect(script).toContain("deploy/k8s/app/services.yaml");
  });
});

describe("the lookups that couple the script to the chart", () => {
  // VERIFIED against `helm template supabase supabase/supabase --version 0.7.2`:
  //   Service      supabase-supabase-kong
  //   StatefulSet  supabase-supabase-db, selector app.kubernetes.io/name=supabase-db
  // If the chart renames either, these are the two lines that must change.
  it("finds the API gateway by name rather than hard-coding it", () => {
    expect(script).toContain("grep -- '-kong'");
    expect(script).toContain('SUPABASE_URL="http://${KONG_SVC}:8000"');
  });

  it("finds the database pod by the chart's label", () => {
    expect(script).toContain("app.kubernetes.io/name=supabase-db");
  });
});

describe("secrets", () => {
  it("SIGNS the anon and service-role keys rather than generating noise", () => {
    // They are JWTs verified against the JWT secret by every service. A random
    // string yields a stack that starts and then rejects every request.
    expect(script).toContain("sign_key anon");
    expect(script).toContain("sign_key service_role");
    expect(script).toContain("openssl dgst -binary -sha256 -hmac");
  });

  it("writes the Helm values to a temp file, not into the repo", () => {
    // The values carry every secret the stack has.
    expect(script).toContain('VALUES="$(mktemp)"');
    expect(script).toContain("trap 'rm -f \"$VALUES\"' EXIT");
  });

  it("reuses secrets on a re-run", () => {
    // Regenerating the JWT secret invalidates every key and session issued.
    expect(script).toContain("agentswarms-bootstrap");
    expect(script).toContain("Reusing the existing secrets");
  });
});

describe("ordering the schema depends on", () => {
  it("waits for the storage service's own migrations first", () => {
    // Three AgentSwarms migrations write to storage.buckets.public, a column
    // the storage service creates on its first boot.
    expect(script).toContain("storage.buckets.public".replace(".", "."));
    expect(script).toContain("table_name='buckets' and column_name='public'");
  });

  it("stops on the first failing migration", () => {
    // A half-applied schema fails later in ways that name the wrong cause.
    expect(script).toContain("ON_ERROR_STOP=1");
    expect(script).toContain("Migration failed:");
  });
});
