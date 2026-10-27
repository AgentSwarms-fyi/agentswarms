// Phase 2 (private GenAI connectivity): a connection test says which network
// path the call took, and the cloud providers get a credential-free path check.
//
// A private endpoint is only private if its name resolves to a private address
// here (or the call leaves through the proxy). A missing private DNS zone
// otherwise fails silently — the call still works, over the internet — so the
// path is reported, and the check uses the same host the adapter will call.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: Record<string, string[]> = {};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const a = answers[host];
    if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

import { describeConnectivity } from "@/utils/providers/connectivityPath.server";
import { runProviderTest } from "@/utils/integrations/testAdapters.server";
import { providerOrigin } from "@/utils/providers/privateEndpoint";

const realFetch = globalThis.fetch;

function noProxy() {
  // Lower-case first: on Windows the two spellings are one variable.
  for (const k of ["https_proxy", "http_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(k, "");
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) vi.stubEnv(k, "");
}

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  noProxy();
});
afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

describe("describeConnectivity", () => {
  it("reports a private endpoint as direct and private", async () => {
    answers["vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com"] = ["10.0.12.34"];
    const p = await describeConnectivity(
      "https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com",
    );
    expect(p).toMatchObject({ proxied: false, privateAddress: true, addresses: ["10.0.12.34"] });
    expect(p.summary).toBe("direct to 10.0.12.34 (private)");
  });

  it("reports a public resolution as public — the missing-DNS-zone case", async () => {
    answers["bedrock-runtime.us-east-1.amazonaws.com"] = ["52.94.0.10"];
    const p = await describeConnectivity("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(p.privateAddress).toBe(false);
    expect(p.summary).toBe("direct to 52.94.0.10 (public)");
  });

  it("counts a name with any public address as public", async () => {
    answers["mixed.example.com"] = ["10.0.0.5", "52.94.0.10"];
    expect((await describeConnectivity("https://mixed.example.com")).privateAddress).toBe(false);
  });

  it("says when the name does not resolve here", async () => {
    const p = await describeConnectivity("https://nowhere.example.com");
    expect(p.privateAddress).toBeNull();
    expect(p.summary).toMatch(/does not resolve/);
  });

  it("reports the proxy, without its credentials", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://user:secret@proxy.corp:3128");
    const p = await describeConnectivity("https://api.openai.com/v1");
    expect(p).toMatchObject({ proxied: true, proxy: "proxy.corp:3128", privateAddress: null });
    expect(p.summary).toBe("via proxy proxy.corp:3128");
    expect(JSON.stringify(p)).not.toContain("secret");
  });

  it("goes direct for a NO_PROXY host", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp:3128");
    vi.stubEnv("NO_PROXY", "openai.azure.com");
    answers["res.openai.azure.com"] = ["10.1.2.3"];
    const p = await describeConnectivity("https://res.openai.azure.com");
    expect(p).toMatchObject({ proxied: false, privateAddress: true });
  });
});

describe("a passing connection test reports its path", () => {
  it("appends the path to the detail and returns it", async () => {
    answers["vllm.internal.example"] = ["10.4.5.6"];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const r = await runProviderTest("vllm", { base_url: "http://vllm.internal.example:8000/v1" });
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).toMatch(/— direct to 10\.4\.5\.6 \(private\)$/);
    expect(r.ok && r.path?.privateAddress).toBe(true);
  });

  it("does not add a path to a failing test", async () => {
    answers["vllm.internal.example"] = ["10.4.5.6"];
    globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
    const r = await runProviderTest("vllm", { base_url: "http://vllm.internal.example:8000/v1" });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toMatch(/direct to/);
  });
});

describe("providerOrigin is the host the call uses", () => {
  it("builds the public regional host without an override", () => {
    expect(providerOrigin("bedrock", { region: "eu-west-3" })).toBe(
      "https://bedrock-runtime.eu-west-3.amazonaws.com",
    );
    expect(providerOrigin("vertex", { region: "us-central1" })).toBe(
      "https://us-central1-aiplatform.googleapis.com",
    );
    expect(providerOrigin("oci_genai", { region: "us-chicago-1" })).toBe(
      "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com",
    );
  });

  it("uses the override when set", () => {
    expect(
      providerOrigin("bedrock", {
        region: "us-east-1",
        endpoint: "https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      }),
    ).toBe("https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com");
  });

  it("refuses a region that is not a region name, and an OCI config with none", () => {
    expect(() => providerOrigin("bedrock", { region: "x.attacker.test#" })).toThrow(
      /not a region name/,
    );
    expect(() => providerOrigin("oci_genai", {})).toThrow(/OCI region/);
  });

  it("is what the adapters and the path check both use", () => {
    for (const f of [
      "src/utils/providers/adapters/bedrock.server.ts",
      "src/utils/providers/adapters/oci.server.ts",
      "src/utils/providers/adapters/vertex.server.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/providerOrigin\(/);
    }
    const fn = readFileSync("src/utils/providers/credentials.functions.ts", "utf8");
    const check = fn.slice(fn.indexOf("export const checkProviderNetworkPath"));
    expect(check).toMatch(/providerOrigin\(data\.provider/);
    expect(check).toMatch(/describeConnectivity\(origin, \{ tls: true \}\)/);
    expect(check).toMatch(/azureEndpointProblem\(raw\)/);
  });
});
