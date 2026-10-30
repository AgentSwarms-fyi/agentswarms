// Moving the Qdrant pin, and the volume it has to carry (VA-2026-10-25-38, R416).
//
// Qdrant opens storage from the previous minor release only. The pin moved
// from v1.12.4 to v1.20.0, eight minors, so an existing install's volume has
// to be opened by every release in between, in order. These pin the plan the
// upgrade script follows, and the path it follows it along.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MARKER_FILE,
  parseQdrantVersion,
  planQdrantSteps,
  QDRANT_PATH,
  ranCleanly,
  storedRelease,
} from "../../scripts/lib/qdrant-upgrade.mjs";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const v = (s: string) => parseQdrantVersion(s)!;
const pinIn = (file: string) => {
  const m = /image:\s*(qdrant\/qdrant:\S+)/.exec(rd(file));
  expect(m, `${file} pins no qdrant image`).toBeTruthy();
  return m![1];
};

describe("reading a Qdrant version", () => {
  it("reads a release, a tag and an image reference", () => {
    expect(parseQdrantVersion("1.12.4")).toEqual({ major: 1, minor: 12, patch: 4 });
    expect(parseQdrantVersion("v1.20.0")).toEqual({ major: 1, minor: 20, patch: 0 });
    expect(parseQdrantVersion(QDRANT_PATH[0])).toEqual({ major: 1, minor: 13, patch: 6 });
    expect(parseQdrantVersion("qdrant/qdrant:v1.12.4")).toEqual({ major: 1, minor: 12, patch: 4 });
  });

  it("reads nothing from text that names no release", () => {
    for (const junk of ["", "latest", "qdrant/qdrant:latest", "1.12", "dev", undefined]) {
      expect(parseQdrantVersion(junk as string)).toBeNull();
    }
  });
});

describe("the plan from one release to another", () => {
  it("runs every minor in between, in order, and not the target itself", () => {
    const plan = planQdrantSteps(v("1.12.4"), v("1.20.0"));
    expect(plan.error).toBeUndefined();
    expect(plan.steps!.map((s: string) => parseQdrantVersion(s)!.minor)).toEqual([
      13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  it("does nothing where the target opens the volume itself", () => {
    expect(planQdrantSteps(v("1.19.2"), v("1.20.0"))).toEqual({ steps: [] });
    expect(planQdrantSteps(v("1.20.0"), v("1.20.0"))).toEqual({ steps: [] });
    expect(planQdrantSteps(v("1.20.0"), v("1.20.3"))).toEqual({ steps: [] });
  });

  it("refuses a volume newer than the pin rather than run an older Qdrant on it", () => {
    expect(planQdrantSteps(v("1.21.0"), v("1.20.0")).error).toMatch(
      /newer than the pinned 1\.20\.0/,
    );
    expect(planQdrantSteps(v("1.20.2"), v("1.20.0")).error).toMatch(/newer/);
  });

  it("refuses a major release and a minor the path does not have", () => {
    expect(planQdrantSteps(v("1.20.0"), v("2.0.0")).error).toMatch(/major/);
    const gap = QDRANT_PATH.filter((ref) => parseQdrantVersion(ref)!.minor !== 15);
    expect(planQdrantSteps(v("1.12.4"), v("1.20.0"), gap).error).toMatch(/no 1\.15 release/);
  });

  it("refuses to guess when a version is unknown", () => {
    expect(planQdrantSteps(null, v("1.20.0")).error).toMatch(/could not be read/);
  });
});

describe("which release the volume is at", () => {
  const ok = (image: string, extra = {}) => ({
    id: "c1",
    image,
    running: true,
    restarting: false,
    exitCode: 0,
    health: "healthy",
    ...extra,
  });

  it("does not take a crash loop for a release that opened it", () => {
    // 1.20.0 on a 1.12.4 volume panics, exits 101, and is started again.
    expect(ranCleanly(ok("q:v1.20.0", { running: false, restarting: true, exitCode: 101 }))).toBe(
      false,
    );
    expect(ranCleanly(ok("q:v1.20.0", { running: false, exitCode: 101 }))).toBe(false);
    expect(ranCleanly(ok("q:v1.20.0", { health: "starting" }))).toBe(false);
    expect(ranCleanly(ok("q:v1.20.0", { health: "unhealthy" }))).toBe(false);
    // Running and healthy, or stopped the way Qdrant stops.
    expect(ranCleanly(ok("q:v1.12.4"))).toBe(true);
    expect(ranCleanly(ok("q:v1.12.4", { running: false, exitCode: 143, health: "" }))).toBe(true);
    expect(ranCleanly(ok("q:v1.12.4", { running: false, exitCode: 0, health: "" }))).toBe(true);
  });

  it("takes the newest of the marker and the clean containers", () => {
    // The compose container still names 1.12.4 after a run that stopped at
    // 1.16: running 1.13 again on that volume would be a downgrade.
    const halfway = storedRelease({
      marker: "1.16.3",
      containers: [ok("qdrant/qdrant:v1.12.4", { running: false, exitCode: 143 })],
    });
    expect(halfway.from).toEqual({ major: 1, minor: 16, patch: 3 });
    expect(halfway.source).toContain(MARKER_FILE);
    // A stale marker loses to the healthy Qdrant that has opened it since.
    expect(
      storedRelease({ marker: "1.19.2", containers: [ok("qdrant/qdrant:v1.20.0")] }).from?.minor,
    ).toBe(20);
    // A crash loop counts for nothing.
    expect(
      storedRelease({
        marker: null,
        containers: [
          ok("qdrant/qdrant:v1.20.0", { running: false, restarting: true, exitCode: 101 }),
        ],
      }),
    ).toEqual({ from: null });
  });

  it("lets the operator say, and refuses a statement that names nothing", () => {
    expect(
      storedRelease({
        stated: "1.12.4",
        marker: "1.19.2",
        containers: [ok("qdrant/qdrant:v1.20.0")],
      }).from,
    ).toEqual({ major: 1, minor: 12, patch: 4 });
    expect(storedRelease({ stated: "old", marker: null, containers: [] }).error).toMatch(
      /names no release/,
    );
  });
});

describe("the path and the pins", () => {
  it("pins every step by digest, one per minor, with no gap", () => {
    const minors = QDRANT_PATH.map((ref) => {
      expect(ref).toMatch(/^qdrant\/qdrant:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
      return parseQdrantVersion(ref)!.minor;
    });
    expect(minors[0]).toBe(13);
    minors.forEach((m, i) => expect(m).toBe(13 + i));
  });

  it("runs the same Qdrant on Compose and on Kubernetes", () => {
    expect(pinIn("deploy/k8s/app/services.yaml")).toBe(pinIn("docker-compose.yml"));
  });

  it("drops the v1.12.4 rules from the image scan's baseline with the pin", () => {
    // The baseline excused v1.12.4's criticals until this moved the pin. A
    // rule left behind would excuse the same package version anywhere else.
    expect(rd(".github/grype-baseline.yaml")).not.toMatch(/qdrant/i);
  });

  it("can carry a volume from the release this repository shipped before, to the pin", () => {
    // v1.12.4 was the pin until R416, so that is the oldest volume an install
    // can have. A Dependabot bump to a new minor fails here until the minor it
    // leaves is on the path.
    const pin = v(pinIn("docker-compose.yml"));
    expect(planQdrantSteps(v("1.12.4"), pin).error).toBeUndefined();
  });
});

describe("the upgrade runs before Compose starts the new pin", () => {
  const sh = rd("scripts/setup.sh");
  const ps = rd("scripts/setup.ps1");

  it("is run by both installers, before `docker compose up`, and stops them when it fails", () => {
    // After `up`, the pin has already opened (or failed to open) the volume.
    expect(sh.indexOf("node scripts/upgrade-qdrant.mjs")).toBeGreaterThan(0);
    expect(sh.indexOf("node scripts/upgrade-qdrant.mjs")).toBeLessThan(
      sh.indexOf("docker compose up -d --build"),
    );
    expect(sh).toMatch(/node scripts\/upgrade-qdrant\.mjs \|\| die /);
    expect(ps.indexOf("node scripts/upgrade-qdrant.mjs")).toBeGreaterThan(0);
    expect(ps.indexOf("node scripts/upgrade-qdrant.mjs")).toBeLessThan(
      ps.indexOf("docker compose up -d --build"),
    );
    expect(ps).toMatch(/node scripts\/upgrade-qdrant\.mjs\r?\nif \(\$LASTEXITCODE -ne 0\) \{ Die /);
  });

  describe("the script", () => {
    const cli = rd("scripts/upgrade-qdrant.mjs");

    it("reads the project, the pin and the volume from Compose itself", () => {
      expect(cli).toContain('["compose", "config", "--format", "json"]');
      expect(cli).toMatch(/cfg\.volumes\?\.\[mount\.source\]\?\.name/);
    });

    it("stops whatever has the volume before starting a release on it, a crash loop included", () => {
      const flow = cli.slice(cli.indexOf("async function compose()"));
      expect(flow.indexOf("stopAll(containers);")).toBeGreaterThan(0);
      expect(flow.indexOf("stopAll(containers);")).toBeLessThan(
        flow.indexOf("await openWith(q, q.image)"),
      );
      expect(flow.indexOf("stopAll(containersOn(q.volume));")).toBeLessThan(
        flow.indexOf("await openWith(q, image)"),
      );
      expect(cli).toMatch(
        /const live = containers\.filter\(\(c\) => c\.running \|\| c\.restarting\)/,
      );
    });

    it("runs each release unreachable, records it only once it loaded, and deletes nothing", () => {
      // A release starts without the service's API key: --network none is what
      // keeps it from being an open Qdrant while it loads.
      expect(cli).toMatch(/docker\(\["run", "-d", "--name", name, "--network", "none"/);
      const open = cli.slice(
        cli.indexOf("async function openWith"),
        cli.indexOf("function stopAll"),
      );
      expect(open.indexOf("if (!ready.ok)")).toBeLessThan(open.indexOf("markerWrite("));
      expect(cli).not.toMatch(/"volume", "rm"|"rm", "-v"|"-fv"|"prune"/);
    });

    it("stops a release only once every collection is green, nudging a grey one", () => {
      // Measured: 1.15.5 answered /readyz with both collections grey,
      // optimizations pending and not running. /readyz alone is not "done".
      const settle = cli.slice(
        cli.indexOf("async function waitSettled"),
        cli.indexOf("/** Compose's own view"),
      );
      expect(settle).toMatch(
        /waiting = states\.filter\(\(\[, s\]\) => s !== "green"\);\s*if \(waiting\.length === 0\) return \{ ok: true \};/,
      );
      expect(settle).toMatch(
        /if \(s === "grey"\) \{\s*http\(name, "PATCH", `\/collections\/\$\{coll\}`, JSON\.stringify\(\{ optimizers_config: \{\} \}\)\);/,
      );
      expect(settle).toMatch(/s === "red"/);
      // And the only exits it builds on are Qdrant's own stops, not a SIGKILL.
      expect(cli).toMatch(/if \(code !== "0" && code !== "143"\) return \{ ok: false/);
    });

    it("tries the pin first when no healthy Qdrant vouches, and asks rather than guess", () => {
      expect(cli).toMatch(/if \(!vouched && !stated\) \{/);
      expect(cli).toMatch(/nothing on it says ` \+\s*`which release last did/);
      expect(cli).toContain("QDRANT_FROM=${LAST_PIN_BEFORE_R416} node scripts/upgrade-qdrant.mjs");
      expect(cli).toMatch(/Number\(process\.env\.QDRANT_UPGRADE_TIMEOUT_S\) \|\| 1800/);
    });
  });
});

describe("a volume that skipped the upgrade", () => {
  it("is named on Monitoring, where `docker compose up -d` only restarts the crash", async () => {
    // Measured: 1.20.0 on a 1.12.4 volume panics ("unknown variant `on_disk`")
    // and exits 101, so the service restarts for ever.
    const { DOWN_HINTS } = await import("@/lib/serviceHealth");
    expect(DOWN_HINTS.qdrant).toContain("node scripts/upgrade-qdrant.mjs");
    expect(DOWN_HINTS.qdrant).toMatch(/keyword search/);
    const fns = rd("src/utils/monitoring.functions.ts");
    expect(fns).toMatch(/status: "down",[\s\S]{0,400}DOWN_HINTS\[entry\.id\]/);
  });
});
