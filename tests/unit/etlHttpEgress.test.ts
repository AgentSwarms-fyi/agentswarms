// An HTTP node that points somewhere the sandbox may not reach says so.
//
// Found by pointing a visual HTTP API source at a host that was not on the
// egress allow-list. The preview did not refuse; it started a container, and
// came back with forty lines of urllib3 ending in
//
//   OSError: Tunnel connection failed: 403 Forbidden
//   urllib3.exceptions.ProxyError: ('Unable to connect to proxy', …)
//
// which names no host, mentions no allow-list, and reads like the endpoint is
// down. Stream sources (Kafka, Kinesis, Pub/Sub) had a pre-flight check from
// the start, with a sentence naming the host and the page that fixes it. The
// HTTP API source and the reverse-ETL HTTP target — the two node kinds most
// likely to point at something new — did not.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  egressReaches,
  hostMatchesPattern,
  staticEgressHost,
} from "@/utils/notebookRuntime/egress";

const service = readFileSync("src/utils/etl/service.server.ts", "utf8");
const fns = readFileSync("src/utils/etl.functions.ts", "utf8");

describe("the host a node will dial", () => {
  it("is the hostname, port and path aside", () => {
    expect(staticEgressHost("https://api.stripe.com/v1/charges?x=1")).toEqual(["api.stripe.com"]);
    expect(staticEgressHost("http://agentswarms:8080/etl-samples/orders.json")).toEqual([
      "agentswarms",
    ]);
  });

  it("is unknown for a URL a run parameter completes", () => {
    // `https://{{params.host}}/v1` has no host until the run substitutes one.
    // Refusing on a guess would block a pipeline that is fine, so this one
    // case still falls through to the proxy — that case, not every case.
    expect(staticEgressHost("https://{{params.host}}/v1")).toEqual([]);
    expect(staticEgressHost("https://api.test/{{params.day}}/rows")).toEqual([]);
  });

  it("is unknown for nothing, whitespace or a non-URL", () => {
    expect(staticEgressHost(undefined)).toEqual([]);
    expect(staticEgressHost(null)).toEqual([]);
    expect(staticEgressHost("   ")).toEqual([]);
    expect(staticEgressHost("not a url")).toEqual([]);
  });
});

describe("matching, the way the proxy matches", () => {
  it("treats a leading dot as the domain and everything under it", () => {
    // squid's dstdomain semantics, which the ACL file's own header documents.
    expect(hostMatchesPattern(".github.com", "github.com")).toBe(true);
    expect(hostMatchesPattern(".github.com", "api.github.com")).toBe(true);
    expect(hostMatchesPattern(".github.com", "a.b.github.com")).toBe(true);
    // And does not match a domain that merely ends in the same letters.
    expect(hostMatchesPattern(".github.com", "notgithub.com")).toBe(false);
  });

  it("matches a dotless pattern exactly", () => {
    expect(hostMatchesPattern("broker", "broker")).toBe(true);
    expect(hostMatchesPattern("broker", "broker.internal")).toBe(false);
  });

  it("tolerates a pasted URL, a port and a trailing dot on either side", () => {
    expect(hostMatchesPattern("https://api.example.com:443/v1", "api.example.com")).toBe(true);
    expect(hostMatchesPattern(".example.com", "API.Example.Com.")).toBe(true);
  });

  it("lets a subdomain of an allow-listed domain through", () => {
    // The bug this replaced: the check compared normalised tokens with
    // Set.has, so `.github.com` on the list did not admit `api.github.com` —
    // squid would have, and the refusal told the reader to add something that
    // was already there.
    expect(egressReaches([".github.com"], "api.github.com")).toBe(true);
  });

  it("keeps the hosts that skip the proxy entirely", () => {
    // These are single-label or bare suffixes, so the ACL normaliser drops
    // them; they are nonetheless reachable, because NO_PROXY covers them.
    expect(egressReaches(["agentswarms", "localhost", "127.0.0.1"], "agentswarms")).toBe(true);
    expect(egressReaches([".svc", ".cluster.local"], "kafka.default.svc")).toBe(true);
  });

  it("admits a raw IP the operator listed", () => {
    // IPs live in the same admin field and are split into squid's dst file at
    // apply time. Running them through the ACL normaliser would have dropped
    // them (it rejects addresses by design), so a LAN MinIO on the list would
    // have been reported as forbidden.
    expect(egressReaches(["10.0.0.5", ".github.com"], "10.0.0.5")).toBe(true);
    expect(egressReaches(["10.0.0.5"], "10.0.0.6")).toBe(false);
  });

  it("still refuses a host nothing mentions", () => {
    expect(egressReaches([".github.com", "localhost"], "evil.test")).toBe(false);
    expect(egressReaches([], "anything.test")).toBe(false);
  });
});

describe("what the run checks before it starts a container", () => {
  it("holds an HTTP node to the allow-list, source and target alike", () => {
    expect(service).toContain('if (c.type === "http_api") {');
    expect(service).toMatch(/assertEgress\(\s*node as EtlNode,\s*staticEgressHost/);
    // The verb follows the direction, so the sentence reads correctly for a
    // reverse-ETL target as well as a source.
    expect(service).toMatch(/node\.kind === "target" \? "writes to" : "reads from"/);
  });

  it("says it in ONE sentence, shared with the stream sources", () => {
    // Two copies of this message would drift; the stream check and the HTTP
    // check go through the same helper, so there is exactly one to keep true.
    const copies = service.match(/not on the sandbox egress allow-list/g) ?? [];
    expect(copies.length).toBe(1);
    expect(service).toContain("Admin → Developer runtime → Egress allow-list.");
    // And the stream path now goes through the shared helper rather than its
    // own inline loop.
    expect(service).toMatch(/assertEgress\(node, streamEgressHosts\(cfg\), "reads from"\)/);
    // The reachable set is all three sources, matched squid-style rather than
    // by Set.has on a normalised token.
    expect(service).toContain('noProxyList(internalAppUrl()).split(",")');
    expect(service).toContain("egressReaches(allowedEgress, host)");
  });

  it("checks it where the reader is, not inside the container", () => {
    // Having the right sentence is not the same as delivering it. The preview
    // resolved its env from inside the sandbox, so the refusal came back as
    // `500 Internal Server Error for url .../api/notebook/runtime/source` with
    // a Python traceback around it — the same shape of answer the fix set out
    // to remove. previewEtlNode now resolves the env before it starts
    // anything, beside the compile step that was already there for the same
    // reason, so the message lands in the preview dialog.
    const at = fns.indexOf("export const previewEtlNode");
    expect(at).toBeGreaterThan(-1);
    const body = fns.slice(at, fns.indexOf("export const", at + 10));
    expect(body).toContain("compilePreview(graph, data.node_id);");
    expect(body).toContain("await resolveRunEnv(pipeline, { skipTargets: true });");
    // Before the session starts, or it has changed nothing.
    expect(body.indexOf("resolveRunEnv")).toBeLessThan(body.indexOf("startSession"));
  });

  it("names the host, because that is the thing to add", () => {
    const at = service.indexOf("not on the sandbox egress allow-list");
    const line = service.slice(Math.max(0, at - 200), at);
    expect(line).toContain("${host}");
  });
});
