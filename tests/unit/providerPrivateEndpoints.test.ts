// F2 (private GenAI connectivity): endpoint overrides for Bedrock, Vertex AI and
// OCI Generative AI, driven through the real adapters.
//
// Before: Bedrock had no override, and the Vertex "Custom Endpoint" and OCI
// "Service Endpoint" fields were shown but dropped on save, so a PrivateLink
// vpce name, a Private Service Connect *.p.googleapis.com name or an OCI
// *.pe.* name could not be used. Now each is optional, must be an https origin
// on the provider's own domain, and is used — and signed for — by the adapter.
//
// These mock fetch to capture the request the adapter makes (and, for the
// signed providers, the headers), then return a minimal streaming body so the
// adapter proceeds. The signing region/credentials are unchanged; only the host
// moves, which is what a private endpoint is.
import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  // Private endpoints resolve to private addresses; that is the point of them.
  lookup: async () => [{ address: "10.0.12.34", family: 4 }],
}));

import { bedrockChatStream } from "@/utils/providers/adapters/bedrock.server";
import { ociChatStream } from "@/utils/providers/adapters/oci.server";
import { vertexChatStream } from "@/utils/providers/adapters/vertex.server";

type Call = { url: string; headers: Record<string, string> };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey as string;

const saJson = JSON.stringify({
  type: "service_account",
  client_email: "svc@example.iam.gserviceaccount.com",
  private_key: pem,
  token_uri: "https://oauth2.googleapis.com/token",
});

const msgs = [{ role: "user" as const, content: "hi" }];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    const h = (input instanceof Request ? input.headers : init?.headers) as
      Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, headers });
    if (url.includes("oauth2")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // A non-null body so the adapter proceeds past its `!upstream.body` guard.
    return new Response('data: {"delta":{"text":"ok"}}\n\n', { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const lastApiCall = () => calls.filter((c) => !c.url.includes("oauth2")).at(-1)!;

describe("Bedrock", () => {
  it("without an override, signs and calls the regional host", async () => {
    await bedrockChatStream({
      creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      config: { region: "us-east-1" },
      modelId: "anthropic.claude-3-5-sonnet",
      messages: msgs,
    });
    const c = lastApiCall();
    expect(c.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet/converse-stream",
    );
    // SigV4: host is signed, and the credential scope is the region.
    expect(c.headers.authorization).toMatch(/SignedHeaders=[^,]*host/);
    expect(c.headers.authorization).toMatch(/Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\//);
  });

  it("with a PrivateLink override, signs and calls that host — region scope unchanged", async () => {
    await bedrockChatStream({
      creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      config: {
        region: "us-east-1",
        endpoint: "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      },
      modelId: "m",
      messages: msgs,
    });
    const c = lastApiCall();
    expect(c.url).toBe(
      "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com/model/m/converse-stream",
    );
    expect(c.headers.authorization).toMatch(/SignedHeaders=[^,]*host/);
    // Still signed for us-east-1 — the host moved, the scope did not.
    expect(c.headers.authorization).toMatch(/\/\d{8}\/us-east-1\/bedrock\//);
  });

  it("refuses an override on another domain, before any request", async () => {
    await expect(
      bedrockChatStream({
        creds: { accessKeyId: "A", secretAccessKey: "s" },
        config: { region: "us-east-1", endpoint: "https://bedrock-runtime.attacker.test" },
        modelId: "m",
        messages: msgs,
      }),
    ).rejects.toThrow(/Bedrock endpoint/);
    expect(calls).toEqual([]);
  });
});

describe("OCI", () => {
  it("with a private-endpoint override, calls the *.pe.* host", async () => {
    await ociChatStream({
      creds: {
        tenancyOcid: "ocid1.tenancy.oc1..aaaa",
        userOcid: "ocid1.user.oc1..bbbb",
        fingerprint: "aa:bb:cc",
        privateKeyPem: pem,
      },
      config: {
        region: "us-chicago-1",
        compartmentId: "ocid1.compartment.oc1..cccc",
        endpoint: "https://pre.pe.inference.generativeai.us-chicago-1.oci.oraclecloud.com",
      },
      modelId: "cohere.command-r",
      messages: msgs,
    });
    const c = lastApiCall();
    expect(c.url).toBe(
      "https://pre.pe.inference.generativeai.us-chicago-1.oci.oraclecloud.com/20231130/actions/chat",
    );
    // OCI signs the host header it sends to.
    expect(c.headers.authorization).toMatch(/signature=/i);
  });

  it("without an override, calls the regional host", async () => {
    await ociChatStream({
      creds: {
        tenancyOcid: "ocid1.tenancy.oc1..aaaa",
        userOcid: "ocid1.user.oc1..bbbb",
        fingerprint: "aa:bb:cc",
        privateKeyPem: pem,
      },
      config: { region: "us-chicago-1", compartmentId: "ocid1.compartment.oc1..cccc" },
      modelId: "cohere.command-r",
      messages: msgs,
    });
    expect(lastApiCall().url).toBe(
      "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/20231130/actions/chat",
    );
  });
});

describe("Vertex", () => {
  it("with a PSC override, calls the API and token through the PSC names", async () => {
    await vertexChatStream({
      creds: { serviceAccountJson: saJson },
      config: {
        projectId: "proj-1",
        location: "us-central1",
        endpoint: "https://aiplatform-ep1.p.googleapis.com",
      },
      modelId: "gemini-2.0-flash",
      messages: msgs,
    });
    const tokenCall = calls.find((c) => c.url.includes("oauth2"))!;
    expect(tokenCall.url).toBe("https://oauth2-ep1.p.googleapis.com/token");
    expect(lastApiCall().url).toMatch(
      /^https:\/\/aiplatform-ep1\.p\.googleapis\.com\/v1\/projects\/proj-1\/locations\/us-central1\//,
    );
    expect(lastApiCall().headers.authorization).toBe("Bearer tok");
  });

  it("without an override, uses the regional host and the public token URL", async () => {
    await vertexChatStream({
      creds: { serviceAccountJson: saJson },
      config: { projectId: "proj-1", location: "us-central1" },
      modelId: "gemini-2.0-flash",
      messages: msgs,
    });
    expect(calls.find((c) => c.url.includes("oauth2"))!.url).toBe(
      "https://oauth2.googleapis.com/token",
    );
    expect(lastApiCall().url).toMatch(
      /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/proj-1\//,
    );
  });
});
