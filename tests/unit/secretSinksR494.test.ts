// The credentials that became secrets in R494, each resolved where it is used.
//
// Web tool keys, MCP server tokens, Git tokens, Slack and Teams credentials,
// knowledge-base connectors, app sources and the encrypted LLM providers used
// to hold a key typed in. Each can now hold a `{{secret:NAME}}` instead. The
// rule is the resolver's (secretsOwnedOnly.test.ts): a secret the owner owns
// resolves anywhere; one shared with the owner resolves only toward hosts its
// owner allowed, and only where the call names them. These run the real
// resolver over a stand-in secrets table.
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

vi.mock("@/integrations/supabase/client.server", () => {
  const builder = () => {
    let name: string | undefined;
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (col: string, v: string) => {
        if (col === "name") name = v;
        return b;
      },
      then: (resolve: (v: { data: SecretRow[]; error: null }) => void) =>
        resolve({ data: secrets.filter((s) => s.name === name), error: null }),
    });
    return b;
  };
  return {
    supabaseAdmin: {
      from: () => builder(),
      rpc: async (_n: string, args: { rid: string }) => ({ data: granted.has(args.rid) }),
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

const { mcpBearerToken } = await import("@/lib/mcp/auth.server");
const { gitTokenForUse, gitTokenDestination } = await import("@/utils/git/token.server");
const { channelCredential } = await import("@/utils/channels/credential.server");
const { resolveSaasConfig } = await import("@/utils/saas/credentials.server");
const { encryptedSecretFields, encryptedSecretName } =
  await import("@/utils/credentialRefs.server");
const { saasCredentialHosts } = await import("@/utils/saas/origins");
const { SAAS_CARDS, saasSecretFields } = await import("@/utils/saas/catalog");
const { SAAS_PROVIDERS } = await import("@/utils/saas/types");
const { kbCredentialHosts } = await import("@/lib/kbCredentialHosts");
const { encryptedProviderHosts } = await import("@/utils/providers/credentialHosts");
const { webToolKeyHost } = await import("@/lib/webToolProviders");

/** A secret OTHER owns and shares with OWNER, allowed toward `hosts`. */
function shared(name: string, value: string, hosts: string[]) {
  const ct = `ct-${name}`;
  plaintext.set(ct, value);
  secrets.push({
    id: `id-${name}`,
    name,
    user_id: OTHER,
    value: { ciphertext: ct, iv: "iv" },
    allowed_hosts: hosts,
  });
  granted.add(`id-${name}`);
}
function owned(name: string, value: string) {
  const ct = `ct-own-${name}`;
  plaintext.set(ct, value);
  secrets.push({ id: `own-${name}`, name, user_id: OWNER, value: { ciphertext: ct, iv: "iv" } });
}
/** An encrypted blob whose decrypted value is `v`. */
function blob(v: unknown) {
  const ct = `blob-${plaintext.size}`;
  plaintext.set(ct, v);
  return { ciphertext: ct, iv: "iv" };
}

beforeEach(() => {
  secrets = [];
  granted = new Set();
  plaintext.clear();
});

describe("an MCP server's token", () => {
  const row = (token: string, endpoint = "https://mcp.example.com/mcp") => ({
    user_id: OWNER,
    endpoint,
    auth_token_enc: blob(token),
  });

  it("sends a token typed in before as it is", async () => {
    expect(await mcpBearerToken(row("tok-123"))).toBe("tok-123");
  });

  it("resolves the owner's own secret", async () => {
    owned("MCP_TOKEN", "own-value");
    expect(await mcpBearerToken(row("{{secret:MCP_TOKEN}}"))).toBe("own-value");
  });

  it("resolves a shared secret toward the server its owner allowed, sse:// as https", async () => {
    shared("MCP_TOKEN", "shared-value", ["mcp.example.com"]);
    expect(await mcpBearerToken(row("{{secret:MCP_TOKEN}}"))).toBe("shared-value");
    expect(await mcpBearerToken(row("{{secret:MCP_TOKEN}}", "sse://mcp.example.com/sse"))).toBe(
      "shared-value",
    );
  });

  it("refuses a shared secret toward any other server, rather than calling without it", async () => {
    shared("MCP_TOKEN", "shared-value", ["mcp.example.com"]);
    await expect(
      mcpBearerToken(row("{{secret:MCP_TOKEN}}", "https://evil.example.net/mcp")),
    ).rejects.toThrow(/not allowed it to be sent to evil\.example\.net/);
  });
});

describe("the Git access token", () => {
  it("goes to api.github.com, or the GitLab host the settings name", () => {
    expect(gitTokenDestination({ provider: "github", host: "https://ignored.example" })).toBe(
      "https://api.github.com",
    );
    expect(gitTokenDestination({ provider: "gitlab", host: null })).toBe("https://gitlab.com");
    expect(gitTokenDestination({ provider: "gitlab", host: "https://git.acme.io/" })).toBe(
      "https://git.acme.io",
    );
  });

  it("resolves a shared secret only toward that host", async () => {
    shared("GH", "ghp_shared", ["api.github.com"]);
    const ref = "{{secret:GH}}";
    expect(await gitTokenForUse(OWNER, { provider: "github", host: null }, ref)).toBe("ghp_shared");
    await expect(
      gitTokenForUse(OWNER, { provider: "gitlab", host: "https://git.acme.io" }, ref),
    ).rejects.toThrow(/git\.acme\.io/);
  });

  it("keeps a token typed in before", async () => {
    expect(await gitTokenForUse(OWNER, { provider: "github", host: null }, "ghp_raw")).toBe(
      "ghp_raw",
    );
  });
});

describe("Slack and Teams credentials", () => {
  it("a signing secret is never sent anywhere, so only the owner's own secret resolves", async () => {
    shared("SIGN", "shared-signing", ["slack.com"]);
    expect(await channelCredential("{{secret:SIGN}}", OWNER, "signing secret")).toBeNull();
    owned("SIGN2", "own-signing");
    expect(await channelCredential("{{secret:SIGN2}}", OWNER, "signing secret")).toBe(
      "own-signing",
    );
  });

  it("a bot token resolves a shared secret toward slack.com, and is null elsewhere", async () => {
    shared("BOT", "xoxb-shared", ["slack.com"]);
    expect(
      await channelCredential("{{secret:BOT}}", OWNER, "bot token", ["https://slack.com"]),
    ).toBe("xoxb-shared");
    expect(
      await channelCredential("{{secret:BOT}}", OWNER, "bot token", [
        "https://login.microsoftonline.com",
      ]),
    ).toBeNull();
  });
});

describe("an app source's config", () => {
  it("every provider has a credential field, and every one is a field it has", () => {
    for (const p of SAAS_PROVIDERS) {
      const keys = SAAS_CARDS[p].fields.map((f) => f.key);
      const secret = saasSecretFields(p);
      expect(secret.length, p).toBeGreaterThan(0);
      for (const k of secret) expect(keys, p).toContain(k);
    }
  });

  it("names where each provider's credentials go", () => {
    expect(saasCredentialHosts({ provider: "stripe" })).toEqual(["https://api.stripe.com"]);
    expect(
      saasCredentialHosts({ provider: "jira", site_url: "https://acme.atlassian.net/x" }),
    ).toEqual(["https://acme.atlassian.net"]);
    expect(saasCredentialHosts({ provider: "zendesk", subdomain: "Acme" })).toEqual([
      "https://acme.zendesk.com",
    ]);
    expect(saasCredentialHosts({ provider: "shopify", shop_domain: "acme" })).toEqual([
      "https://acme.myshopify.com",
    ]);
    // Not known yet: then only the owner's own secrets resolve.
    expect(saasCredentialHosts({ provider: "servicenow", instance: "" })).toEqual([]);
  });

  it("resolves a shared token toward the site the source names", async () => {
    shared("JIRA", "atatt-shared", ["acme.atlassian.net"]);
    const cfg = {
      provider: "jira" as const,
      site_url: "https://acme.atlassian.net",
      email: "a@b.c",
      api_token: "{{secret:JIRA}}",
    };
    expect((await resolveSaasConfig(OWNER, cfg)).api_token).toBe("atatt-shared");
    await expect(
      resolveSaasConfig(OWNER, { ...cfg, site_url: "https://evil.atlassian.net.example" }),
    ).rejects.toThrow(/not allowed/);
  });

  it("never lets a shared secret choose the site", async () => {
    shared("SITE", "https://evil.example", ["evil.example"]);
    await expect(
      resolveSaasConfig(OWNER, {
        provider: "jira",
        site_url: "{{secret:SITE}}",
        email: "a@b.c",
        api_token: "x",
      }),
    ).rejects.toThrow(/must be one you own/);
  });
});

describe("where the other credentials go", () => {
  it("web tool keys: the provider's own API, none for built-in Firecrawl", () => {
    expect(webToolKeyHost("brave")).toBe("api.search.brave.com");
    expect(webToolKeyHost("TAVILY")).toBe("api.tavily.com");
    expect(webToolKeyHost("scrapingbee")).toBe("app.scrapingbee.com");
    expect(webToolKeyHost("firecrawl_builtin")).toBeNull();
    expect(webToolKeyHost("constructor")).toBeNull();
  });

  it("knowledge-base connectors: fixed per provider, Confluence's own site", () => {
    expect(kbCredentialHosts("notion", {})).toEqual(["https://api.notion.com"]);
    expect(kbCredentialHosts("confluence", { site_url: "https://wiki.acme.io" })).toEqual([
      "https://wiki.acme.io",
    ]);
    expect(kbCredentialHosts("confluence", {})).toEqual([]);
    expect(kbCredentialHosts("web", {})).toEqual([]);
  });

  it("encrypted LLM providers: the endpoint the adapter calls, and Vertex's token server", () => {
    expect(encryptedProviderHosts("bedrock", { region: "eu-west-1" })).toEqual([
      "https://bedrock-runtime.eu-west-1.amazonaws.com",
    ]);
    expect(encryptedProviderHosts("vertex", { location: "europe-west4" })).toEqual([
      "https://europe-west4-aiplatform.googleapis.com",
      "https://oauth2.googleapis.com/token",
    ]);
    expect(
      encryptedProviderHosts("azure_openai", { endpoint: "https://acme.openai.azure.com" }),
    ).toEqual(["https://acme.openai.azure.com"]);
    // A region that is not one: nothing is known, so only owned secrets resolve.
    expect(encryptedProviderHosts("oci_genai", { region: "../evil" })).toEqual([]);
  });
});

describe("which secret a stored credential names", () => {
  it("returns names, never values", async () => {
    const enc = blob({ token: "{{secret:CONF}}", email: "a@b.c", client_secret: "raw-value" });
    expect(await encryptedSecretFields(enc)).toEqual({
      secrets: { token: "CONF" },
      raw: ["email", "client_secret"],
    });
    expect(await encryptedSecretName(blob({ token: "{{secret:GH}}" }), "token")).toBe("GH");
    expect(await encryptedSecretName(blob({ token: "ghp_raw" }), "token")).toBeNull();
    expect(await encryptedSecretName(null, "token")).toBeNull();
  });
});
