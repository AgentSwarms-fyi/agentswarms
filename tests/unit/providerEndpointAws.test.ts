// R427: a Bedrock or Claude Platform on AWS endpoint override is the service's
// own name, in the region the request is signed for.
//
// Until R427 the Bedrock override accepted any `*.amazonaws.com` or `*.api.aws`
// host and Claude Platform on AWS any `*.api.aws` or `*.vpce.amazonaws.com`.
// Under amazonaws.com sit names a customer controls that carry AWS's own valid
// certificate and hand the whole request to their owner: an API Gateway stage,
// `<id>.execute-api.<region>.amazonaws.com`. A Bedrock call aimed there carried
// its SigV4 signature, session token and prompt, a Claude Platform call its API
// key, and the stage's answer came back as the model's. Now only the public,
// FIPS, dual-stack and interface-endpoint names of that service in that region
// are accepted — on save, in the network-path check, and in the adapters.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "10.0.12.34", family: 4 }],
}));

// The server functions with the framework's builder faked, the store and
// audit replaced: what a save would write is captured, nothing is stored.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      middleware: () => b,
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (a: { data: unknown; context: unknown }) => unknown) =>
        async (opts: { data: unknown }) =>
          h({ data: validate(opts.data), context: { userId: "u1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
const upserts: Array<Record<string, unknown>> = [];
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row);
        return { error: null };
      },
    }),
  },
}));
vi.mock("@/utils/providers/crypto.server", () => ({ encryptJson: async () => "enc" }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

import { bedrockChatStream } from "@/utils/providers/adapters/bedrock.server";
import { claudeAwsChatStream } from "@/utils/providers/adapters/claudeAws.server";
import {
  checkProviderNetworkPath,
  saveProviderCredential,
} from "@/utils/providers/credentials.functions";
import { providerEndpoint, providerOrigin } from "@/utils/providers/privateEndpoint";

type Fn = (o: { data: unknown }) => Promise<unknown>;
const save = saveProviderCredential as unknown as Fn;
const check = checkProviderNetworkPath as unknown as Fn;

// Names a customer can own, each with a valid certificate on AWS's side.
const GATEWAY = "https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com";
const GATEWAY_DUALSTACK = "https://a1b2c3d4e5.execute-api.us-east-1.api.aws";
const APPSYNC = "https://abcdefghijklmnopqrstuvwxyz.appsync-api.us-east-1.amazonaws.com";
const BUCKET = "https://my-bucket.s3.us-east-1.amazonaws.com";
// Another account's endpoint service, reached through an interface endpoint.
const ENDPOINT_SERVICE =
  "https://vpce-0abc-xyz.vpce-svc-0123456789abcdef0.us-east-1.vpce.amazonaws.com";

let calls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  upserts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input instanceof Request ? input.url : input));
    void init;
    return new Response('data: {"delta":{"text":"ok"}}\n\n', { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const msgs = [{ role: "user" as const, content: "hi" }];

describe("Bedrock: only bedrock-runtime's own names, in the signing region", () => {
  it.each([
    ["https://bedrock-runtime.eu-west-1.amazonaws.com", "eu-west-1"],
    ["https://bedrock-runtime-fips.us-east-1.amazonaws.com", "us-east-1"],
    ["https://bedrock-runtime.us-east-1.api.aws", "us-east-1"],
    ["https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com", "us-gov-west-1"],
    ["https://vpce-0abc123-xyz.bedrock-runtime.eu-west-1.vpce.amazonaws.com", "eu-west-1"],
    // An interface endpoint's zonal name.
    [
      "https://vpce-0abc123-xyz-eu-west-1a.bedrock-runtime.eu-west-1.vpce.amazonaws.com",
      "eu-west-1",
    ],
  ])("accepts %s in %s", (endpoint, region) => {
    expect(providerEndpoint("bedrock", endpoint, region)).toBe(endpoint);
  });

  it("normalises case, and keeps Bedrock's default region when none is given", () => {
    expect(
      providerEndpoint("bedrock", "https://VPCE-0ABC.Bedrock-Runtime.US-EAST-1.vpce.amazonaws.com"),
    ).toBe("https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com");
  });

  it.each([
    [GATEWAY],
    [GATEWAY_DUALSTACK],
    [APPSYNC],
    [BUCKET],
    [ENDPOINT_SERVICE],
    ["https://ec2-203-0-113-7.compute-1.amazonaws.com"],
    // Another Bedrock service, and names built around the real one.
    ["https://bedrock-agent-runtime.us-east-1.amazonaws.com"],
    ["https://x.bedrock-runtime.us-east-1.amazonaws.com"],
    ["https://xbedrock-runtime.us-east-1.amazonaws.com"],
    ["https://bedrock-runtime.us-east-1.amazonaws.com.attacker.test"],
    ["https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com.attacker.test"],
    // An interface endpoint's name is one label before the service, no more.
    ["https://vpce-0abc.x.bedrock-runtime.us-east-1.vpce.amazonaws.com"],
  ])("refuses %s, naming the region and an example in it", (endpoint) => {
    expect(() => providerEndpoint("bedrock", endpoint, "us-east-1")).toThrow(
      "Bedrock endpoint must be bedrock-runtime's own address in us-east-1 — expected something like https://vpce-0abc123.bedrock-runtime.us-east-1.vpce.amazonaws.com",
    );
  });

  it("refuses another region's name: the request is signed for this one", () => {
    expect(() =>
      providerEndpoint(
        "bedrock",
        "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com",
        "eu-west-1",
      ),
    ).toThrow(
      /own address in eu-west-1 — expected something like https:\/\/vpce-0abc123\.bedrock-runtime\.eu-west-1\./,
    );
  });

  it("says a region that is not one is the problem, before the host", () => {
    expect(() =>
      providerEndpoint("bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com", "us-east-1/"),
    ).toThrow(/^Bedrock region "us-east-1\/" is not a region name/);
  });
});

describe("Claude Platform on AWS: only aws-external-anthropic's own names", () => {
  it("accepts the public and interface-endpoint names in the workspace's region", () => {
    for (const e of [
      "https://aws-external-anthropic.us-west-2.api.aws",
      "https://vpce-0abc123-xyz.aws-external-anthropic.us-west-2.vpce.amazonaws.com",
    ]) {
      expect(providerEndpoint("claude_aws", e, "us-west-2")).toBe(e);
    }
  });

  it.each([
    [GATEWAY.replace("us-east-1", "us-west-2")],
    [GATEWAY_DUALSTACK.replace("us-east-1", "us-west-2")],
    ["https://anything.us-west-2.api.aws"],
    ["https://aws-external-anthropic.us-west-2.amazonaws.com"],
    ["https://aws-external-anthropic.us-east-1.api.aws"],
    [ENDPOINT_SERVICE.replace("us-east-1", "us-west-2")],
  ])("refuses %s", (endpoint) => {
    expect(() => providerEndpoint("claude_aws", endpoint, "us-west-2")).toThrow(
      /^Claude Platform on AWS endpoint must be aws-external-anthropic's own address in us-west-2 — expected something like https:\/\/vpce-0abc123\.aws-external-anthropic\.us-west-2\.vpce\.amazonaws\.com$/,
    );
  });

  it("has no default region to match against", () => {
    expect(() =>
      providerEndpoint("claude_aws", "https://aws-external-anthropic.us-west-2.api.aws"),
    ).toThrow(/^Claude Platform on AWS region "" is not a region name/);
  });
});

describe("the other providers keep their domain rule", () => {
  it("Vertex and OCI are unchanged, and ignore a region", () => {
    expect(providerEndpoint("vertex", "https://aiplatform-ep1.p.googleapis.com", "x")).toBe(
      "https://aiplatform-ep1.p.googleapis.com",
    );
    expect(() => providerEndpoint("vertex", "https://aiplatform.attacker.test")).toThrow(
      "Vertex AI endpoint must be a *.googleapis.com address — expected something like https://aiplatform-myendpoint.p.googleapis.com",
    );
    expect(() => providerEndpoint("oci_genai", "https://x.attacker.test")).toThrow(
      /^OCI Generative AI endpoint must be a \*\.oci\.oraclecloud\.com address/,
    );
  });
});

describe("the adapters send nothing to a name the rule refuses", () => {
  it("Bedrock: no request to an API Gateway stage", async () => {
    await expect(
      bedrockChatStream({
        creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" },
        config: { region: "us-east-1", endpoint: GATEWAY },
        modelId: "m",
        messages: msgs,
      }),
    ).rejects.toThrow(/Bedrock endpoint must be bedrock-runtime's own address in us-east-1/);
    expect(calls).toEqual([]);
  });

  it("Claude Platform on AWS: the API key goes nowhere", async () => {
    await expect(
      claudeAwsChatStream({
        creds: { apiKey: "sk-ant-api-example" },
        config: {
          region: "us-west-2",
          workspaceId: "wrkspc_01Example",
          endpoint: GATEWAY_DUALSTACK.replace("us-east-1", "us-west-2"),
        },
        modelId: "claude-sonnet-4-5",
        messages: msgs,
      }),
    ).rejects.toThrow(/aws-external-anthropic's own address in us-west-2/);
    expect(calls).toEqual([]);
  });

  it("Bedrock: a zonal interface endpoint in another region is called and signed there", async () => {
    const endpoint =
      "https://vpce-0abc123-xyz-eu-west-1a.bedrock-runtime.eu-west-1.vpce.amazonaws.com";
    await bedrockChatStream({
      creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      config: { region: "eu-west-1", endpoint },
      modelId: "m",
      messages: msgs,
    });
    expect(calls).toEqual([`${endpoint}/model/m/converse-stream`]);
    expect(providerOrigin("bedrock", { region: "eu-west-1", endpoint })).toBe(endpoint);
  });
});

describe("saving refuses the name before anything is stored", () => {
  const bedrock = (over: Record<string, unknown>) => ({
    provider: "bedrock",
    bedrock: {
      region: "eu-west-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret-example",
      ...over,
    },
  });

  it("Bedrock: an endpoint in the connection's region is saved", async () => {
    const endpoint = "https://vpce-0abc.bedrock-runtime.eu-west-1.vpce.amazonaws.com";
    await expect(save({ data: bedrock({ endpoint }) })).resolves.toEqual({ ok: true });
    expect(upserts).toHaveLength(1);
    expect((upserts[0].config as { endpoint?: string }).endpoint).toBe(endpoint);
  });

  it("Bedrock: an endpoint for another region is refused, naming the connection's", async () => {
    await expect(
      save({
        data: bedrock({
          endpoint: "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com",
        }),
      }),
    ).rejects.toThrow(/own address in eu-west-1/);
    expect(upserts).toEqual([]);
  });

  it("Claude Platform on AWS: an API Gateway stage is refused, the key not stored", async () => {
    await expect(
      save({
        data: {
          provider: "claude_aws",
          claude_aws: {
            region: "us-west-2",
            workspaceId: "wrkspc_01Example",
            apiKey: "sk-ant-api-example",
            endpoint: GATEWAY.replace("us-east-1", "us-west-2"),
          },
        },
      }),
    ).rejects.toThrow(/aws-external-anthropic's own address in us-west-2/);
    expect(upserts).toEqual([]);
  });

  it("the network-path check answers the refusal without resolving the name", async () => {
    await expect(
      check({ data: { provider: "bedrock", region: "us-east-1", endpoint: GATEWAY } }),
    ).resolves.toEqual({
      ok: false,
      error:
        "Bedrock endpoint must be bedrock-runtime's own address in us-east-1 — expected something like https://vpce-0abc123.bedrock-runtime.us-east-1.vpce.amazonaws.com",
    });
  });
});
