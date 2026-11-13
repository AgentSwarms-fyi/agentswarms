// R470: an install runs a published release by its version, and rolls back by
// version. Compose names every image it builds or pulls
// ${AGENTSWARMS_REGISTRY:-ghcr.io/agentswarms-fyi}/<image>:${AGENTSWARMS_VERSION:-local};
// the app says which release it is from a file its environment cannot override.
//
// Measured with a throwaway registry standing in for GHCR: AGENTSWARMS_VERSION
// pulled and ran that release, the previous one rolled back, and a version
// never published was refused by both `pull` and `up --no-build` while the
// running release stayed up.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

import { parseRelease, releaseInfo, resetReleaseInfoForTests } from "@/utils/release.server";

type Service = {
  build?: unknown;
  image?: string;
  environment?: Record<string, string>;
};
const compose = yaml.load(readFileSync("docker-compose.yml", "utf8")) as {
  services: Record<string, Service>;
};
const manifest = JSON.parse(readFileSync("deploy/release/images.json", "utf8")) as {
  images: { name: string; compose: string | null }[];
};

describe("Compose runs a release by its version", () => {
  it("names every image it builds after the release's own image, with the version as its tag", () => {
    for (const img of manifest.images.filter((i) => i.compose)) {
      const svc = compose.services[img.compose!];
      expect(svc.build, img.compose!).toBeTruthy();
      const expected = `\${AGENTSWARMS_REGISTRY:-ghcr.io/agentswarms-fyi}/${img.name}:\${AGENTSWARMS_VERSION:-local}`;
      if (img.name === "notebook-runtime") {
        // An older .env that names its own sandbox image still wins.
        expect(svc.image).toBe(`\${NOTEBOOK_RUNTIME_IMAGE:-${expected}}`);
      } else {
        expect(svc.image, img.compose!).toBe(expected);
      }
    }
  });

  it("hands the app the sandbox image Compose builds or pulls", () => {
    const app = compose.services.agentswarms;
    expect(app.environment?.NOTEBOOK_RUNTIME_IMAGE).toBe(
      compose.services["notebook-runtime-image"].image,
    );
  });

  it("names nothing under the old Docker Hub namespace nobody here owns", () => {
    const text = readFileSync("docker-compose.yml", "utf8");
    expect(text).not.toMatch(/^\s+image:\s*agentswarms\//m);
    for (const f of [
      "deploy/k8s/app/agentswarms.yaml",
      "deploy/k8s/app/services.yaml",
      "deploy/k8s/notebooks/notebook-runtime.yaml",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/image:\s*agentswarms[:/]/);
    }
    expect(readFileSync(".env.example", "utf8")).toMatch(/^NOTEBOOK_RUNTIME_IMAGE=""$/m);
    for (const f of [
      "src/utils/notebookRuntime/config.server.ts",
      "src/utils/notebookRuntimeAdmin.functions.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toContain("agentswarms/notebook-runtime:latest");
    }
  });

  it("with no version, the tag is `local`, which no release can publish, so Compose builds", async () => {
    // A release publishes <version>, <major.minor> and latest; `local` is
    // none of them, and is not a version a tag can carry.
    const { imageTags, parseVersion } = await import("../../scripts/release.mjs");
    expect(() => parseVersion("local")).toThrow();
    for (const v of ["1.7.0", "1.7.1", "2.0.0-rc.1"])
      expect(imageTags(v, ["1.7.0"])).not.toContain("local");
    expect(readFileSync(".github/workflows/release.yml", "utf8")).toContain(
      'for t in $TAGS; do tags+=(-t "$REPOSITORY:$t"); done',
    );
    expect(readFileSync(".env.example", "utf8")).toMatch(/^AGENTSWARMS_VERSION=""$/m);
  });

  it("the installers pull a release and never build it", () => {
    const sh = readFileSync("scripts/setup.sh", "utf8");
    expect(sh).toContain("docker compose pull \\");
    expect(sh).toContain("docker compose up -d --no-build ||");
    const ps = readFileSync("scripts/setup.ps1", "utf8");
    expect(ps).toContain("docker compose pull");
    expect(ps).toContain("docker compose up -d --no-build");
    const k8s = readFileSync("scripts/setup-k8s.sh", "utf8");
    expect(k8s).toContain('RELEASE_TAG="${AGENTSWARMS_VERSION:-local}"');
    expect(k8s).toMatch(
      /if \[ "\$RELEASE_TAG" = "local" \] && \[ -z "\$\{SKIP_IMAGE_CHECK:-\}" \]/,
    );
  });
});

describe("which release a server is", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetReleaseInfoForTests();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads what the image recorded", () => {
    expect(parseRelease('{"version":"1.7.0","revision":"7dfea609a1b2c3d4"}\n')).toEqual({
      version: "1.7.0",
      revision: "7dfea609a1b2c3d4",
    });
    expect(parseRelease('{"version":"1.7.0-rc.1","revision":""}')).toEqual({
      version: "1.7.0-rc.1",
      revision: null,
    });
  });

  it("calls anything it cannot trust a build from source", () => {
    for (const bad of [
      "",
      "not json",
      "{}",
      '{"version":""}',
      '{"version":"<script>"}',
      '{"version":7}',
    ]) {
      expect(parseRelease(bad).version, bad).toBe("dev");
    }
    expect(parseRelease('{"version":"1.7.0","revision":"$(rm -rf)"}').revision).toBeNull();
  });

  it("is dev where there is no file (npm run dev, a host build)", () => {
    const d = mkdtempSync(join(tmpdir(), "release-"));
    dirs.push(d);
    expect(releaseInfo(join(d, "release.json"))).toEqual({ version: "dev", revision: null });
  });

  it("reads the file once, whatever the environment says", () => {
    const d = mkdtempSync(join(tmpdir(), "release-"));
    dirs.push(d);
    const file = join(d, "release.json");
    writeFileSync(file, '{"version":"1.7.0","revision":"abcdef1"}');
    const before = process.env.AGENTSWARMS_VERSION;
    process.env.AGENTSWARMS_VERSION = "9.9.9"; // what .env says to run, not what this is
    try {
      expect(releaseInfo(file)).toEqual({ version: "1.7.0", revision: "abcdef1" });
    } finally {
      if (before === undefined) delete process.env.AGENTSWARMS_VERSION;
      else process.env.AGENTSWARMS_VERSION = before;
    }
  });

  it("Monitoring shows it, and /api/health, which anyone can call, does not", () => {
    expect(readFileSync("src/utils/monitoring.functions.ts", "utf8")).toContain("...releaseInfo()");
    const health = readFileSync("src/routes/api/health.ts", "utf8");
    expect(health).not.toMatch(/release|AGENTSWARMS_VERSION|version/i);
  });
});
