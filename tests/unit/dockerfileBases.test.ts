// R406 (VA-2026-10-25-25): the five images this repository builds start from
// a base pinned by digest, Dependabot proposes the next digest, and the Node
// images drop npm once the build no longer needs it. Measured before: every
// first-party image was built on a node:22-slim or python:3.12-slim pulled two
// months earlier, because a bare tag is only resolved when nothing is cached.
// R407 (VA-39) added a sixth: the Docker socket proxy, built from its upstream
// release with Alpine's security updates applied.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const compose = yaml.load(readFileSync("docker-compose.yml", "utf8")) as {
  services: Record<string, { build?: string | { context: string }; image?: string }>;
};
const contexts = Object.values(compose.services)
  .map((s) => (typeof s.build === "string" ? s.build : s.build?.context))
  .filter((c): c is string => !!c)
  .map((c) => c.replace(/^\.\//, "").replace(/\/$/, "") || ".");
const dockerfile = (ctx: string) => readFileSync(`${ctx}/Dockerfile`, "utf8");
const froms = (text: string) =>
  text
    .split("\n")
    .filter((l) => /^FROM\s/i.test(l))
    .map((l) => l.split(/\s+/)[1]);

describe("first-party image bases", () => {
  it("covers the six images compose builds", () => {
    expect(contexts.sort()).toEqual(
      [
        ".",
        "docgen-service",
        "docker/notebook-runtime",
        "docker/socket-proxy",
        "services/js-sandbox",
        "services/notebook-gateway",
      ].sort(),
    );
  });

  it("pins every FROM as tag@sha256, one digest per base across the Dockerfiles", () => {
    const byTag = new Map<string, Set<string>>();
    for (const ctx of contexts) {
      for (const ref of froms(dockerfile(ctx))) {
        expect(ref, `${ctx}/Dockerfile`).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
        const [tag, digest] = ref.split("@");
        byTag.set(tag, (byTag.get(tag) ?? new Set()).add(digest));
      }
    }
    for (const [tag, digests] of byTag) expect(digests.size, tag).toBe(1);
  });

  it("has Dependabot propose the next digest for each of them", () => {
    const cfg = yaml.load(readFileSync(".github/dependabot.yml", "utf8")) as {
      updates: { "package-ecosystem": string; directories?: string[]; directory?: string }[];
    };
    const dirs = cfg.updates
      .filter((u) => u["package-ecosystem"] === "docker")
      .flatMap((u) => u.directories ?? [u.directory ?? ""]);
    for (const ctx of contexts) expect(dirs, ctx).toContain(ctx === "." ? "/" : `/${ctx}`);
  });

  it("removes npm from the Node images after its last use and before dropping root", () => {
    for (const ctx of [".", "services/notebook-gateway", "services/js-sandbox"]) {
      const lines = dockerfile(ctx).split("\n");
      const rm = lines.findIndex((l) =>
        /^RUN rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx$/.test(
          l,
        ),
      );
      const user = lines.findIndex((l) => /^USER\s/.test(l));
      const lastNpm = lines.reduce(
        (at, l, i) => (/^RUN\s.*\bnpm\b/.test(l) && i !== rm ? i : at),
        -1,
      );
      expect(rm, `${ctx}: npm removed`).toBeGreaterThan(-1);
      expect(rm, `${ctx}: after the last npm step`).toBeGreaterThan(lastNpm);
      expect(rm, `${ctx}: while still root`).toBeLessThan(user);
      expect(
        lines.slice(rm + 1).some((l) => /^(RUN|CMD|ENTRYPOINT)\b.*\bnp[mx]\b/.test(l)),
        ctx,
      ).toBe(false);
    }
  });

  it("upgrades the base's pip to 26.2 or later before installing the requirements", () => {
    // python:3.12-slim ships pip 25.0.1; grype found six advisories in it, all
    // fixed by 26.2 (R406). Kernels run `pip install` on this pip at run time.
    for (const ctx of ["docgen-service", "docker/notebook-runtime"]) {
      const lines = dockerfile(ctx).split("\n");
      const up = lines.findIndex((l) => /^RUN pip install .*--upgrade "pip>=([\d.]+)"$/.test(l));
      const req = lines.findIndex((l) => /^RUN pip install .*-r requirements\.txt/.test(l));
      expect(up, `${ctx}: pip upgraded`).toBeGreaterThan(-1);
      const floor = /"pip>=([\d.]+)"/.exec(lines[up])![1].split(".").map(Number);
      expect(floor[0] * 100 + (floor[1] ?? 0), `${ctx}: floor`).toBeGreaterThanOrEqual(2602);
      expect(up, `${ctx}: before the requirements`).toBeLessThan(req);
    }
  });

  it("applies Alpine's security updates on top of the socket proxy's release", () => {
    // v0.5.0 as published still had OpenSSL 3.5.7 (4 fixable criticals);
    // `apk upgrade` at build time is what brings it to the fixed release.
    const lines = dockerfile("docker/socket-proxy")
      .split("\n")
      .filter((l) => /^[A-Z]+\s/.test(l));
    expect(lines).toEqual([
      expect.stringMatching(/^FROM tecnativa\/docker-socket-proxy:v[\d.]+@sha256:[0-9a-f]{64}$/),
      "RUN apk upgrade --no-cache",
    ]);
    const service = compose.services["notebook-docker-proxy"];
    expect(service.image).toBe("agentswarms/docker-socket-proxy:latest");
  });

  it("has scan.sh scan every image compose builds, and every base", () => {
    const scanSh = readFileSync("docs/security/scripts/scan.sh", "utf8");
    const basesLine = /^ {2}BASES=.*$/m.exec(scanSh)![0];
    for (const ctx of contexts) {
      expect(basesLine, ctx).toContain(ctx === "." ? " Dockerfile " : ` ${ctx}/Dockerfile`);
    }
    const images = /^ {2}IMAGES="([^"]*)"/m.exec(scanSh)![1].split(/\s+/).filter(Boolean);
    for (const [name, s] of Object.entries(compose.services)) {
      if (s.build && s.image) expect(images, name).toContain(s.image);
    }
  });
});
