// Phase 2 (private GenAI connectivity): Claude Platform on AWS as a provider.
//
// Anthropic's Claude API, operated by Anthropic and billed through the
// customer's AWS account: the first-party Messages API at
// https://aws-external-anthropic.<region>.api.aws/v1/messages, the workspace in
// `anthropic-workspace-id`, authenticated by an AWS-console API key (Bearer) or
// AWS access keys signed with SigV4 for `aws-external-anthropic`. PrivateLink is
// supported, so the endpoint takes a private override like the other clouds.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "10.0.12.34", family: 4 }],
}));

import { claudeAwsChatStream } from "@/utils/providers/adapters/claudeAws.server";
import { bedrockChatStream, signRequest } from "@/utils/providers/adapters/bedrock.server";
import { providerEndpoint, providerOrigin } from "@/utils/providers/privateEndpoint";

type Call = { url: string; headers: Record<string, string>; body: string };
let calls: Call[] = [];
let upstreamBody = "";
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  upstreamBody = 'event: ping\ndata: {"type":"ping"}\n\n';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = String(v);
    }
    calls.push({ url: String(input), headers, body: String(init?.body ?? "") });
    return new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const base = {
  modelId: "claude-sonnet-5-5",
  messages: [{ role: "user" as const, content: "Hello!" }],
};

describe("the request it sends", () => {
  it("API key: Bearer auth, the workspace header, the Messages API body", async () => {
    await claudeAwsChatStream({
      ...base,
      creds: { apiKey: "aws-console-key" },
      config: { region: "us-west-2", workspaceId: "wrkspc_01AbCdEf23GhIj" },
      systemPrompt: "Be brief.",
    });
    const c = calls[0];
    expect(c.url).toBe("https://aws-external-anthropic.us-west-2.api.aws/v1/messages");
    expect(c.headers.authorization).toBe("Bearer aws-console-key");
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.headers["anthropic-workspace-id"]).toBe("wrkspc_01AbCdEf23GhIj");
    const body = JSON.parse(c.body);
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      system: "Be brief.",
      stream: true,
      messages: [{ role: "user", content: "Hello!" }],
    });
  });

  it("access keys: SigV4 for aws-external-anthropic in the workspace's region", async () => {
    await claudeAwsChatStream({
      ...base,
      creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" },
      config: { region: "eu-central-1", workspaceId: "wrkspc_01AbCdEf23GhIj" },
    });
    const c = calls[0];
    expect(c.url).toBe("https://aws-external-anthropic.eu-central-1.api.aws/v1/messages");
    expect(c.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/aws-external-anthropic\/aws4_request, SignedHeaders=[^,]*host/,
    );
    expect(c.headers["x-amz-security-token"]).toBe("tok");
    expect(c.headers["anthropic-workspace-id"]).toBe("wrkspc_01AbCdEf23GhIj");
  });

  it("a PrivateLink endpoint replaces the host and is signed for", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T12:00:00Z"), toFake: ["Date"] });
    await claudeAwsChatStream({
      ...base,
      creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      config: {
        region: "us-west-2",
        workspaceId: "wrkspc_01AbCdEf23GhIj",
        endpoint: "https://vpce-0abc.aws-external-anthropic.us-west-2.vpce.amazonaws.com",
      },
    });
    expect(calls[0].url).toBe(
      "https://vpce-0abc.aws-external-anthropic.us-west-2.vpce.amazonaws.com/v1/messages",
    );
    expect(calls[0].headers.authorization).toMatch(/\/us-west-2\/aws-external-anthropic\//);
    // the signature covers the host it is sent to, not the public one
    const expected = await signRequest({
      service: "aws-external-anthropic",
      region: "us-west-2",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      method: "POST",
      host: "vpce-0abc.aws-external-anthropic.us-west-2.vpce.amazonaws.com",
      path: "/v1/messages",
      body: calls[0].body,
    });
    vi.useRealTimers();
    expect(calls[0].headers.authorization).toBe(expected.Authorization);
  });
});

describe("refused before any request", () => {
  it("has no default region", async () => {
    await expect(
      claudeAwsChatStream({
        ...base,
        creds: { apiKey: "k" },
        config: { region: "", workspaceId: "wrkspc_01AbCdEf23GhIj" },
      }),
    ).rejects.toThrow(/Claude Platform on AWS region/);
    expect(calls).toEqual([]);
  });

  it("needs a real workspace id", async () => {
    await expect(
      claudeAwsChatStream({
        ...base,
        creds: { apiKey: "k" },
        config: { region: "us-west-2", workspaceId: "default" },
      }),
    ).rejects.toThrow(/wrkspc_/);
    expect(calls).toEqual([]);
  });

  it("needs a key or access keys", async () => {
    await expect(
      claudeAwsChatStream({
        ...base,
        creds: {},
        config: { region: "us-west-2", workspaceId: "wrkspc_01AbCdEf23GhIj" },
      }),
    ).rejects.toThrow(/API key or AWS access keys/);
    expect(calls).toEqual([]);
  });

  it("refuses an endpoint off its domain", async () => {
    await expect(
      claudeAwsChatStream({
        ...base,
        creds: { apiKey: "k" },
        config: {
          region: "us-west-2",
          workspaceId: "wrkspc_01AbCdEf23GhIj",
          endpoint: "https://aws-external-anthropic.attacker.test",
        },
      }),
    ).rejects.toThrow(/Claude Platform on AWS endpoint/);
    expect(calls).toEqual([]);
  });
});

describe("the stream it returns", () => {
  it("re-emits Anthropic text deltas as OpenAI chunks, ending with [DONE]", async () => {
    upstreamBody =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const res = await claudeAwsChatStream({
      ...base,
      creds: { apiKey: "k" },
      config: { region: "us-west-2", workspaceId: "wrkspc_01AbCdEf23GhIj" },
    });
    const text = await res.text();
    const deltas = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]);
    expect(deltas.join("")).toBe("Hello");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("Bedrock still signs as bedrock", () => {
  it("the shared signer defaults to its own service", async () => {
    await bedrockChatStream({
      creds: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      config: { region: "us-east-1" },
      modelId: "m",
      messages: base.messages,
    });
    expect(calls[0].headers.authorization).toMatch(/\/us-east-1\/bedrock\/aws4_request/);
  });
});

describe("registered everywhere a provider must be", () => {
  it("has an origin and an endpoint rule", () => {
    expect(providerOrigin("claude_aws", { region: "us-west-2" })).toBe(
      "https://aws-external-anthropic.us-west-2.api.aws",
    );
    expect(providerEndpoint("claude_aws", "https://aws-external-anthropic.us-west-2.api.aws")).toBe(
      "https://aws-external-anthropic.us-west-2.api.aws",
    );
    expect(() => providerEndpoint("claude_aws", "https://example.com")).toThrow();
  });

  it("is a provider id, a gateway prefix, a chat provider, and a dispatch case", () => {
    expect(readFileSync("src/utils/providers/types.ts", "utf8")).toMatch(/\| "claude_aws";/);
    expect(readFileSync("src/utils/gateway/providers.ts", "utf8")).toMatch(/"claude_aws",/);
    const chat = readFileSync("src/routes/api/chat.ts", "utf8");
    expect(chat.slice(chat.indexOf("const VALID_PROVIDERS"))).toMatch(/"claude_aws",/);
    expect(readFileSync("src/utils/providers/credentials.server.ts", "utf8")).toMatch(
      /case "claude_aws":\s*return claudeAwsChatStream\(/,
    );
  });

  it("can be saved, path-checked and picked in the UI", () => {
    const fns = readFileSync("src/utils/providers/credentials.functions.ts", "utf8");
    expect(fns).toMatch(/"qwen",\s*"claude_aws",\s*\]\);/);
    expect(fns).toMatch(/case "claude_aws": \{/);
    expect(fns).toMatch(
      /provider: z\.enum\(\["bedrock", "vertex", "oci_genai", "azure_openai", "claude_aws"\]\)/,
    );
    const panel = readFileSync("src/components/integrations/ProviderCredentialsPanel.tsx", "utf8");
    expect(panel).toMatch(/id: "claude_aws",/);
    expect(panel).toMatch(/if \(uiId === "claude_aws"\) return "claude_aws";/);
    for (const f of [
      "src/components/agents/AgentForm.tsx",
      "src/components/swarms/NodeInspector.tsx",
      "src/routes/_authenticated/agents.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/value: "claude_aws"/);
    }
  });

  it("the database admits it — and the providers it always rejected", () => {
    const sql = readFileSync(
      "supabase/migrations/20261028000000_provider_credentials_providers.sql",
      "utf8",
    );
    for (const p of [
      "bedrock",
      "vertex",
      "anthropic",
      "azure_openai",
      "oci_genai",
      "qwen",
      "claude_aws",
    ]) {
      expect(sql, p).toContain(`'${p}'`);
    }
    // proves itself on apply
    expect(sql).toMatch(/RAISE EXCEPTION 'provider_credentials: provider % is not admitted/);
  });
});
