// A connection's Test resolves a picked secret the way its run will (R493).
//
// The Integrations page's key fields are secret pickers now, so the form holds
// `{{secret:NAME}}` where a pasted key used to be. The Test buttons sent the
// form's text to the provider as it stood: the reference itself went out as
// the API key, every test of a picked secret failed, and a connection could
// not be saved active. Each Test now resolves the form the way the saved
// connection resolves at run time (resolveIntegrationConfig with
// integrationHosts): a secret the caller owns anywhere; one shared with them
// only in a key field, and only toward a host its owner allowed; a webhook URL
// only from a secret the caller owns. The real resolver runs here, over a
// stand-in secrets table, as in sharedSecretSinks.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

type SecretRow = {
  id: string;
  name: string;
  user_id: string;
  value: { ciphertext: string; iv: string };
  allowed_hosts?: string[];
};
let secrets: SecretRow[] = [];
let granted = new Set<string>();
const plaintext = new Map<string, unknown>();
/** Saved integration configs by type, as the n8n and gateway fallbacks read them. */
let saved: Record<string, Record<string, unknown>> = {};
/** What each test adapter was handed: what would have been sent. */
let sent: { adapter: string; args: unknown[] }[] = [];

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));
vi.mock("@supabase/supabase-js", async (orig) => ({
  ...(await orig<typeof import("@supabase/supabase-js")>()),
  createClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: OWNER } }, error: null }) },
  }),
}));
vi.mock("@/utils/rateLimit.server", () => ({
  rateLimited: () => false,
  envInt: (_name: string, fallback: number) => fallback,
}));
vi.mock("@/utils/integrations/testAdapters.server", () => {
  const record =
    (adapter: string) =>
    async (...args: unknown[]) => {
      sent.push({ adapter, args });
      return { ok: true, detail: "reached" };
    };
  return {
    runProviderTest: record("provider"),
    testN8nCore: record("n8n"),
    testFirecrawlCore: record("firecrawl"),
    testGatewayCore: record("gateway"),
    testNotificationCore: record("notification"),
  };
});
vi.mock("@/integrations/supabase/client.server", () => {
  const builder = (table: string) => {
    const eqs: Record<string, string> = {};
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (col: string, v: string) => {
        eqs[col] = v;
        return b;
      },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({
        data: table === "integrations" && saved[eqs.type] ? { config: saved[eqs.type] } : null,
        error: null,
      }),
      then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
        resolve({
          data:
            table === "integrations"
              ? saved[eqs.type]
                ? [{ config: saved[eqs.type] }]
                : []
              : secrets.filter((s) => s.name === eqs.name),
          error: null,
        }),
    });
    return b;
  };
  return {
    supabaseAdmin: {
      from: (table: string) => builder(table),
      rpc: async (_n: string, args: { rid: string; uid: string }) => ({
        data: args.uid === OWNER && granted.has(args.rid),
      }),
    },
  };
});
vi.mock("@/utils/providers/crypto.server", () => ({
  decryptJson: async (ct: string) => {
    if (!plaintext.has(ct)) throw new Error(`no plaintext for ${ct}`);
    return plaintext.get(ct);
  },
  encryptJson: async () => ({ ciphertext: "ct", iv: "iv" }),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));

process.env.SUPABASE_URL ??= "http://supabase.test";
process.env.SUPABASE_PUBLISHABLE_KEY ??= "publishable";

const {
  testIntegrationKey,
  testLlmGateway,
  testN8nInstance,
  testFirecrawlKey,
  testNotificationChannel,
} = await import("@/utils/integrations.functions");

function owned(name: string, value: string) {
  plaintext.set(`ct-own-${name}`, value);
  secrets.push({
    id: `own-${name}`,
    name,
    user_id: OWNER,
    value: { ciphertext: `ct-own-${name}`, iv: "iv" },
  });
}
function shared(name: string, value: string, hosts: string[]) {
  plaintext.set(`ct-${name}`, value);
  secrets.push({
    id: `id-${name}`,
    name,
    user_id: OTHER,
    value: { ciphertext: `ct-${name}`, iv: "iv" },
    allowed_hosts: hosts,
  });
  granted.add(`id-${name}`);
}
const lastSent = (adapter: string) => sent.filter((s) => s.adapter === adapter).at(-1)?.args;

beforeEach(() => {
  secrets = [];
  granted = new Set();
  plaintext.clear();
  saved = {};
  sent = [];
});

describe("an LLM provider's Test", () => {
  const test = (config: Record<string, string>) =>
    testIntegrationKey({ data: { provider: "openai", access_token: "jwt", config } });

  it("sends the value of a secret you own, never the reference", async () => {
    owned("OPENAI_KEY", "sk-mine");
    expect(await test({ api_key: "{{secret:OPENAI_KEY}}" })).toEqual({
      ok: true,
      detail: "reached",
    });
    expect(lastSent("provider")).toEqual(["openai", { api_key: "sk-mine" }]);
  });

  it("sends a shared secret toward the provider its owner allowed", async () => {
    shared("TEAM_OPENAI", "sk-team", ["api.openai.com"]);
    await test({ api_key: "{{ secret:TEAM_OPENAI }}" });
    expect(lastSent("provider")).toEqual(["openai", { api_key: "sk-team" }]);
  });

  it("refuses a shared secret toward a base URL its owner did not allow, before sending", async () => {
    shared("TEAM_OPENAI", "sk-team", ["api.openai.com"]);
    const r = await test({
      api_key: "{{secret:TEAM_OPENAI}}",
      base_url: "https://evil.example/v1",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/has not allowed it to be sent to evil\.example/);
    expect(sent).toEqual([]);
  });

  it("re-tests with the saved key when the field is left as it is", async () => {
    // A key saved directly is never sent back to the form, whose picker then
    // says one is saved; testing must not mean testing with no key.
    plaintext.set("ct-saved-openai", "sk-saved");
    saved.llm_provider = { api_key_enc: { ciphertext: "ct-saved-openai", iv: "iv" } };
    await test({ api_key: "" });
    expect(lastSent("provider")).toEqual(["openai", { api_key: "sk-saved" }]);
  });

  it("re-tests a saved shared secret only toward a host its owner allowed", async () => {
    shared("TEAM_OPENAI", "sk-team", ["api.openai.com"]);
    saved.llm_provider = { api_key: "{{secret:TEAM_OPENAI}}" };
    const r = await test({ api_key: "", base_url: "https://evil.example/v1" });
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("names a secret that is not there", async () => {
    const r = await test({ api_key: "{{secret:NO_SUCH_KEY}}" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("NO_SUCH_KEY");
    expect(sent).toEqual([]);
  });

  it("passes a form with no reference through untouched", async () => {
    await test({ api_key: "sk-typed", organization_id: "org-1" });
    expect(lastSent("provider")).toEqual([
      "openai",
      { api_key: "sk-typed", organization_id: "org-1" },
    ]);
  });
});

describe("the gateway's Test", () => {
  const test = (api_key: string, base_url = "https://gw.example/v1") =>
    testLlmGateway({ data: { access_token: "jwt", base_url, api_key, provider: "litellm" } });

  it("resolves a picked key toward the gateway URL", async () => {
    shared("GW_KEY", "gw-secret", ["gw.example"]);
    await test("{{secret:GW_KEY}}");
    expect(lastSent("gateway")).toEqual([
      { base_url: "https://gw.example/v1", api_key: "gw-secret", provider: "litellm" },
    ]);
  });

  it("refuses it toward a gateway its owner did not allow", async () => {
    shared("GW_KEY", "gw-secret", ["gw.example"]);
    const r = await test("{{secret:GW_KEY}}", "https://other.example/v1");
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("n8n's Test", () => {
  const test = (webhook_token: string, auth_type: "header" | "basic" | "none" = "header") =>
    testN8nInstance({
      data: { access_token: "jwt", instance_url: "https://n8n.example", webhook_token, auth_type },
    });

  it("resolves a picked token toward the instance", async () => {
    shared("N8N_KEY", "n8n_api_team", ["n8n.example"]);
    await test("{{secret:N8N_KEY}}");
    expect(lastSent("n8n")).toEqual([
      { instance_url: "https://n8n.example", webhook_token: "n8n_api_team", auth_type: "header" },
    ]);
  });

  it("re-tests with the saved token when the field is left as it is", async () => {
    // A token kept encrypted from before is never shown, so the field is blank;
    // testing must not mean testing with no token, which would mark it failed.
    plaintext.set("ct-saved", "n8n_api_saved");
    saved.n8n = {
      instance_url: "https://n8n.example",
      webhook_token_enc: { ciphertext: "ct-saved", iv: "iv" },
    };
    await test("");
    expect(lastSent("n8n")).toEqual([
      { instance_url: "https://n8n.example", webhook_token: "n8n_api_saved", auth_type: "header" },
    ]);
  });

  it("sends no token for an instance without authentication", async () => {
    plaintext.set("ct-saved", "n8n_api_saved");
    saved.n8n = { webhook_token_enc: { ciphertext: "ct-saved", iv: "iv" } };
    await test("", "none");
    expect(lastSent("n8n")).toEqual([
      { instance_url: "https://n8n.example", webhook_token: "", auth_type: "none" },
    ]);
  });
});

describe("Firecrawl's Test", () => {
  it("resolves a picked key toward Firecrawl only", async () => {
    shared("FC", "fc-team", ["api.firecrawl.dev"]);
    await testFirecrawlKey({ data: { access_token: "jwt", api_key: "{{secret:FC}}" } });
    expect(lastSent("firecrawl")).toEqual(["fc-team"]);

    sent = [];
    shared("FC_ELSEWHERE", "fc-other", ["example.com"]);
    const r = await testFirecrawlKey({
      data: { access_token: "jwt", api_key: "{{secret:FC_ELSEWHERE}}" },
    });
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("a notification channel's Test", () => {
  const test = (webhook_url: string) =>
    testNotificationChannel({ data: { access_token: "jwt", provider: "slack", webhook_url } });

  it("resolves a webhook URL from a secret you own", async () => {
    owned("SLACK_HOOK", "https://hooks.slack.com/services/T/B/x");
    await test("{{secret:SLACK_HOOK}}");
    expect(lastSent("notification")).toEqual(["slack", "https://hooks.slack.com/services/T/B/x"]);
  });

  it("refuses one shared with you, whatever hosts its owner allowed", async () => {
    // The URL is where the post goes and the credential at once: sending a
    // shared one wherever the caller says would hand it to them.
    shared("TEAM_HOOK", "https://hooks.slack.com/services/T/B/y", ["hooks.slack.com"]);
    const r = await test("{{secret:TEAM_HOOK}}");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/must be one you own/);
    expect(sent).toEqual([]);
  });
});
