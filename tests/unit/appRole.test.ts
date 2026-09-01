// The analytics-only node role.
//
// WHY IT EXISTS: a heavy lakehouse query and a page render share one Node
// process, so an analytical workload can stall interactive traffic. The
// mitigation was documented prose — "run separate replicas and keep them out of
// the request path" — with nothing in the product to make it true. This is the
// mechanism: readiness routes traffic, liveness decides restarts, and an
// analytics node deliberately disagrees between the two.
//
// The contract these lock down is the dangerous kind to get wrong in either
// direction. Fail open (a typo pulls a node out of rotation) and capacity
// vanishes silently; fail closed (analytics nodes still report ready) and the
// feature does nothing while claiming to work.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ANALYTICS_ROLE, parseAppRole } from "@/utils/appRole";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("parseAppRole", () => {
  it("recognises the analytics role in the forms people type", () => {
    for (const raw of ["analytics", "ANALYTICS", " Analytics ", "analytics\n"]) {
      expect(parseAppRole(raw), JSON.stringify(raw)).toBe("analytics");
    }
  });

  it("treats anything unrecognised as a normal web node", () => {
    // A typo must not quietly remove a node from the load balancer: the symptom
    // would be missing capacity with a healthy-looking process, which is about
    // the worst failure signature available.
    for (const raw of ["analytic", "analytics-only", "web", "", "  ", undefined, null, "1"]) {
      expect(parseAppRole(raw), JSON.stringify(raw)).toBe("web");
    }
  });
});

describe("readiness declines traffic while liveness keeps the node alive", () => {
  const ready = read("src/routes/api/health.ready.ts");
  const health = read("src/routes/api/health.ts");

  it("readiness returns 503 for an analytics node", () => {
    expect(ready).toContain("analyticsNotReady");
    expect(ready).toContain("status: 503");
    // Both verbs — an LB configured for HEAD probes must see the same answer.
    expect(ready.match(/appRole\(\) === "analytics"/g)?.length).toBe(2);
  });

  it("skips the database probe on a node nobody routes to", () => {
    // Postgres is the fleet's real ceiling; probing it every few seconds from a
    // node whose answer is fixed spends the scarcest resource on nothing.
    const gate = ready.indexOf('if (appRole() === "analytics") return analyticsNotReady();');
    const dbCall = ready.indexOf("await dbReachable()");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(dbCall);
  });

  it("liveness stays 200 and reports the role", () => {
    // If liveness failed too, Kubernetes would restart the node in a loop
    // instead of leaving it to do the analytical work it exists for.
    expect(health).toContain("status: 200");
    expect(health).toContain("role: appRole()");
    expect(health).not.toContain("503");
  });
});

describe("an analytics node does not fork", () => {
  it("defaults to a single worker so the memory limit is not divided", () => {
    // The lakehouse engine is per PROCESS. Eight workers on an analytics node
    // sized for LAKEHOUSE_MEMORY_LIMIT=64GB is 512 GB of intent, and each copy
    // may claim the full figure.
    const server = read("server.mjs");
    expect(server).toContain('(process.env.APP_ROLE ?? "").trim().toLowerCase() === "analytics"');
    // WEB_CONCURRENCY must still win — an operator who asks for N gets N.
    expect(server.indexOf("WEB_CONCURRENCY")).toBeLessThan(server.indexOf("APP_ROLE"));
  });

  it("uses the same literal the app parses", () => {
    // server.mjs cannot import the TS module, so this is the seam where the two
    // could drift into a mode that half-applies: no traffic but eight engines.
    expect(ANALYTICS_ROLE).toBe("analytics");
    expect(read("server.mjs")).toContain(`=== "${ANALYTICS_ROLE}"`);
  });
});
