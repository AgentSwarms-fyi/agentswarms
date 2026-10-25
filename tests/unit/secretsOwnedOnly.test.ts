// A secret merely shared with you cannot be sent to an endpoint you choose.
//
// VA-2026-10-25-11. Sharing a secret by IAM grant is meant to let a grantee
// USE it without ever seeing its value (the resolution happens server-side).
// That invariant only holds while the grantee cannot also pick where the
// resolved value goes. Three paths let them pick: an a2a invoke (caller gives
// endpoint + auth header), and the live gateway / notification tests (caller
// gives the URL, the key/URL comes from their own saved config, which may hold
// a {{secret:NAME}} pointing at a shared secret). On those paths resolution now
// runs ownedOnly, so only a secret the caller OWNS resolves; a shared one is
// refused before anything leaves the box.
//
// The default (shared-allowed) path is unchanged — it is what the real chat,
// swarm and warehouse send paths rely on, where the endpoint is not the
// caller's to redirect at call time.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const CALLER = "00000000-0000-4000-8000-00000000ca11";
const OTHER = "00000000-0000-4000-8000-00000000050e";

type SecretRow = { id: string; user_id: string; value: { ciphertext: string; iv: string } };

let rows: SecretRow[] = [];
let grant = new Map<string, boolean>(); // secret row id -> has_resource_access
let rpcCalls = 0;

vi.mock("@/integrations/supabase/client.server", () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
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

const { resolveSecretRefs } = await import("@/utils/secrets.server");
const { resolveIntegrationConfig } = await import("@/utils/providers/integrationConfig.server");

const sharedSecret = (): SecretRow => ({
  id: "shared-1",
  user_id: OTHER,
  value: { ciphertext: "ct", iv: "iv" },
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
});

describe("resolveSecretRefs honours IAM grants by default", () => {
  it("resolves a secret shared with the caller by grant", async () => {
    rows = [sharedSecret()];
    grant.set("shared-1", true);
    const out = await resolveSecretRefs(CALLER, "Bearer {{secret:TOKEN}}");
    expect(out).toBe("Bearer PLAINTEXT_SECRET");
    expect(rpcCalls).toBeGreaterThan(0); // the grant WAS consulted
  });

  it("resolves a secret the caller owns", async () => {
    rows = [ownedSecret()];
    const out = await resolveSecretRefs(CALLER, "{{secret:TOKEN}}");
    expect(out).toBe("PLAINTEXT_SECRET");
  });
});

describe("ownedOnly refuses a secret that is only shared", () => {
  it("throws for a shared secret, naming that it must be owned", async () => {
    rows = [sharedSecret()];
    grant.set("shared-1", true); // the grant exists — and must not be honoured here
    await expect(
      resolveSecretRefs(CALLER, "Bearer {{secret:TOKEN}}", { ownedOnly: true }),
    ).rejects.toThrow(/must be one you own/i);
  });

  it("never even consults the grant (no exfil via a timing/record of the check)", async () => {
    rows = [sharedSecret()];
    grant.set("shared-1", true);
    await resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { ownedOnly: true }).catch(() => {});
    expect(rpcCalls).toBe(0);
  });

  it("still resolves a secret the caller owns", async () => {
    rows = [ownedSecret()];
    const out = await resolveSecretRefs(CALLER, "{{secret:TOKEN}}", { ownedOnly: true });
    expect(out).toBe("PLAINTEXT_SECRET");
    expect(rpcCalls).toBe(0); // own secret wins before any grant check
  });

  it("leaves a string with no references untouched", async () => {
    const out = await resolveSecretRefs(CALLER, "no refs here", { ownedOnly: true });
    expect(out).toBe("no refs here");
  });
});

describe("resolveIntegrationConfig forwards ownedOnly", () => {
  it("resolves a shared {{secret}} in config by default", async () => {
    rows = [sharedSecret()];
    grant.set("shared-1", true);
    const cfg = await resolveIntegrationConfig(CALLER, "llm_gateway", {
      api_key: "{{secret:TOKEN}}",
    });
    expect(cfg.api_key).toBe("PLAINTEXT_SECRET");
  });

  it("refuses a shared {{secret}} in config under ownedOnly", async () => {
    rows = [sharedSecret()];
    grant.set("shared-1", true);
    await expect(
      resolveIntegrationConfig(
        CALLER,
        "llm_gateway",
        { api_key: "{{secret:TOKEN}}" },
        { ownedOnly: true },
      ),
    ).rejects.toThrow(/must be one you own/i);
  });
});

describe("the caller-chosen-endpoint sinks pass ownedOnly", () => {
  const a2a = readFileSync("src/routes/api/a2a.ts", "utf8");
  const integrations = readFileSync("src/utils/integrations.functions.ts", "utf8");

  it("a2a invoke resolves the auth header ownedOnly", () => {
    expect(a2a).toMatch(
      /resolveSecretRefs\(\s*userId,\s*payload\.remoteAuthHeader,\s*\{\s*ownedOnly:\s*true\s*\}/,
    );
  });

  it("testLlmGateway resolves its saved key ownedOnly", () => {
    const block = integrations.slice(
      integrations.indexOf("export const testLlmGateway"),
      integrations.indexOf("export const testNotificationChannel"),
    );
    expect(block).toContain('"llm_gateway"');
    expect(block).toMatch(/ownedOnly:\s*true/);
  });

  it("testNotificationChannel resolves its saved webhook ownedOnly", () => {
    const block = integrations.slice(integrations.indexOf("export const testNotificationChannel"));
    expect(block).toContain('"notification"');
    expect(block).toMatch(/ownedOnly:\s*true/);
  });
});
