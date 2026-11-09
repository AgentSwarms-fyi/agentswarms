// R463: the pieces behind a load balancer, and the one egress rule that
// protects the metadata service, held in place.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** The squid rules from the Compose file and from the Kubernetes ConfigMap copy. */
function squidCopies(): [string, string][] {
  const k8s = read("deploy/k8s/notebooks/notebook-runtime.yaml");
  const conf = k8s.slice(k8s.indexOf("squid.conf: |"), k8s.indexOf("allowed_domains: |"));
  return [
    ["deploy/notebooks/egress/squid.conf", read("deploy/notebooks/egress/squid.conf")],
    ["deploy/k8s/notebooks/notebook-runtime.yaml", conf],
  ];
}

describe("squid refuses loopback and link-local before anything is allowed", () => {
  for (const [where, conf] of squidCopies()) {
    it(`${where}: the metadata range is refused, whatever an allowed domain resolves to`, () => {
      const acl = conf.match(/acl blocked_dst dst ([^\n]+)/)?.[1] ?? "";
      for (const range of ["127.0.0.0/8", "169.254.0.0/16", "::1", "fe80::/10"]) {
        expect(acl, range).toContain(range);
      }
      const deny = conf.indexOf("http_access deny blocked_dst");
      expect(deny).toBeGreaterThan(-1);
      expect(deny).toBeLessThan(conf.indexOf("http_access allow allowed_domains"));
      expect(deny).toBeLessThan(conf.indexOf("http_access allow allowed_ips"));
    });

    it(`${where}: a LAN object store (192.168/16, 10/8) is NOT refused — that is the self-hosted case`, () => {
      const acl = conf.match(/acl blocked_dst dst ([^\n]+)/)?.[1] ?? "";
      expect(acl).not.toMatch(/192\.168|10\.0\.0\.0|172\.16/);
    });
  }
});

describe("the notebook gateway behind a load balancer", () => {
  const gw = read("services/notebook-gateway/index.mjs");

  it("keeps idle sockets longer than the balancer, like the app", () => {
    expect(gw).toContain("server.keepAliveTimeout = KEEPALIVE_MS;");
    expect(gw).toContain("server.headersTimeout = KEEPALIVE_MS + 5_000;");
    expect(gw).toMatch(/HTTP_KEEPALIVE_TIMEOUT_MS\) \|\| 75_000/);
  });

  it("pings every socket and ends the ones that stopped answering", () => {
    expect(gw).toMatch(/ws\.isAlive === false\)\s*\{\s*ws\.terminate\(\)/);
    expect(gw).toContain('browser.on("pong"');
  });

  it("closes notebooks with 1012 on SIGTERM instead of dying under them", () => {
    expect(gw).toContain('ws.close(1012, "gateway restarting")');
    expect(gw).toMatch(/for \(const signal of \["SIGTERM", "SIGINT"\]\)/);
  });
});

describe("Compose gives the app time to drain", () => {
  it("stop_grace_period exceeds the 25 s drain, which exceeds Compose's 10 s default", () => {
    const compose = read("docker-compose.yml");
    const app = compose.slice(
      compose.indexOf("  agentswarms:"),
      compose.indexOf("  notebook-gateway:"),
    );
    const grace = Number(app.match(/stop_grace_period: (\d+)s/)?.[1]);
    expect(grace).toBeGreaterThan(25);
  });

  it("and the Kubernetes pod's grace period does too", () => {
    const k8s = read("deploy/k8s/app/agentswarms.yaml");
    const graces = [...k8s.matchAll(/terminationGracePeriodSeconds: (\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(graces.length).toBeGreaterThan(0);
    for (const g of graces) expect(g).toBeGreaterThan(25);
  });
});
