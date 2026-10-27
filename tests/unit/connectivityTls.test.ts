// Phase 2 (private GenAI connectivity): the path report names the TLS
// certificate the endpoint presents, and whether it is valid for the name.
//
// A private endpoint reached under the wrong name (a `privatelink` alias, a
// hand-made hosts entry) answers with a certificate for another name, and every
// call then fails TLS verification; a TLS-inspecting middlebox answers with its
// own CA. The handshake shows both, before any credentials are sent. It is made
// to the address the report already resolved (no second lookup to rebind), only
// when asked, only for https, never through the proxy or to a metadata address.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: Record<string, string[]> = {};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const a = answers[host];
    if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

type Handshake = {
  cert?: {
    subject?: Record<string, string>;
    issuer?: Record<string, string>;
    subjectaltname?: string;
  };
  authorized?: boolean;
  authorizationError?: string;
  fail?: "error" | "timeout";
};
const tls = vi.hoisted(() => ({
  handshake: {} as Handshake,
  connects: [] as Record<string, unknown>[],
  destroyed: 0,
}));
vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tls")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    connect: (opts: Record<string, unknown>) => {
      tls.connects.push(opts);
      const h = tls.handshake;
      const socket = Object.assign(new EventEmitter(), {
        authorized: h.authorized ?? true,
        authorizationError: h.authorizationError,
        getPeerCertificate: () => h.cert ?? {},
        destroy: () => {
          tls.destroyed++;
        },
      });
      setTimeout(() => {
        if (h.fail === "error") socket.emit("error", new Error("ECONNRESET"));
        else if (h.fail === "timeout") socket.emit("timeout");
        else socket.emit("secureConnect");
      }, 0);
      return socket;
    },
  };
});

import { readFileSync } from "node:fs";

import { runProviderTest } from "@/utils/integrations/testAdapters.server";
import { describeConnectivity } from "@/utils/providers/connectivityPath.server";

const BEDROCK = "bedrock-runtime.us-east-1.amazonaws.com";
const amazonCert = {
  cert: { subject: { CN: BEDROCK }, issuer: { O: "Amazon", CN: "Amazon RSA 2048 M02" } },
  authorized: true,
};
const realFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  for (const k of ["https_proxy", "http_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(k, "");
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) vi.stubEnv(k, "");
  tls.handshake = {};
  tls.connects = [];
  tls.destroyed = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

describe("the certificate in the path report", () => {
  it("names it, its issuer, and that it is valid here", async () => {
    answers[BEDROCK] = ["10.0.12.34"];
    tls.handshake = amazonCert;
    const r = await describeConnectivity(`https://${BEDROCK}`, { tls: true });
    expect(r.tls).toEqual({ subject: BEDROCK, issuer: "Amazon", valid: true });
    expect(r.summary).toBe(
      `direct to 10.0.12.34 (private); certificate for ${BEDROCK} from Amazon`,
    );
    expect(tls.destroyed).toBe(1);
  });

  it("is read from the address already resolved, for the host's name", async () => {
    answers["aws-external-anthropic.us-west-2.api.aws"] = ["10.0.7.8", "10.0.7.9"];
    tls.handshake = amazonCert;
    await describeConnectivity("https://aws-external-anthropic.us-west-2.api.aws:8443", {
      tls: true,
    });
    expect(tls.connects).toHaveLength(1);
    expect(tls.connects[0]).toMatchObject({
      host: "10.0.7.8",
      port: 8443,
      servername: "aws-external-anthropic.us-west-2.api.aws",
      rejectUnauthorized: false,
    });
    expect(tls.connects[0].timeout).toBeGreaterThan(0);
  });

  it("says when it is not valid for the name, and why", async () => {
    answers["myresource.openai.azure.com"] = ["10.1.2.3"];
    tls.handshake = {
      cert: {
        subject: { CN: "*.privatelink.openai.azure.com" },
        issuer: { O: "Microsoft Corporation" },
      },
      authorized: false,
      authorizationError: "ERR_TLS_CERT_ALTNAME_INVALID",
    };
    const r = await describeConnectivity("https://myresource.openai.azure.com", { tls: true });
    expect(r.tls).toEqual({
      subject: "*.privatelink.openai.azure.com",
      issuer: "Microsoft Corporation",
      valid: false,
      error: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    expect(r.summary).toMatch(
      /; certificate for \*\.privatelink\.openai\.azure\.com from Microsoft Corporation — not valid for this name \(ERR_TLS_CERT_ALTNAME_INVALID\)$/,
    );
  });

  it("falls back to the first DNS name, and the issuer's CN", async () => {
    answers["vllm.internal.example"] = ["10.4.5.6"];
    tls.handshake = {
      cert: {
        subject: {},
        subjectaltname: "DNS:vllm.internal.example, DNS:vllm",
        issuer: { CN: "Corp Root CA" },
      },
      authorized: true,
    };
    const r = await describeConnectivity("https://vllm.internal.example", { tls: true });
    expect(r.tls).toMatchObject({ subject: "vllm.internal.example", issuer: "Corp Root CA" });
  });
});

describe("no handshake", () => {
  it("unless asked — the per-call preflight never pays for one", async () => {
    answers[BEDROCK] = ["10.0.12.34"];
    const r = await describeConnectivity(`https://${BEDROCK}`);
    expect(tls.connects).toEqual([]);
    expect(r.tls).toBeUndefined();
  });

  it("for http, through the proxy, or for a name that does not resolve", async () => {
    answers["ollama.corp.example"] = ["10.9.9.9"];
    await describeConnectivity("http://ollama.corp.example:11434", { tls: true });
    await describeConnectivity("https://nowhere.corp.example", { tls: true });
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp:3128");
    answers[BEDROCK] = ["52.94.0.10"];
    const r = await describeConnectivity(`https://${BEDROCK}`, { tls: true });
    expect(r.proxied).toBe(true);
    expect(tls.connects).toEqual([]);
  });

  it("to a name that resolves to the metadata address", async () => {
    answers["evil.amazonaws.com"] = ["10.0.0.5", "169.254.169.254"];
    const r = await describeConnectivity("https://evil.amazonaws.com", { tls: true });
    expect(tls.connects).toEqual([]);
    expect(r.tls).toBeUndefined();
  });
});

describe("a handshake that does not complete", () => {
  it("leaves the report as it was, failing or hanging", async () => {
    answers[BEDROCK] = ["10.0.12.34"];
    for (const fail of ["error", "timeout"] as const) {
      tls.handshake = { fail };
      const r = await describeConnectivity(`https://${BEDROCK}`, { tls: true });
      expect(r.tls, fail).toBeUndefined();
      expect(r.summary, fail).toBe("direct to 10.0.12.34 (private)");
    }
    expect(tls.destroyed).toBe(2);
  });
});

describe("who asks for it", () => {
  it("a passing connection test", async () => {
    answers["vllm.internal.example"] = ["10.4.5.6"];
    tls.handshake = {
      cert: { subject: { CN: "vllm.internal.example" }, issuer: { O: "Corp" } },
      authorized: true,
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const r = await runProviderTest("vllm", { base_url: "https://vllm.internal.example/v1" });
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).toMatch(
      /— direct to 10\.4\.5\.6 \(private\); certificate for vllm\.internal\.example from Corp$/,
    );
  });

  it("the network-path check", () => {
    const fns = readFileSync("src/utils/providers/credentials.functions.ts", "utf8");
    expect(fns).toMatch(/path: await describeConnectivity\(origin, \{ tls: true \}\)/);
  });
});
