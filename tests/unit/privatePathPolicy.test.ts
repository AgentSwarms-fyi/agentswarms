// Phase 2 (private GenAI connectivity): "Require a private network path",
// per provider, off by default.
//
// When a provider is set to require it, its calls are refused unless the
// endpoint resolves to private addresses only, or the call leaves through the
// proxy — so a private endpoint whose DNS zone is missing fails loudly (and is
// audited) instead of quietly working over the internet. Enforced at the
// connection for calls made inside a provider scope, and as a preflight for a
// resolved OpenAI-compatible transport, which its caller fetches later.
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
// The user's saved integration rows, as loadLegacyConfig reads them.
const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order"]) chain[m] = () => chain;
  // no LLM gateway configured
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: db.rows, error: null });
  return { supabaseAdmin: { from: () => chain } };
});
vi.mock("@/utils/providers/integrationConfig.server", () => ({
  resolveIntegrationConfig: async (_u: string, _t: string, cfg: unknown) => cfg,
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));

import { runProviderTest } from "@/utils/integrations/testAdapters.server";
import { assertPrivatePath } from "@/utils/providers/connectivityPath.server";
import {
  requiresPrivatePath,
  resolveOpenAICompatTransport,
  streamWithProvider,
} from "@/utils/providers/credentials.server";
import { auditEvent } from "@/utils/audit.server";
import {
  PrivatePathRequiredError,
  providerFetch,
  safeFetch,
  SsrfRefusedError,
  withPrivatePathScope,
} from "@/utils/ssrfGuard.server";

let calls: string[] = [];
let respond: (url: string) => Response = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

function noProxy() {
  for (const k of ["https_proxy", "http_proxy", "all_proxy", "no_proxy"]) vi.stubEnv(k, "");
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]) vi.stubEnv(k, "");
}

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  noProxy();
  db.rows = [];
  vi.mocked(auditEvent).mockClear();
  calls = [];
  respond = () =>
    new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
});
afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

/** Run fn inside a provider scope that requires a private path. */
function required<T>(fn: () => Promise<T>, onRefuse?: (d: string) => void): Promise<T> {
  return withPrivatePathScope((policy) => {
    policy.required = true;
    policy.label = "AWS Bedrock";
    policy.onRefuse = onRefuse;
    return fn();
  });
}

describe("inside a provider scope that requires a private path", () => {
  it("refuses a public resolution before sending, and audits it", async () => {
    answers["bedrock-runtime.us-east-1.amazonaws.com"] = ["52.94.0.10"];
    const audit = vi.fn();
    const err = await required(
      () => providerFetch("https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse"),
      audit,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PrivatePathRequiredError);
    // A refusal: never retried by the tool loop or the connectors.
    expect(err).toBeInstanceOf(SsrfRefusedError);
    expect(err.message).toMatch(/AWS Bedrock is set to require a private network path/);
    expect(err.message).toMatch(/resolves to a public address \(52\.94\.0\.10\)/);
    expect(calls).toEqual([]);
    expect(audit).toHaveBeenCalledWith(err.message);
  });

  it("allows a private resolution", async () => {
    answers["vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com"] = ["10.0.12.34"];
    const res = await required(() =>
      providerFetch("https://vpce-1.bedrock-runtime.us-east-1.vpce.amazonaws.com/x"),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("allows a call that leaves through the proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp:3128");
    const res = await required(() => providerFetch("https://api.openai.com/v1/models"));
    expect(res.status).toBe(200);
  });

  it("refuses a name with any public address, and one that does not resolve", async () => {
    answers["mixed.example.com"] = ["10.0.0.5", "52.94.0.10"];
    await expect(required(() => providerFetch("https://mixed.example.com/"))).rejects.toThrow(
      PrivatePathRequiredError,
    );
    await expect(required(() => providerFetch("https://nowhere.example.com/"))).rejects.toThrow(
      /does not resolve/,
    );
    expect(calls).toEqual([]);
  });

  it("checks every redirect hop", async () => {
    answers["private.example.com"] = ["10.0.0.5"];
    answers["public.example.com"] = ["52.94.0.10"];
    respond = (url) =>
      url.includes("private.example.com")
        ? new Response(null, { status: 302, headers: { location: "https://public.example.com/" } })
        : new Response("{}", { status: 200 });
    await expect(required(() => providerFetch("https://private.example.com/"))).rejects.toThrow(
      PrivatePathRequiredError,
    );
    expect(calls).toEqual(["https://private.example.com/"]);
  });

  it("an audit hook that throws does not change the outcome", async () => {
    answers["pub.example.com"] = ["52.94.0.10"];
    await expect(
      required(
        () => providerFetch("https://pub.example.com/"),
        () => {
          throw new Error("audit down");
        },
      ),
    ).rejects.toThrow(PrivatePathRequiredError);
  });
});

describe("it is a choice", () => {
  it("does nothing when the provider does not require it", async () => {
    answers["pub.example.com"] = ["52.94.0.10"];
    const res = await withPrivatePathScope(() => providerFetch("https://pub.example.com/"));
    expect(res.status).toBe(200);
  });

  it("does nothing outside a provider scope", async () => {
    answers["pub.example.com"] = ["52.94.0.10"];
    expect((await providerFetch("https://pub.example.com/")).status).toBe(200);
  });

  it("holds only the provider's own calls to it, not other fetches in the scope", async () => {
    answers["hooks.example.com"] = ["52.94.0.11"];
    const res = await required(() => safeFetch("https://hooks.example.com/"));
    expect(res.status).toBe(200);
  });

  it("reads the flag from either kind of saved config, and only when set", () => {
    expect(requiresPrivatePath({ requirePrivate: true })).toBe(true);
    expect(requiresPrivatePath({ require_private: "true" })).toBe(true);
    expect(requiresPrivatePath({ require_private: true })).toBe(true);
    expect(requiresPrivatePath({ require_private: "false" })).toBe(false);
    expect(requiresPrivatePath({ requirePrivate: false })).toBe(false);
    expect(requiresPrivatePath({})).toBe(false);
    expect(requiresPrivatePath(null)).toBe(false);
  });
});

describe("a chat call is marked from the provider's saved configuration", () => {
  const chat = () =>
    streamWithProvider({
      userId: "u1",
      provider: "ollama",
      modelId: "llama3.1",
      messages: [{ role: "user", content: "hi" }],
    });
  const ollamaRow = (config: Record<string, unknown>) => [
    { is_active: true, updated_at: "2026-10-27T00:00:00Z", config },
  ];

  it("refuses and audits, sending nothing, when the row requires it and the host is public", async () => {
    answers["ollama.corp.example"] = ["52.94.0.10"];
    db.rows = ollamaRow({ endpoint: "http://ollama.corp.example:11434", require_private: "true" });
    await expect(chat()).rejects.toThrow(/Ollama is set to require a private network path/);
    expect(calls).toEqual([]);
    expect(vi.mocked(auditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "provider.private_path.refused", resourceName: "ollama" }),
    );
  });

  it("sends it when the host resolves privately", async () => {
    answers["ollama.corp.example"] = ["10.20.30.40"];
    db.rows = ollamaRow({ endpoint: "http://ollama.corp.example:11434", require_private: "true" });
    await chat();
    expect(calls).toEqual(["http://ollama.corp.example:11434/v1/chat/completions"]);
  });

  it("sends it to a public host when the row does not require it", async () => {
    answers["ollama.corp.example"] = ["52.94.0.10"];
    db.rows = ollamaRow({ endpoint: "http://ollama.corp.example:11434" });
    await chat();
    expect(calls).toHaveLength(1);
    expect(vi.mocked(auditEvent)).not.toHaveBeenCalled();
  });
});

describe("the transport preflight", () => {
  it("refuses a public endpoint, auditing it", async () => {
    answers["api.openai.com"] = ["104.18.6.192"];
    const audit = vi.fn();
    await expect(
      assertPrivatePath("https://api.openai.com/v1/chat/completions", "OpenAI", audit),
    ).rejects.toThrow(/OpenAI is set to require a private network path/);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("allows a private endpoint and a proxied one", async () => {
    answers["southcentralus.privatelink.api.openai.com"] = ["10.9.8.7"];
    await expect(
      assertPrivatePath("https://southcentralus.privatelink.api.openai.com/v1", "OpenAI"),
    ).resolves.toBeUndefined();
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp:3128");
    await expect(assertPrivatePath("https://api.openai.com/v1", "OpenAI")).resolves.toBeUndefined();
  });

  it("refuses an endpoint that does not resolve here", async () => {
    await expect(assertPrivatePath("https://nowhere.corp.example/v1", "OpenAI")).rejects.toThrow(
      /nowhere\.corp\.example does not resolve/,
    );
  });

  it("is applied to a resolved transport whose saved row requires it — and only then", async () => {
    answers["ollama.corp.example"] = ["52.94.0.10"];
    const endpoint = "http://ollama.corp.example:11434";
    const transport = () => resolveOpenAICompatTransport({ userId: "u1", provider: "ollama" });
    db.rows = [
      {
        is_active: true,
        updated_at: "2026-10-27T00:00:00Z",
        config: { endpoint, require_private: "true" },
      },
    ];
    await expect(transport()).rejects.toThrow(/Ollama is set to require a private network path/);
    expect(vi.mocked(auditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "provider.private_path.refused", resourceName: "ollama" }),
    );
    db.rows = [{ is_active: true, updated_at: "2026-10-27T00:00:00Z", config: { endpoint } }];
    expect((await transport())?.endpointUrl).toBe(`${endpoint}/v1/chat/completions`);
  });
});

describe("a connection test runs under the provider's rule", () => {
  it("fails, without calling the provider, when the endpoint resolves publicly", async () => {
    answers["vllm.example.com"] = ["52.94.0.10"];
    const r = await runProviderTest("vllm", {
      base_url: "https://vllm.example.com/v1",
      require_private: "true",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/require a private network path/);
    expect(calls).toEqual([]);
  });

  it("reports the refusal as a failed test, named for the provider, where the test does not catch", async () => {
    // testOpenAI lets a fetch error through; the runner turns the refusal into a result
    answers["api.openai.com"] = ["104.18.6.192"];
    const r = await runProviderTest("openai", { api_key: "sk-test", require_private: "true" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(
      /^OpenAI is set to require a private network path, but api\.openai\.com/,
    );
    expect(calls).toEqual([]);
  });

  it("passes, and says so, when it resolves privately", async () => {
    answers["vllm.internal.example"] = ["10.4.5.6"];
    const r = await runProviderTest("vllm", {
      base_url: "http://vllm.internal.example:8000/v1",
      require_private: "true",
    });
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).toMatch(/\(private\)$/);
  });
});

describe("wiring", () => {
  const server = readFileSync("src/utils/providers/credentials.server.ts", "utf8");
  const fns = readFileSync("src/utils/providers/credentials.functions.ts", "utf8");
  const integ = readFileSync("src/utils/integrations.functions.ts", "utf8");
  const panel = readFileSync("src/components/integrations/ProviderCredentialsPanel.tsx", "utf8");

  it("an encrypted credential marks the scope too, once its config is read", () => {
    // (legacy rows are covered by the chat-call tests above)
    expect(server).toMatch(
      /const config = row\.config as Record<string, unknown>;\s*markPrivatePath\(policy, userId, provider, config\);\s*switch \(provider\)/,
    );
  });

  it("new integrations start from the operator's default, existing ones never change", () => {
    expect(fns).toMatch(
      /requirePrivate: data\.bedrock\.requirePrivate \?\? requirePrivateDefault\(\)/,
    );
    expect(fns).toMatch(/process\.env\.GENAI_REQUIRE_PRIVATE/);
    expect(integ).toMatch(
      /data\.type === "llm_provider" && !data\.id && data\.config\.require_private === undefined/,
    );
  });

  it("the providers marked not-via-gateway are exactly those the server calls directly", () => {
    const set = (name: string) =>
      new Set(
        [
          ...(
            panel.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`))?.[1] ?? ""
          ).matchAll(/"([a-z_]+)"/g),
        ].map((m) => m[1]),
      );
    // every encrypted provider is dispatched directly, except anthropic, which the gateway carries
    expect(server).toMatch(/if \(gateway && provider === "anthropic"\)/);
    const direct = [...set("ENCRYPTED_PROVIDERS")].filter((p) => p !== "anthropic");
    expect(direct.length).toBeGreaterThan(0);
    expect(set("GATEWAY_BYPASS")).toEqual(new Set(direct));
    const page = readFileSync("src/routes/_authenticated/integrations.tsx", "utf8");
    const note = page
      .slice(page.indexOf('data-testid="gateway-route-all-exceptions"'))
      .slice(0, 600)
      .replace(/\s+/g, " ");
    for (const label of [
      "AWS Bedrock",
      "Google Vertex AI",
      "Azure OpenAI",
      "OCI Generative AI",
      "Claude Platform on AWS",
    ]) {
      expect(note, label).toContain(label);
    }
    // the cards read the route-all flag, never the gateway's key
    expect(panel).toMatch(
      /\.select\("is_active, route_all:config->route_all"\)\s*\.eq\("type", "llm_gateway"\)/,
    );
  });

  it("the dialog has the switch and sends the flag", () => {
    expect(panel).toMatch(/data-testid="require-private-switch"/);
    expect(panel).toMatch(/getPrivateConnectivityDefaults\(\)/);
    expect((panel.match(/requirePrivate: config\.require_private === "true"/g) ?? []).length).toBe(
      5, // bedrock, vertex, azure_openai, oci_genai, claude_aws
    );
  });
});
