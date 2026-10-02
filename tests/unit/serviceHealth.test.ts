// Monitoring page rules.
//
// The value of a status page is entirely in whether people trust it, so the
// two ways it could lie are pinned here: calling a deliberately-disabled
// optional service an incident, and reporting the host's RAM as the budget
// when the container will be killed at a much lower limit.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatUptime,
  pct,
  SERVICE_CATALOGUE,
  statusTone,
  utilisationTone,
  type ServiceStatus,
} from "@/lib/serviceHealth";

const tone = (status: ServiceStatus) => statusTone({ status });

describe("statusTone", () => {
  it("calls a service that is not answering DOWN, because every service ships", () => {
    // It used to read "Not running" in grey for anything behind a compose
    // profile, which was right when a service could legitimately never have
    // been started. There are no profiles now: grey there would make a real
    // outage look deliberate.
    const t = tone("down");
    expect(t.tone).toBe("critical");
    expect(t.label).toBe("Down");
  });

  it("flags a degraded service", () => {
    expect(tone("degraded").tone).toBe("warn");
  });

  it("marks a healthy service green", () => {
    expect(tone("up").tone).toBe("ok");
  });
});

describe("unreachable is not the same as down", () => {
  it("reads as an honest 'can't check' rather than a failure", () => {
    // Found live: the egress proxy publishes no host port, so an app running
    // outside Compose cannot probe it — and reported it as DOWN while it was
    // running perfectly. One false row is enough to make the whole page
    // untrustworthy.
    const t = tone("unreachable");
    expect(t.tone).toBe("muted");
    expect(t.label).toMatch(/can.t check/i);
  });

  it("services with no published host port are marked as such in the catalogue", () => {
    const compose = readFileSync(resolve("docker-compose.yml"), "utf-8");
    for (const svc of SERVICE_CATALOGUE) {
      const start = compose.indexOf(`  ${svc.id}:`);
      expect(start, `${svc.id} missing from compose`).toBeGreaterThan(-1);
      const nextSvc = compose.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
      const block = compose.slice(start, nextSvc > -1 ? start + 1 + nextSvc : undefined);
      // "ports:" is what publishes to the host; "expose:" is in-network only.
      const publishes = /\n\s+ports:/.test(block);
      expect(svc.hostPublished, `${svc.id}: hostPublished should be ${publishes}`).toBe(publishes);
    }
  });
});

describe("utilisationTone thresholds", () => {
  it("is ok below 75, warn from 75, critical from 90", () => {
    expect(utilisationTone(0)).toBe("ok");
    expect(utilisationTone(74.9)).toBe("ok");
    expect(utilisationTone(75)).toBe("warn");
    expect(utilisationTone(89.9)).toBe("warn");
    expect(utilisationTone(90)).toBe("critical");
    expect(utilisationTone(100)).toBe("critical");
  });
});

describe("pct", () => {
  it("clamps to 0–100 and survives a zero total", () => {
    expect(pct(50, 200)).toBe(25);
    expect(pct(0, 0)).toBe(0);
    expect(pct(500, 100)).toBe(100);
    expect(pct(-5, 100)).toBe(0);
  });
});

describe("formatBytes", () => {
  it("scales units and refuses to invent a number", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("formatUptime", () => {
  it("reads in the largest useful unit", () => {
    expect(formatUptime(45)).toBe("0m");
    expect(formatUptime(3 * 60)).toBe("3m");
    expect(formatUptime(2 * 3600 + 5 * 60)).toBe("2h 5m");
    expect(formatUptime(26 * 3600)).toBe("1d 2h");
    expect(formatUptime(-10)).toBe("0m");
  });
});

describe("service catalogue", () => {
  it("covers every container service in docker-compose", () => {
    // Every service starts with every install, so the status page must be able
    // to speak about all of them: a service nobody can see the state of is one
    // whose outage is found by a user instead.
    const compose = yaml.load(readFileSync(resolve("docker-compose.yml"), "utf-8")) as {
      services: Record<string, unknown>;
    };
    // Two helpers never run: one builds the kernel image, one creates the
    // bucket and exits. Nothing to monitor.
    const ONE_SHOT = new Set(["notebook-runtime-image", "minio-init"]);
    // The app probes itself under "app", not its compose name.
    const SELF = new Set(["agentswarms"]);
    const expected = Object.keys(compose.services).filter((n) => !ONE_SHOT.has(n) && !SELF.has(n));
    const monitored = new Set(SERVICE_CATALOGUE.map((s) => s.id));
    for (const name of expected) {
      expect(monitored.has(name as never), `${name} is not in the monitoring catalogue`).toBe(true);
    }
    expect(expected.length).toBeGreaterThanOrEqual(9);
  });

  it("tries the in-network name before the published loopback port", () => {
    for (const s of SERVICE_CATALOGUE) {
      expect(s.candidates.length, `${s.id} has no candidates`).toBeGreaterThan(0);
      expect(s.candidates[0], `${s.id} probes loopback first`).not.toContain("127.0.0.1");
      expect(s.candidates.at(-1), `${s.id} has no host fallback`).toContain("127.0.0.1");
    }
  });

  it("knows which services publish a host port, so a host-run app is not lied to", () => {
    // `hostPublished: false` is what produces "Can't check from here" instead
    // of a false "down" when the app runs outside the compose network. Every
    // service publishes on loopback now for --dev, so the flag has to match
    // the compose file rather than the memory of when it did not.
    const compose = yaml.load(readFileSync(resolve("docker-compose.yml"), "utf-8")) as {
      services: Record<string, { ports?: string[] }>;
    };
    for (const s of SERVICE_CATALOGUE) {
      const svc = compose.services[s.id];
      if (!svc) continue; // app and database are not compose services by that name
      const published = (svc.ports ?? []).length > 0;
      expect(s.hostPublished, `${s.id}: hostPublished should be ${published}`).toBe(published);
    }
  });
});

describe("monitoring access", () => {
  it("both server functions are superadmin-gated", () => {
    const src = readFileSync(resolve("src/utils/monitoring.functions.ts"), "utf-8");
    // Two handlers, two guards — an ungated one would expose hostnames,
    // container limits and the deployment's internal topology.
    const guards = src.match(/const guard = await requireSuperadmin\(/g) ?? [];
    const handlers = src.match(/\.handler\(/g) ?? [];
    expect(guards.length).toBe(handlers.length);
    expect(guards.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("if (!guard.ok) throw new Error(guard.error)");
  });

  it("the page renders a restriction notice instead of data for non-superadmins", () => {
    const page = readFileSync(resolve("src/routes/_authenticated/monitoring.tsx"), "utf-8");
    expect(page).toContain("useIsSuperadmin");
    expect(page).toMatch(/if \(!isSuperadmin\)/);
  });
});
