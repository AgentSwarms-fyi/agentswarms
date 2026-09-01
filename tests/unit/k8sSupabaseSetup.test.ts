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

describe("images the cluster has to be able to pull", () => {
  // Strip comment lines first. Two earlier tests in this repo passed against
  // their own explanatory comments; the usage example directly above
  // DOCGEN_IMAGE contains every string this block looks for.
  const code = script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  const manifests = ["deploy/k8s/app/agentswarms.yaml", "deploy/k8s/app/services.yaml"];
  const yaml = manifests.map((m) => readFileSync(resolve(process.cwd(), m), "utf8")).join("\n");

  it("lets every image we build be overridden", () => {
    // A cluster that is not this laptop cannot see `docker build` output. All
    // three of ours have to be redirectable at a registry, not just the web one
    // — AGENTSWARMS_IMAGE alone was the bug: it was honoured by the local build
    // check and then ignored by the apply, so docgen and the sandbox reached
    // ImagePullBackOff on any remote cluster.
    expect(code).toMatch(/IMAGE="\$\{AGENTSWARMS_IMAGE:-/);
    expect(code).toMatch(/DOCGEN_IMAGE="\$\{DOCGEN_IMAGE:-/);
    expect(code).toMatch(/JS_SANDBOX_IMAGE="\$\{JS_SANDBOX_IMAGE:-/);
  });

  it("applies the manifests THROUGH the substitution, never raw", () => {
    for (const manifest of manifests) {
      // Plain containment, not a built RegExp: the first version of this test
      // escaped `$` and `|` for a template literal, JS ate the backslashes, and
      // the surviving pattern was an alternation that matched an unrelated
      // `kubectl apply -f -` elsewhere in the script. It passed against the very
      // mutation it existed to catch.
      expect(code, `${manifest} must be piped through with_images`).toContain(
        `with_images "$REPO_ROOT/${manifest}" | kubectl apply -f -`,
      );
      // The failure mode this guards: someone adds a manifest and reaches for
      // the shorter `kubectl apply -f <file>`, which silently deploys
      // agentswarms:latest to a cluster that has never seen it.
      expect(code).not.toContain(`kubectl apply -f "$REPO_ROOT/${manifest}"`);
    }
  });

  it("substitutes every image the manifests actually name", () => {
    const substituted = yaml
      .replaceAll("image: agentswarms:latest", "image: REG/app")
      .replaceAll("image: agentswarms/docgen:latest", "image: REG/docgen")
      .replaceAll("image: agentswarms/js-sandbox:latest", "image: REG/sandbox");
    // Nothing of ours left pointing at a local-only name.
    expect(substituted).not.toMatch(/image: agentswarms[:/]/);
    // And all three were really present to begin with, so this cannot pass by
    // matching nothing.
    for (const tag of ["REG/app", "REG/docgen", "REG/sandbox"]) {
      expect(substituted).toContain(`image: ${tag}`);
    }
  });

  it("pins the third-party images it does not build", () => {
    const foreign = [...yaml.matchAll(/image: (?!agentswarms)([^\s]+)/g)].map((m) => m[1]);
    expect(foreign.length).toBeGreaterThan(0);
    for (const image of foreign) {
      // `:latest` on someone else's image means the deployment changes under
      // you on any pod reschedule, and imagePullPolicy defaults to Always.
      expect(image, `${image} should be pinned to a version`).not.toMatch(/:latest$/);
      expect(image, `${image} should carry an explicit tag`).toMatch(/:/);
    }
  });

  it("warns before installing a local-only image onto a remote cluster", () => {
    // ImagePullBackOff names the image but not the reason, and only after the
    // install has already run. Say it up front instead.
    expect(code).toContain("kubectl config current-context");
    expect(code).toMatch(/docker-desktop \| minikube \| kind-\*/);
    expect(code).toContain("cannot pull an image that only exists on this machine");
  });
});
