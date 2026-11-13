// R469: what a release publishes, and how. deploy/release/images.json is the
// one list; the release workflow, the image scan, Compose and Dependabot must
// agree with it, every image needs a smoke test, and the workflow that holds
// a write token must keep its supply chain pinned and its permissions narrow.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

type Image = {
  name: string;
  title: string;
  context: string;
  dockerfile: string;
  compose: string | null;
  smoke: string;
};
const manifest = JSON.parse(readFileSync("deploy/release/images.json", "utf8")) as {
  registry: string;
  source: string;
  platforms: string[];
  images: Image[];
};
const compose = yaml.load(readFileSync("docker-compose.yml", "utf8")) as {
  services: Record<string, { build?: string | { context: string } }>;
};
type Step = {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  permissions?: Record<string, string>;
  steps: Step[];
  if?: string;
  needs?: string | string[];
  strategy?: { matrix?: Record<string, unknown> };
};
const releaseText = readFileSync(".github/workflows/release.yml", "utf8");
const release = yaml.load(releaseText) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const scan = yaml.load(readFileSync(".github/workflows/image-scan.yml", "utf8")) as {
  jobs: {
    "first-party": {
      strategy: { matrix: { include: { name: string; context: string; dockerfile?: string }[] } };
    };
  };
};

describe("the list of images", () => {
  it("names each once, with a Dockerfile and a smoke test that exist", () => {
    const names = manifest.images.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    for (const i of manifest.images) {
      expect(existsSync(i.dockerfile), i.dockerfile).toBe(true);
      expect(existsSync(i.smoke), i.smoke).toBe(true);
      expect(i.name, "a GHCR name is lowercase").toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
    expect(manifest.registry).toBe("ghcr.io/agentswarms-fyi");
    expect(manifest.platforms).toEqual(["linux/amd64", "linux/arm64"]);
  });

  it("covers every image Compose builds, by its service", () => {
    const built = Object.entries(compose.services)
      .filter(([, s]) => s.build)
      .map(([name]) => name)
      .sort();
    const listed = manifest.images
      .map((i) => i.compose)
      .filter((c): c is string => !!c)
      .sort();
    expect(listed).toEqual(built);
    for (const i of manifest.images.filter((x) => x.compose)) {
      const b = compose.services[i.compose!].build!;
      const ctx =
        (typeof b === "string" ? b : b.context).replace(/^\.\//, "").replace(/\/$/, "") || ".";
      expect(ctx, i.name).toBe(i.context);
    }
  });

  it("is what the image scan builds", () => {
    const scanned = scan.jobs["first-party"].strategy.matrix.include;
    const byName = (n: string) => scanned.find((s) => s.name === (n === "agentswarms" ? "app" : n));
    for (const i of manifest.images) {
      const s = byName(i.name);
      expect(s, i.name).toBeTruthy();
      expect(s!.context, i.name).toBe(i.context);
      expect(s!.dockerfile ?? `${s!.context}/Dockerfile`.replace(/^\.\//, ""), i.name).toBe(
        i.dockerfile,
      );
    }
    expect(scanned).toHaveLength(manifest.images.length);
  });
});

describe("the smoke tests", () => {
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" }).status === 0;
  it.skipIf(!bash)("parse", () => {
    for (const f of ["deploy/release/smoke/lib.sh", ...manifest.images.map((i) => i.smoke)]) {
      const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
      expect(r.stderr, f).toBe("");
    }
  });

  it("each image but the Docker API proxy is checked not to run as root", () => {
    for (const i of manifest.images) {
      const text = readFileSync(i.smoke, "utf8");
      if (i.name === "docker-socket-proxy") expect(text).not.toMatch(/^not_root$/m);
      else expect(text, i.name).toMatch(/^not_root$/m);
    }
  });

  it("the images that carry a version check it", () => {
    // db-migrate: in its environment; nothing hands it an .env.
    const dbm = manifest.images.find((x) => x.name === "db-migrate")!;
    expect(readFileSync(dbm.smoke, "utf8")).toMatch(/^says_version$/m);
    expect(readFileSync(dbm.dockerfile, "utf8")).toMatch(
      /^ENV AGENTSWARMS_VERSION=\$AGENTSWARMS_VERSION/m,
    );
    // The app: in a file (R470). Compose hands the app the whole .env, whose
    // AGENTSWARMS_VERSION says which release to run; as an environment
    // variable it would override what the image says it is.
    const app = manifest.images.find((x) => x.name === "agentswarms")!;
    const df = readFileSync(app.dockerfile, "utf8");
    expect(df).toContain("> /app/release.json");
    expect(df).not.toMatch(/^ENV AGENTSWARMS_VERSION/m);
    expect(df.indexOf("> /app/release.json")).toBeLessThan(df.indexOf("USER node"));
    expect(readFileSync(app.smoke, "utf8")).toContain("/app/release.json");
    expect(readFileSync("src/utils/release.server.ts", "utf8")).toContain('"release.json"');
  });
});

describe("the release workflow", () => {
  const jobs = release.jobs;
  const allSteps = Object.values(jobs).flatMap((j) => j.steps);

  it("runs on a version tag, and by hand as a rehearsal", () => {
    const push = release.on.push as { tags: string[] };
    expect(push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+", "v[0-9]+.[0-9]+.[0-9]+-*"]);
    expect(release.on).toHaveProperty("workflow_dispatch");
  });

  it("grants nothing by default, and each job only what it uses", () => {
    expect(release.permissions).toEqual({});
    expect(jobs.plan.permissions).toEqual({ contents: "read" });
    expect(jobs.build.permissions).toEqual({ contents: "read", packages: "write" });
    expect(jobs.publish.permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
    });
    expect(jobs.release.permissions).toEqual({ contents: "write" });
  });

  it("pins every action to a commit, with its version beside it", () => {
    const lines = releaseText.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines)
      expect(l.trim()).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it("reads no secret but its own token", () => {
    expect(releaseText).not.toMatch(/secrets\./);
  });

  it("publishes only from a tag, after every image passed its tests on both architectures", () => {
    expect(jobs.publish.needs).toEqual(["plan", "build"]);
    expect(jobs.publish.if).toBe("needs.plan.outputs.publish == 'true'");
    const build = jobs.build.steps.map((s) => s.run ?? s.uses ?? "");
    const at = (re: RegExp) => build.findIndex((s) => re.test(s));
    const smoke = at(/bash "\$\{\{ matrix\.smoke \}\}"/);
    const gate = at(/\$GRYPE_GATE/);
    const push = at(/push-by-digest=true/);
    expect(smoke).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(smoke);
    expect(push).toBeGreaterThan(gate);
    for (const s of jobs.build.steps.filter((x) =>
      /docker login|push-by-digest/.test(x.run ?? ""),
    )) {
      expect(s.if).toBe("needs.plan.outputs.publish == 'true'");
    }
  });

  it("tests what it pushes: the pushed build has the tested build's arguments and labels", () => {
    const runs = jobs.build.steps.map((s) => s.run ?? "");
    const load = runs.find((r) => r.includes("--load"))!;
    const push = runs.find((r) => r.includes("push-by-digest=true"))!;
    const flags = (r: string) =>
      [...r.matchAll(/--(build-arg|label) "([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`).sort();
    expect(flags(load).length).toBeGreaterThan(5);
    expect(flags(push)).toEqual(flags(load));
    expect(push).toContain("--provenance=mode=max --sbom=true");
  });

  it("runs the whole schema from the db-migrate image before it is published", () => {
    const step = jobs.build.steps.find((s) => s.run === "bash deploy/ci/rds-like/run.sh");
    expect(step?.if).toBe("matrix.image == 'db-migrate'");
    expect(step?.env?.MIGRATOR_IMAGE).toBe("release/${{ matrix.image }}:test");
  });

  it("signs each multi-arch image keyless and verifies it against this workflow's identity", () => {
    const sign = jobs.publish.steps.find((s) => s.run?.includes("cosign sign --yes"));
    expect(sign?.run).toContain('cosign sign --yes "$REPOSITORY@$DIGEST"');
    expect(sign?.run).toContain('--certificate-identity "$IDENTITY"');
    expect(sign?.run).toContain(
      "--certificate-oidc-issuer https://token.actions.githubusercontent.com",
    );
    expect(sign?.env?.IDENTITY).toBe("https://github.com/${{ github.workflow_ref }}");
    const installer = jobs.publish.steps.find((s) =>
      s.uses?.startsWith("sigstore/cosign-installer@"),
    );
    expect(installer?.with?.["cosign-release"]).toBe("v2.6.5");
  });

  it("copies to ECR Public only when the repository is set up for it", () => {
    const mirror = jobs.publish.steps.filter((s) =>
      /ecr-public|configure-aws-credentials/.test(`${s.run ?? ""}${s.uses ?? ""}`),
    );
    expect(mirror.length).toBe(2);
    for (const s of mirror)
      expect(s.if).toBe("env.ECR_PUBLIC_REGISTRY != '' && env.AWS_RELEASE_ROLE_ARN != ''");
  });

  it("builds with the pinned BuildKit, and gates on the image scan's baseline", () => {
    expect(releaseText).toMatch(/BUILDKIT_IMAGE: moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}/);
    const scanText = readFileSync(".github/workflows/image-scan.yml", "utf8");
    const grype = (t: string) => /anchore\/grype:(v[\d.]+)/.exec(t)?.[1];
    expect(grype(releaseText)).toBe(grype(scanText));
    expect(releaseText).toContain("/baseline.yaml");
  });

  it("writes the release from the CHANGELOG, after every image is published", () => {
    expect(jobs.release.needs).toEqual(["plan", "publish"]);
    const runs = jobs.release.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain('node scripts/release.mjs notes "$VERSION" --released released');
    expect(runs).toContain('gh release create "v$VERSION"');
    expect(allSteps.some((s) => s.run?.includes("node scripts/release.mjs plan"))).toBe(true);
  });
});
