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

const tone = (status: ServiceStatus, optional: boolean) => statusTone({ status, optional });

describe("statusTone", () => {
  it("does NOT raise an alarm for an optional service that was never started", () => {
    // A red "Down" on a profile the operator chose not to enable is how a
    // status page teaches people to ignore it.
    const t = tone("down", true);
    expect(t.tone).toBe("muted");
    expect(t.label).toBe("Not running");
  });

  it("DOES raise an alarm when a required service is down", () => {
    const t = tone("down", false);
    expect(t.tone).toBe("critical");
    expect(t.label).toBe("Down");
  });

  it("flags a degraded service regardless of whether it is optional", () => {
    expect(tone("degraded", true).tone).toBe("warn");
    expect(tone("degraded", false).tone).toBe("warn");
  });

  it("marks a healthy service green either way", () => {
    expect(tone("up", true).tone).toBe("ok");
    expect(tone("up", false).tone).toBe("ok");
  });
});

describe("unreachable is not the same as down", () => {
  it("reads as an honest 'can't check' rather than a failure", () => {
    // Found live: the egress proxy publishes no host port, so an app running
    // outside Compose cannot probe it — and reported it as DOWN while it was
    // running perfectly. One false row is enough to make the whole page
    // untrustworthy.
    const t = tone("unreachable", true);
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
  it("covers every optional container service in docker-compose", () => {
    const compose = readFileSync(resolve("docker-compose.yml"), "utf-8");
    // Services declared with a profile are the optional ones an operator can
    // forget to start — exactly what this page exists to report on.
    // Split into service blocks FIRST. A single multi-line regex happily ran
    // from one service's name to a LATER service's `profiles:` line, which
    // made the always-on `agentswarms` service look optional.
    const servicesSection = compose.slice(
      compose.indexOf("\nservices:"),
      compose.indexOf("\nnetworks:"),
    );
    const withProfiles = servicesSection
      .split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/)
      .map((block) => ({
        name: block.match(/^\s*([a-z][a-z0-9-]*):/)?.[1],
        optional: /\n\s+profiles: \[/.test(block),
      }))
      .filter((b) => b.name && b.optional)
      .map((b) => b.name as string);
    const monitored = new Set(SERVICE_CATALOGUE.map((s) => s.id));
    // The build-only helper never runs, so it is deliberately not monitored.
    const expected = withProfiles.filter((n) => n !== "notebook-runtime-image");
    for (const name of expected) {
      expect(monitored.has(name as never), `${name} is not in the monitoring catalogue`).toBe(true);
    }
    expect(expected.length).toBeGreaterThanOrEqual(4);
  });

  it("tries the in-network name before the published loopback port", () => {
    for (const s of SERVICE_CATALOGUE) {
      expect(s.candidates.length, `${s.id} has no candidates`).toBeGreaterThan(0);
      expect(s.candidates[0], `${s.id} probes loopback first`).not.toContain("127.0.0.1");
      expect(s.candidates.at(-1), `${s.id} has no host fallback`).toContain("127.0.0.1");
    }
  });

  it("names a real compose profile for every optional service", () => {
    // Parsed, not string-matched: a service may sit in several profiles (each
    // also carries `all`), so the bracket formatting is not the claim here.
    const compose = yaml.load(readFileSync(resolve("docker-compose.yml"), "utf-8")) as {
      services: Record<string, { profiles?: string[] }>;
    };
    const declared = new Set(Object.values(compose.services).flatMap((s) => s.profiles ?? []));
    for (const s of SERVICE_CATALOGUE) {
      if (!s.optional) continue;
      expect(s.profile, `${s.id} has no profile`).toBeTruthy();
      expect([...declared], `profile ${s.profile} is not in compose`).toContain(s.profile);
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
