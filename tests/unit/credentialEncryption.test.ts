// Credential encryption at rest (AES-256-GCM) and the integrations config that
// uses it.
//
// This had NO coverage, which is the wrong amount for the code that decides
// whether customer API keys sit in the database in plaintext. Every assertion
// here was checked by breaking the thing on purpose first — a test that cannot
// fail is indistinguishable from one that works, and nowhere is that more true
// than in crypto, where the happy path looks identical either way.
//
// Nothing is re-implemented: these call the real production functions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptJson, encryptJson, maskSecret } from "@/utils/providers/crypto.server";
import {
  encryptIntegrationConfig,
  integrationSecretFields,
  preserveBlankSecrets,
  resolveIntegrationConfig,
} from "@/utils/providers/integrationConfig.server";

const SECRET = "test-secret-do-not-use-in-production";
const original = process.env.PROVIDER_CREDS_SECRET;

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = SECRET;
});
afterEach(() => {
  if (original === undefined) delete process.env.PROVIDER_CREDS_SECRET;
  else process.env.PROVIDER_CREDS_SECRET = original;
});

describe("AES-GCM round trip", () => {
  it("returns exactly what was encrypted", async () => {
    const { ciphertext, iv } = await encryptJson("sk-live-abc123");
    expect(await decryptJson<string>(ciphertext, iv)).toBe("sk-live-abc123");
  });

  it("survives unicode, newlines and quotes — real keys and PEM blobs contain them", async () => {
    const value = 'a"b\\c\n—Zürich—\t{"nested":"json"}';
    const { ciphertext, iv } = await encryptJson(value);
    expect(await decryptJson<string>(ciphertext, iv)).toBe(value);
  });

  it("round-trips a structured payload, not just strings", async () => {
    const payload = { user: "a", scopes: ["x", "y"], n: 42, nested: { deep: true } };
    const { ciphertext, iv } = await encryptJson(payload);
    expect(await decryptJson(ciphertext, iv)).toEqual(payload);
  });

  it("never stores the plaintext in the ciphertext it produces", async () => {
    const { ciphertext, iv } = await encryptJson("sk-live-abc123");
    expect(ciphertext).not.toContain("sk-live");
    expect(iv).not.toContain("sk-live");
  });
});

describe("what makes it actually encryption and not encoding", () => {
  it("produces different ciphertext each time for the SAME plaintext", async () => {
    // A fresh random IV per encryption. Without it, identical values produce
    // identical ciphertext and anyone with read access to the table learns
    // which users share a key — and GCM with a reused IV is catastrophically
    // broken, not merely weaker.
    const a = await encryptJson("same-value");
    const b = await encryptJson("same-value");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    // Both still decrypt.
    expect(await decryptJson<string>(a.ciphertext, a.iv)).toBe("same-value");
    expect(await decryptJson<string>(b.ciphertext, b.iv)).toBe("same-value");
  });

  it("uses a 96-bit IV, the size GCM is specified for", async () => {
    const { iv } = await encryptJson("x");
    expect(atob(iv).length).toBe(12);
  });

  it("REJECTS tampered ciphertext rather than returning garbage", async () => {
    // The authentication half of authenticated encryption. If this ever stops
    // throwing, someone with write access to the row can alter a stored
    // credential and the app will use whatever comes out.
    const { ciphertext, iv } = await encryptJson("sk-live-abc123");
    const bytes = atob(ciphertext).split("");
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 0xff);
    const tampered = btoa(bytes.join(""));
    await expect(decryptJson(tampered, iv)).rejects.toThrow();
  });

  it("rejects a tampered IV", async () => {
    const { ciphertext, iv } = await encryptJson("sk-live-abc123");
    const bytes = atob(iv).split("");
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 0xff);
    await expect(decryptJson(ciphertext, btoa(bytes.join("")))).rejects.toThrow();
  });

  it("cannot be decrypted with a different secret", async () => {
    const { ciphertext, iv } = await encryptJson("sk-live-abc123");
    process.env.PROVIDER_CREDS_SECRET = "a-completely-different-secret";
    await expect(decryptJson(ciphertext, iv)).rejects.toThrow();
  });

  it("refuses to operate at all with no secret configured", async () => {
    // Must fail loudly. Silently falling back to storing plaintext would be
    // the worst possible outcome and would look like everything is fine.
    delete process.env.PROVIDER_CREDS_SECRET;
    await expect(encryptJson("x")).rejects.toThrow(/PROVIDER_CREDS_SECRET/);
    await expect(decryptJson("aaaa", "bbbb")).rejects.toThrow(/PROVIDER_CREDS_SECRET/);
  });
});

describe("maskSecret", () => {
  it("reveals only the last four characters", () => {
    expect(maskSecret("sk-live-abcdefgh")).toBe("••••efgh");
  });

  it("reveals nothing at all from a short secret", () => {
    // Four characters or fewer: showing "the last 4" would be the whole thing.
    expect(maskSecret("abcd")).toBe("••••");
    expect(maskSecret("a")).toBe("••••");
  });

  it("handles absent values without printing 'undefined'", () => {
    expect(maskSecret(undefined)).toBe("");
    expect(maskSecret(null)).toBe("");
    expect(maskSecret("")).toBe("");
  });
});

describe("encryptIntegrationConfig", () => {
  it("REMOVES the plaintext field, not merely adds a ciphertext beside it", async () => {
    // The actual security property. Leaving `api_key` in place next to
    // `api_key_enc` would mean the row still contains the key in the clear
    // while looking encrypted from the outside.
    const out = await encryptIntegrationConfig("llm_provider", {
      api_key: "sk-live-abc123",
      base_url: "https://api.example.com",
    });
    expect(out.api_key).toBeUndefined();
    expect(out.api_key_enc).toBeDefined();
    expect(JSON.stringify(out)).not.toContain("sk-live-abc123");
    // Non-secret fields are untouched.
    expect(out.base_url).toBe("https://api.example.com");
  });

  it("encrypts to something that decrypts back", async () => {
    const out = await encryptIntegrationConfig("llm_provider", { api_key: "sk-live-abc123" });
    const blob = out.api_key_enc as { ciphertext: string; iv: string };
    expect(await decryptJson<string>(blob.ciphertext, blob.iv)).toBe("sk-live-abc123");
  });

  it("clears stale ciphertext before re-encrypting", async () => {
    // Re-saving with a new key must not leave the OLD ciphertext recoverable.
    const first = await encryptIntegrationConfig("llm_provider", { api_key: "old-key" });
    const second = await encryptIntegrationConfig("llm_provider", {
      ...first,
      api_key: "new-key",
    });
    const blob = second.api_key_enc as { ciphertext: string; iv: string };
    expect(await decryptJson<string>(blob.ciphertext, blob.iv)).toBe("new-key");
    expect(second.api_key).toBeUndefined();
  });

  it("drops an empty secret rather than persisting it", async () => {
    // An empty string only ever means "keep the existing secret". Storing it
    // would leave a vestigial plaintext field beside the ciphertext.
    const out = await encryptIntegrationConfig("llm_provider", { api_key: "" });
    expect("api_key" in out).toBe(false);
    expect(out.api_key_enc).toBeUndefined();
  });

  it("leaves a {{secret:NAME}} reference alone — a pointer is not a secret", async () => {
    const out = await encryptIntegrationConfig("llm_provider", { api_key: "{{secret:OPENAI}}" });
    expect(out.api_key).toBe("{{secret:OPENAI}}");
    expect(out.api_key_enc).toBeUndefined();
  });

  it("encrypts a notification webhook URL — possession of it is permission to post", async () => {
    const out = await encryptIntegrationConfig("notification", {
      webhook_url: "https://hooks.slack.com/services/T/B/XXXX",
      provider: "slack",
    });
    expect(out.webhook_url).toBeUndefined();
    expect(out.webhook_url_enc).toBeDefined();
    expect(out.provider).toBe("slack");
  });

  it.each([
    ["llm_provider", "api_key"],
    ["llm_gateway", "api_key"],
    ["n8n", "webhook_token"],
    ["firecrawl", "api_key"],
    ["notification", "webhook_url"],
  ])("%s declares %s as a secret field", (type, field) => {
    // A type missing from SECRET_FIELDS stores its secret in PLAINTEXT and
    // nothing complains. Adding an integration type means adding it here.
    expect(integrationSecretFields(type)).toContain(field);
  });

  it("leaves a type with no declared secrets untouched", async () => {
    const config = { some_field: "value" };
    expect(await encryptIntegrationConfig("unknown_type", config)).toEqual(config);
  });
});

describe("preserveBlankSecrets — editing without re-typing the key", () => {
  it("carries the existing ciphertext forward when nothing new was supplied", async () => {
    const existing = await encryptIntegrationConfig("llm_provider", { api_key: "sk-original" });
    const incoming = await encryptIntegrationConfig("llm_provider", { api_key: "" });
    const merged = preserveBlankSecrets("llm_provider", incoming, existing);
    const blob = merged.api_key_enc as { ciphertext: string; iv: string };
    expect(await decryptJson<string>(blob.ciphertext, blob.iv)).toBe("sk-original");
  });

  it("does NOT overwrite a newly supplied secret with the old one", async () => {
    const existing = await encryptIntegrationConfig("llm_provider", { api_key: "sk-original" });
    const incoming = await encryptIntegrationConfig("llm_provider", { api_key: "sk-replacement" });
    const merged = preserveBlankSecrets("llm_provider", incoming, existing);
    const blob = merged.api_key_enc as { ciphertext: string; iv: string };
    expect(await decryptJson<string>(blob.ciphertext, blob.iv)).toBe("sk-replacement");
  });

  it("carries a legacy PLAINTEXT secret forward, so old rows keep working", async () => {
    const incoming = await encryptIntegrationConfig("llm_provider", { api_key: "" });
    const merged = preserveBlankSecrets("llm_provider", incoming, { api_key: "legacy-plaintext" });
    expect(merged.api_key).toBe("legacy-plaintext");
  });

  it("is a no-op when there is nothing existing to preserve", async () => {
    const incoming = await encryptIntegrationConfig("llm_provider", { api_key: "" });
    expect(preserveBlankSecrets("llm_provider", incoming, null)).toEqual(incoming);
  });
});

describe("resolveIntegrationConfig — the server-side read", () => {
  const USER = "00000000-0000-0000-0000-000000000000";

  it("decrypts into the plaintext field and removes the ciphertext", async () => {
    const stored = await encryptIntegrationConfig("llm_provider", {
      api_key: "sk-live-abc123",
      base_url: "https://api.example.com",
    });
    const resolved = await resolveIntegrationConfig(USER, "llm_provider", stored);
    expect(resolved.api_key).toBe("sk-live-abc123");
    expect(resolved.api_key_enc).toBeUndefined();
    expect(resolved.base_url).toBe("https://api.example.com");
  });

  it("leaves a bad ciphertext unresolved instead of failing the whole read", async () => {
    // One unreadable credential (a rotated secret, a corrupt row) must not take
    // down every other integration the caller is loading.
    const resolved = await resolveIntegrationConfig(USER, "llm_provider", {
      api_key_enc: { ciphertext: "bm90LXJlYWw=", iv: "bm90LXJlYWw=" },
      base_url: "https://api.example.com",
    });
    expect(resolved.api_key).toBeUndefined();
    expect(resolved.base_url).toBe("https://api.example.com");
  });

  it("does not mutate the config it was given", async () => {
    const stored = await encryptIntegrationConfig("llm_provider", { api_key: "sk-live-abc123" });
    const snapshot = JSON.stringify(stored);
    await resolveIntegrationConfig(USER, "llm_provider", stored);
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it("passes a legacy plaintext row through unchanged", async () => {
    const resolved = await resolveIntegrationConfig(USER, "llm_provider", {
      api_key: "legacy-plaintext",
    });
    expect(resolved.api_key).toBe("legacy-plaintext");
  });

  it("round-trips through the full save → read path", async () => {
    const saved = await encryptIntegrationConfig("n8n", { webhook_token: "tok-123", url: "u" });
    expect(JSON.stringify(saved)).not.toContain("tok-123");
    const read = await resolveIntegrationConfig(USER, "n8n", saved);
    expect(read.webhook_token).toBe("tok-123");
    expect(read.url).toBe("u");
  });
});
