// A secret shared with you goes only where its owner allowed.
//
// VA-2026-10-25-11 (R380) found three paths where the caller picks the
// endpoint (an a2a invoke, the live gateway and notification tests) and made
// them owner-only. VA-2026-10-25-28 (R382) found the endpoint-less sibling: an
// MCP app's secret_refs resolve into a sandbox env whose code the owner writes.
//
// VA-2026-10-25-30 (R419) showed that the caller picks the endpoint almost
// everywhere — in every config they write — so the rule moved into the
// resolver itself. A secret you OWN resolves wherever you use it. A secret
// SHARED with you resolves only when the call names where the value goes
// (`sendTo`) and its owner allowed every one of those hosts. A call that names
// no destination — a URL, a body, a sandbox env — takes owned secrets only,
// without even consulting the grant: that is the old `ownedOnly`, and it is
// now the default, so a path nobody wired cannot leak.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const CALLER = "00000000-0000-4000-8000-00000000ca11";
const OTHER = "00000000-0000-4000-8000-00000000050e";

type SecretRow = {
  id: string;
  user_id: string;
  value: { ciphertext: string; iv: string };
  allowed_hosts?: string[];
};

let rows: SecretRow[] = [];
let grant = new Map<string, boolean>(); // secret row id -> has_resource_access
let rpcCalls = 0;
let selected: string[] = [];

vi.mock("@/integrations/supabase/client.server", () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: (cols: string) => {
        selected.push(cols);
        return b;
      },
      eq: () => b,
      then: (resolve: (v: { data: SecretRow[]; error: null }) => void) =>
        resolve({ data: rows, error: null }),
    });
    return b;
  };
  return {
    supabaseAdmin: {
      from: () => builder(),
      rpc: async (_name: string, args: { rid: string }) => {
        rpcCalls++;
        return { data: grant.get(args.rid) ?? false };
      },
    },
  };
});

// decryptJson is only reached once a row is chosen; return a marker plaintext.
vi.mock("@/utils/providers/crypto.server", () => ({
  decryptJson: async () => "PLAINTEXT_SECRET",
  encryptJson: async () => ({ ciphertext: "ct", iv: "iv" }),
}));

const { resolveSecretRefs, resolveCredentialConfig } = await import("@/utils/secrets.server");
const { resolveIntegrationConfig } = await import("@/utils/providers/integrationConfig.server");

const sharedSecret = (allowed_hosts?: string[]): SecretRow => ({
  id: "shared-1",
  user_id: OTHER,
  value: { ciphertext: "ct", iv: "iv" },
  ...(allowed_hosts ? { allowed_hosts } : {}),
});
const ownedSecret = (): SecretRow => ({
  id: "owned-1",
  user_id: CALLER,
  value: { ciphertext: "ct", iv: "iv" },
});

beforeEach(() => {
  rows = [];
  grant = new Map();
  rpcCalls = 0;
  selected = [];
});

describe("a secret the caller owns", () => {
  it("resolves with no destination, and toward any host", async () => {
    rows = [ownedSecret()];
    expect(await resolveSecretRefs(CALLER, "{{secret:TOKEN}}")).toBe("PLAINTEXT_SECRET");
    expect(
      await resolveSecretRefs(CALLER, "Bearer {{secret:TOKEN}}", { sendTo: ["evil.test"] }),
    ).toBe("Bearer PLAINTEXT_SECRET");
    expect(rpcCalls).toBe(0); // own secret wins before any grant check
  });

  it("leaves a string with no references untouched", async () => {
    expect(await resolveSecretRefs(CALLER, "no refs here")).toBe("no refs here");
  });

  it("is read with `*`, so a database without the allowed-hosts column still resolves it", async () => {
    rows = [ownedSecret()];
    await resolveSecretRefs(CALLER, "{{secret:TOKEN}}");
    expect(selected).toEqual(["*"]);
  });
});

describe("a shared secret with no destination named (the default)", () => {
  it("is refused, saying it must be owned", async () => {
    rows = [sharedSecret(["api.example.com"])];
    grant.set("shared-1", true); // the grant exists — and must not be honoured here
    await expect(resolveSecretRefs(CALLER, "Bearer {{secret:TOKEN}}")).rejects.toThrow(
      /must be one you own/i,
    );
  });

  it("never even consults the grant (no record of a check a caller could probe)", async () => {
    rows = [sharedSecret(["api.example.com"])];
    grant.set("shared-1", true);
    await resolveSecretRefs(CALLER, "{{secret:TOKEN}}").catch(() => {});
    await resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { sendTo: [] }).catch(() => {});
    expect(rpcCalls).toBe(0);
  });

  it("treats a destination that does not parse as none at all", async () => {
    rows = [sharedSecret(["api.example.com"])];
    grant.set("shared-1", true);
    await expect(
      resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { sendTo: ["api.example.com", "%%%"] }),
    ).rejects.toThrow(/must be one you own/i);
    expect(rpcCalls).toBe(0);
  });
});

describe("a shared secret toward named hosts", () => {
  it("resolves when its owner allowed the host", async () => {
    rows = [sharedSecret(["api.example.com"])];
    grant.set("shared-1", true);
    const out = await resolveSecretRefs(CALLER, "Bearer {{secret:TOKEN}}", {
      sendTo: ["https://api.example.com/v1/x"],
    });
    expect(out).toBe("Bearer PLAINTEXT_SECRET");
    expect(rpcCalls).toBeGreaterThan(0);
  });

  it("matches a wildcard entry", async () => {
    rows = [sharedSecret(["*.snowflakecomputing.com"])];
    grant.set("shared-1", true);
    expect(
      await resolveSecretRefs(CALLER, "{{secret:TOKEN}}", {
        sendTo: ["acme.snowflakecomputing.com"],
      }),
    ).toBe("PLAINTEXT_SECRET");
  });

  it("is refused toward a host its owner did not allow, naming the host and the list", async () => {
    rows = [sharedSecret(["api.example.com"])];
    grant.set("shared-1", true);
    const err = await resolveSecretRefs(CALLER, "{{secret:TOKEN}}", {
      sendTo: ["https://attacker.test/collect"],
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not allowed it to be sent to attacker\.test/);
    expect((err as Error).message).toMatch(/It may be sent to: api\.example\.com/);
    expect((err as Error).message).not.toContain("PLAINTEXT_SECRET");
  });

  it("needs EVERY destination allowed", async () => {
    rows = [sharedSecret(["api.example.com"])];
    grant.set("shared-1", true);
    await expect(
      resolveSecretRefs(CALLER, "{{secret:TOKEN}}", {
        sendTo: ["api.example.com", "attacker.test"],
      }),
    ).rejects.toThrow(/attacker\.test/);
  });

  it("is refused when its owner allowed no host, or the column is not there yet", async () => {
    rows = [sharedSecret([])];
    grant.set("shared-1", true);
    await expect(
      resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { sendTo: ["api.example.com"] }),
    ).rejects.toThrow(/have not allowed any host yet/);
    rows = [sharedSecret()]; // pre-migration row: no allowed_hosts at all
    await expect(
      resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { sendTo: ["api.example.com"] }),
    ).rejects.toThrow(/have not allowed any host yet/);
  });

  it("is refused without a grant, and two shared secrets of one name are ambiguous", async () => {
    rows = [sharedSecret(["api.example.com"])];
    await expect(
      resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { sendTo: ["api.example.com"] }),
    ).rejects.toThrow(/not found or you don't have access/);
    rows = [sharedSecret(["api.example.com"]), { ...sharedSecret(["api.example.com"]), id: "s2" }];
    grant.set("shared-1", true);
    grant.set("s2", true);
    await expect(
      resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { sendTo: ["api.example.com"] }),
    ).rejects.toThrow(/ambiguous/);
  });
});

describe("a config: credential fields may take a shared secret, the rest may not", () => {
  it("resolves a shared key toward the host its endpoint names", async () => {
    rows = [sharedSecret(["store.example.com"])];
    grant.set("shared-1", true);
    const out = await resolveCredentialConfig(
      CALLER,
      { endpoint: "https://store.example.com", secret_access_key: "{{secret:TOKEN}}" },
      ["secret_access_key"],
      (c) => [c.endpoint],
    );
    expect(out.secret_access_key).toBe("PLAINTEXT_SECRET");
  });

  it("refuses a shared secret in a field that decides the destination", async () => {
    rows = [sharedSecret(["store.example.com"])];
    grant.set("shared-1", true);
    await expect(
      resolveCredentialConfig(
        CALLER,
        { endpoint: "https://attacker.test/{{secret:TOKEN}}", secret_access_key: "x" },
        ["secret_access_key"],
        (c) => [c.endpoint],
      ),
    ).rejects.toThrow(/must be one you own/);
  });

  it("checks the key against the endpoint as resolved, and owner-only if that cannot be read", async () => {
    rows = [sharedSecret(["store.example.com"])];
    grant.set("shared-1", true);
    await expect(
      resolveCredentialConfig(
        CALLER,
        { endpoint: "https://attacker.test", secret_access_key: "{{secret:TOKEN}}" },
        ["secret_access_key"],
        (c) => [c.endpoint],
      ),
    ).rejects.toThrow(/attacker\.test/);
    await expect(
      resolveCredentialConfig(
        CALLER,
        { endpoint: "", secret_access_key: "{{secret:TOKEN}}" },
        ["secret_access_key"],
        () => {
          throw new Error("bad endpoint");
        },
      ),
    ).rejects.toThrow(/must be one you own/);
  });
});

describe("resolveIntegrationConfig", () => {
  it("resolves a shared API key toward the base URL when the owner allowed it", async () => {
    rows = [sharedSecret(["gw.example.com"])];
    grant.set("shared-1", true);
    const cfg = await resolveIntegrationConfig(
      CALLER,
      "llm_gateway",
      { base_url: "https://gw.example.com/v1", api_key: "{{secret:TOKEN}}" },
      { sendTo: (c) => [String(c.base_url)] },
    );
    expect(cfg.api_key).toBe("PLAINTEXT_SECRET");
  });

  it("refuses it with no destination, and in the base URL itself", async () => {
    rows = [sharedSecret(["gw.example.com"])];
    grant.set("shared-1", true);
    await expect(
      resolveIntegrationConfig(CALLER, "llm_gateway", { api_key: "{{secret:TOKEN}}" }),
    ).rejects.toThrow(/must be one you own/i);
    await expect(
      resolveIntegrationConfig(
        CALLER,
        "llm_gateway",
        { base_url: "{{secret:TOKEN}}", api_key: "k" },
        { sendTo: (c) => [String(c.base_url)] },
      ),
    ).rejects.toThrow(/must be one you own/i);
  });

  it("never lets a shared secret be a notification's webhook URL", async () => {
    // The URL is the destination and the credential at once.
    rows = [sharedSecret(["hooks.slack.com"])];
    grant.set("shared-1", true);
    await expect(
      resolveIntegrationConfig(
        CALLER,
        "notification",
        { webhook_url: "{{secret:TOKEN}}" },
        { sendTo: () => ["hooks.slack.com"] },
      ),
    ).rejects.toThrow(/must be one you own/i);
  });
});

// Mirror of mcpAppBundle's loop (src/routes/api/notebook.runtime.source.ts):
// each KEY={{secret:NAME}} binding is resolved with no destination, and a
// binding that throws is dropped so the server still starts. The source pin
// below holds the real route to exactly this shape.
const MCP_BINDING_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(\{\{\s*secret:[A-Za-z][A-Za-z0-9_]*\s*\}\})$/;
async function mcpBundleEnv(userId: string, secretRefs: string[]): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const binding of secretRefs) {
    const m = MCP_BINDING_RE.exec(String(binding).trim());
    if (!m) continue;
    try {
      env[m[1]] = await resolveSecretRefs(userId, m[2]);
    } catch {
      /* dropped — surfaced inside the tool, not here */
    }
  }
  return env;
}

describe("the MCP-app sandbox env drops a shared secret (VA-2026-10-25-28)", () => {
  it("drops a binding whose secret is only shared, even toward allowed hosts", async () => {
    rows = [sharedSecret(["api.example.com"])];
    grant.set("shared-1", true); // the grant exists and still must not be honoured
    const env = await mcpBundleEnv(CALLER, ["LEAK={{secret:TOKEN}}"]);
    expect(env.LEAK).toBeUndefined();
    expect(rpcCalls).toBe(0);
  });

  it("keeps a binding whose secret the owner owns", async () => {
    rows = [ownedSecret()];
    const env = await mcpBundleEnv(CALLER, ["OK={{secret:TOKEN}}"]);
    expect(env.OK).toBe("PLAINTEXT_SECRET");
  });

  it("skips a malformed binding without resolving anything", async () => {
    rows = [ownedSecret()];
    const env = await mcpBundleEnv(CALLER, ["NOT A BINDING", "={{secret:TOKEN}}"]);
    expect(env).toEqual({});
  });
});

describe("the sinks name their destination, or none", () => {
  const mcp = readFileSync("src/routes/api/notebook.runtime.source.ts", "utf8");
  const a2a = readFileSync("src/routes/api/a2a.ts", "utf8");
  const integrations = readFileSync("src/utils/integrations.functions.ts", "utf8");

  it("mcpAppBundle resolves each secret_refs binding with no destination", () => {
    expect(mcp).toMatch(/for \(const binding of app\.secret_refs/);
    expect(mcp).toMatch(/env\[m\[1\]\] = await resolveSecretRefs\(userId, m\[2\]\);/);
  });

  it("a2a invoke sends a shared auth header only toward the endpoint's host", () => {
    expect(a2a).toMatch(
      /resolveSecretRefs\(\s*userId,\s*payload\.remoteAuthHeader,\s*\{\s*sendTo:\s*\[v\.url\.href\],?\s*\}/,
    );
  });

  it("testLlmGateway resolves its saved key toward the base URL it tests", () => {
    const block = integrations.slice(
      integrations.indexOf("export const testLlmGateway"),
      integrations.indexOf("export const testNotificationChannel"),
    );
    expect(block).toContain('"llm_gateway"');
    expect(block).toMatch(/sendTo:\s*\(\)\s*=>\s*\[data\.base_url\]/);
  });

  it("testNotificationChannel resolves its saved webhook with no destination", () => {
    const block = integrations.slice(integrations.indexOf("export const testNotificationChannel"));
    expect(block).toContain('"notification"');
    expect(block.slice(0, block.indexOf("testNotificationCore"))).not.toMatch(/sendTo/);
  });
});
