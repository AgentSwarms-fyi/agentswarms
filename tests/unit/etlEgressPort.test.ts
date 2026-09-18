// The proxy refuses ports, and it looks exactly like the endpoint refusing.
//
// Found live. A reverse-ETL target was pointed at a receiver on
// `http://echo-target.local:8099/hook`. The host was on the allow-list under
// Admin → Developer runtime, the generated `allowed_domains` file carried
// `.echo-target.local`, the pre-flight check passed — and the run failed with
//
//   requests.exceptions.HTTPError: 403 Client Error: Forbidden for url:
//   http://echo-target.local:8099/hook
//
// which reads as "the endpoint said no". It was squid: `http_access deny
// !Safe_ports`, and Safe_ports is 80, 443, 9000 and 19000. Moving the receiver
// to port 80 made the same pipeline succeed, first try, 257 rows in three
// batched requests.
//
// The allow-list covers HOSTS. Nothing in the product covered ports, so the
// one rule that could refuse a perfectly configured node was invisible until
// it fired, in a library's words, from inside a container.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EGRESS_SAFE_PORTS,
  EGRESS_SSL_PORTS,
  egressPortRefusal,
} from "@/utils/notebookRuntime/egress";

describe("the port list the app checks against", () => {
  it("is the list squid actually enforces", () => {
    // Two copies of one rule drift, and the drift is silent — the app would
    // accept a URL the proxy then refuses, which is the defect this fixes
    // wearing a different hat. Parsed from the tracked config rather than
    // restated, so editing squid.conf without editing the mirror fails here.
    const conf = readFileSync("deploy/notebooks/egress/squid.conf", "utf8");
    const ports = (name: string) =>
      [...conf.matchAll(new RegExp(`^acl ${name} port (\\d+)`, "gm"))]
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
    const safe = ports("Safe_ports");
    const ssl = ports("SSL_ports");
    expect(safe.length, "squid.conf declares no Safe_ports; re-anchor this test").toBeGreaterThan(
      0,
    );
    expect([...EGRESS_SAFE_PORTS].sort((a, b) => a - b)).toEqual(safe);
    expect([...EGRESS_SSL_PORTS].sort((a, b) => a - b)).toEqual(ssl);
  });
});

describe("what the pre-flight says", () => {
  it("refuses the port the live run was refused on, naming it", () => {
    const why = egressPortRefusal("http://echo-target.local:8099/hook");
    expect(why).not.toBeNull();
    expect(why).toContain("8099");
    expect(why).toContain("80, 443, 9000, 19000");
    // And says whose rule it is, because a 403 does not.
    expect(why).toMatch(/egress proxy/);
    expect(why).toMatch(/hosts, not ports/);
  });

  it("refuses https on a port the proxy will not CONNECT to", () => {
    // `http_access deny CONNECT !SSL_ports` — a separate denial with the same
    // symptom, so it gets its own sentence.
    const why = egressPortRefusal("https://api.example.com:8443/ingest");
    expect(why).toContain("8443");
    expect(why).toMatch(/only tunnels HTTPS to port 443/);
  });

  it("passes every port the proxy admits, explicit or implied", () => {
    for (const url of [
      "http://echo-target.local/hook",
      "http://echo-target.local:80/hook",
      "https://api.example.com/items",
      "https://api.example.com:443/items",
      "http://minio.local:9000/bucket",
      "http://minio.local:19000/bucket",
    ]) {
      expect(egressPortRefusal(url), url).toBeNull();
    }
  });

  it("stays quiet about anything that is not a port problem", () => {
    // A blank field, a templated URL and a malformed one each have their own
    // check and their own message; two complaints for one mistake is worse
    // than one.
    expect(egressPortRefusal("")).toBeNull();
    expect(egressPortRefusal(undefined)).toBeNull();
    expect(egressPortRefusal("https://{{params.host}}/ingest")).toBeNull();
    expect(egressPortRefusal("not a url")).toBeNull();
  });
});

describe("where the pre-flight runs", () => {
  it("is on the HTTP node, before anything starts", () => {
    const svc = readFileSync("src/utils/etl/service.server.ts", "utf8");
    const at = svc.indexOf('if (c.type === "http_api") {');
    expect(at, "the http_api egress block moved; re-anchor this test").toBeGreaterThan(-1);
    const body = svc.slice(at, at + 600);
    expect(body).toContain("const portWhy = egressPortRefusal(url);");
    // Named node, named field — the same sentence shape as every other
    // refusal the canvas shows.
    expect(body).toContain('`${node.kind === "target" ? "Target" : "Source"} "${node.label ||');
    // And the host check still runs: a good port on an unreachable host is
    // still refused, by the other rule.
    expect(body).toContain("await assertEgress(");
  });
});
