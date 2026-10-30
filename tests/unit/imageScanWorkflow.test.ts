// VA-2026-10-25-25: the images the stack runs are scanned for CVEs in CI, on a
// schedule, because they collect CVEs with no change to this repository. The
// assessment could not run grype locally (its database download stalls inside
// Docker Desktop), so CI is where the scan lives; this keeps it in step with
// the compose file and the local script.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const raw = readFileSync(".github/workflows/image-scan.yml", "utf8");
const wf = yaml.load(raw) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, { strategy?: { matrix: { include: { name: string; context: string }[] } } }>;
};
const compose = yaml.load(readFileSync("docker-compose.yml", "utf8")) as {
  services: Record<string, { build?: string | { context: string } }>;
};
const scanSh = readFileSync("docs/security/scripts/scan.sh", "utf8");

const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/$/, "") || ".";

describe("the image scan workflow", () => {
  it("runs weekly and on demand, not only when the code changes", () => {
    expect(wf.on).toHaveProperty("schedule");
    expect(wf.on).toHaveProperty("workflow_dispatch");
  });

  it("builds and scans every image the compose file builds", () => {
    const built = Object.values(compose.services)
      .map((s) => (typeof s.build === "string" ? s.build : s.build?.context))
      .filter((c): c is string => !!c)
      .map(norm)
      .sort();
    const scanned = wf.jobs["first-party"]
      .strategy!.matrix.include.map((m) => norm(m.context))
      .sort();
    expect(scanned).toEqual(built);
  });

  it("uses the same pinned grype as the local scan script", () => {
    const local = /GRYPE_IMAGE="\$\{GRYPE_IMAGE:-([^}]+)\}"/.exec(scanSh)![1];
    expect(local).toMatch(/^anchore\/grype:v\d+\.\d+\.\d+$/);
    expect(wf.env.GRYPE).toContain(local);
    expect(wf.env.GRYPE_GATE).toContain(local);
  });

  it("fails on a fixable critical in both jobs, and reads the third-party list from compose", () => {
    expect(raw.match(/\$GRYPE_GATE [^\n]* --only-fixed --fail-on critical/g)).toHaveLength(2);
    expect(raw.match(/--fail-on/g)).toHaveLength(2);
    expect(raw).toContain("--compose-images docker-compose.yml");
  });

  it("skips only the baseline's findings, each pinned to a package version and a reason", () => {
    // R406: the third-party images carry fixable criticals that are not ours
    // to fix yet (qdrant, the socket proxy, Spark's jars). Without a baseline
    // the weekly scan would be red from its first run and stay red.
    expect(wf.env.GRYPE_GATE).toMatch(
      /grype-baseline\.yaml:\/baseline\.yaml:ro .* -c \/baseline\.yaml$/,
    );
    expect(wf.env.GRYPE).not.toContain("baseline");
    expect((wf.on.push as { paths: string[] }).paths).toContain(".github/grype-baseline.yaml");
    const baseline = yaml.load(readFileSync(".github/grype-baseline.yaml", "utf8")) as {
      ignore: { vulnerability: string; reason: string; package: Record<string, string> }[];
    };
    expect(baseline.ignore.length).toBeGreaterThan(0);
    for (const rule of baseline.ignore) {
      expect(Object.keys(rule).sort(), rule.vulnerability).toEqual([
        "package",
        "reason",
        "vulnerability",
      ]);
      expect(Object.keys(rule.package).sort(), rule.vulnerability).toEqual(["name", "version"]);
      expect(rule.package.version, rule.vulnerability).toMatch(/\S/);
      expect(rule.reason, rule.vulnerability).toMatch(/VA-2026-\d\d-\d\d-\d+/);
    }
  });

  it("needs no secrets and cannot write to the repository", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(raw).not.toMatch(/secrets\./);
    expect(raw).not.toMatch(/docker (push|login)/);
  });

  it("lists third-party images the way scan.sh does: every image line not built here", () => {
    const helper = readFileSync(".github/scripts/grype-summary.py", "utf8");
    expect(helper).toContain('startswith("agentswarms/")');
    expect(scanSh).toContain("grep -v '^agentswarms/'");
  });
});
