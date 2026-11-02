// R435: Google Cloud KMS as a key provider. The key reference, the endpoint
// (and its Private Service Connect token host), the CRC-32C checks both ways,
// the version a stored data key names, Google's errors read with what to do,
// and the probe a least-privileged identity can still pass. Driven against a
// fake Cloud KMS that records what it was sent; the real API's shapes are
// checked against an emulator in tests/integration/gcpKmsEmulator.test.ts.
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic DNS for the private-path cases: no network.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host.startsWith("cloudkms-private.")) return [{ address: "10.20.0.9", family: 4 }];
    return [{ address: "142.250.185.74", family: 4 }];
  },
}));

// The data key's row: a recording stand-in for the table.
const db = vi.hoisted(() => ({
  ops: [] as Array<{ op: string; payload?: unknown; filters?: unknown[][] }>,
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const table = {
    update(payload: unknown) {
      const op = { op: "update", payload, filters: [] as unknown[][] };
      db.ops.push(op);
      const chain = {
        eq(column: string, value: unknown) {
          op.filters.push(["eq", column, value]);
          return chain;
        },
        async is(column: string, value: unknown) {
          op.filters.push(["is", column, value]);
          return { error: null };
        },
      };
      return chain;
    },
    insert(payload: Record<string, unknown>) {
      db.ops.push({ op: "insert", payload });
      return {
        select: () => ({
          single: async () => ({
            data: { id: "row-1", created_at: "2026-11-02T00:00:00Z", retired_at: null, ...payload },
            error: null,
          }),
        }),
      };
    },
  };
  return { supabaseAdmin: { from: () => table } };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));

import { auditEvent } from "@/utils/audit.server";
import { configuredExternalProvider, createDataKey, providerFor } from "@/utils/kms/keyring.server";

import { crc32c } from "@/utils/kms/crc32c";
import {
  GCP_KMS_AAD,
  GCP_PRIVATE_PATH_ADVICE,
  GcpKmsError,
  checkedVersion,
  createGcpKmsProvider,
  gcpKmsConfigFromEnv,
} from "@/utils/kms/gcp.server";
import {
  KmsConfigError,
  keyRefProvider,
  kmsConfigFromEnv,
  parseGcpKeyRef,
} from "@/utils/kms/types";
import type { GoogleCredentialChain } from "@/utils/google/credentials.server";
import { PrivatePathRequiredError, SsrfRefusedError } from "@/utils/ssrfGuard.server";

beforeEach(() => {
  db.ops = [];
  vi.mocked(auditEvent).mockClear();
});

const KEY = "projects/acme-prod/locations/europe-west3/keyRings/agentswarms/cryptoKeys/credentials";
const NOW = 1_800_000_000_000;

describe("CRC-32C", () => {
  it("is Castagnoli's, by the published check values", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
    // RFC 3720, B.4: 32 bytes of zeros, of ones.
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
    expect(crc32c(new Uint8Array(32).fill(0xff))).toBe(0x62a8ab43);
    expect(crc32c(new Uint8Array(0))).toBe(0);
  });
});

describe("the key reference", () => {
  it("is a key's resource name, normalised from the full resource name", () => {
    expect(parseGcpKeyRef(KEY)).toEqual({
      keyRef: KEY,
      project: "acme-prod",
      location: "europe-west3",
      keyRing: "agentswarms",
      cryptoKey: "credentials",
    });
    expect(parseGcpKeyRef(`//cloudkms.googleapis.com/${KEY}`).keyRef).toBe(KEY);
    expect(parseGcpKeyRef(` ${KEY} `).keyRef).toBe(KEY);
    // A project number, a legacy domain-scoped project, a multi-region.
    expect(
      parseGcpKeyRef("projects/123456789012/locations/us/keyRings/r/cryptoKeys/k").project,
    ).toBe("123456789012");
    expect(
      parseGcpKeyRef("projects/example.com:acme-prod/locations/global/keyRings/r/cryptoKeys/k")
        .project,
    ).toBe("example.com:acme-prod");
  });

  it("refuses a key version, by saying why", () => {
    expect(() => parseGcpKeyRef(`${KEY}/cryptoKeyVersions/3`)).toThrow(
      /names a key version \(cryptoKeyVersions\/3\); name the key itself/,
    );
  });

  it("refuses anything else, and nothing it accepts can leave the path", () => {
    for (const bad of [
      "projects/acme-prod/locations/europe-west3/keyRings/agentswarms",
      "projects/Acme/locations/eu/keyRings/r/cryptoKeys/k",
      "projects/acme-prod/locations/eu/keyRings/r/cryptoKeys/k?alt=x",
      "projects/acme-prod/locations/eu/keyRings/r%2F../cryptoKeys/k",
      "projects/acme-prod/locations/eu/keyRings/r/cryptoKeys/k:decrypt",
      "projects/ab/locations/eu/keyRings/r/cryptoKeys/k",
      "https://cloudkms.googleapis.com/v1/projects/acme-prod/locations/eu/keyRings/r/cryptoKeys/k",
    ]) {
      expect(() => parseGcpKeyRef(bad), bad).toThrow(KmsConfigError);
    }
  });

  it("tells the providers apart by shape, and KMS_PROVIDER=gcp is built", () => {
    expect(keyRefProvider(KEY)).toBe("gcp");
    expect(keyRefProvider(`//cloudkms.googleapis.com/${KEY}`)).toBe("gcp");
    expect(keyRefProvider("projects/x")).toBeNull();
    expect(keyRefProvider("transit/keys/app")).toBe("vault");
    expect(keyRefProvider("alias/app")).toBe("aws");
    expect(kmsConfigFromEnv({ KMS_PROVIDER: "gcp", KMS_KEY_REF: KEY })).toEqual({
      provider: "gcp",
      keyRef: KEY,
    });
  });
});

describe("the endpoint", () => {
  it("is Cloud KMS's own; GCP_KMS_ENDPOINT moves it; a PSC name brings its oauth2 name", () => {
    expect(gcpKmsConfigFromEnv(KEY, {})).toMatchObject({
      endpoint: "https://cloudkms.googleapis.com",
      endpointFrom: "default",
      tokenUrl: undefined,
      requirePrivate: false,
    });
    expect(
      gcpKmsConfigFromEnv(KEY, {
        GCP_KMS_ENDPOINT: "https://cloudkms-kmsep.p.googleapis.com/",
        KMS_REQUIRE_PRIVATE: "true",
      }),
    ).toMatchObject({
      endpoint: "https://cloudkms-kmsep.p.googleapis.com",
      endpointFrom: "GCP_KMS_ENDPOINT",
      tokenUrl: "https://oauth2-kmsep.p.googleapis.com/token",
      requirePrivate: true,
    });
    expect(
      gcpKmsConfigFromEnv(KEY, {
        GCP_KMS_ENDPOINT: "https://cloudkms.europe-west3.rep.googleapis.com",
      }).tokenUrl,
    ).toBeUndefined();
    expect(gcpKmsConfigFromEnv(KEY, { GCP_KMS_ENDPOINT: "http://127.0.0.1:4588" }).endpoint).toBe(
      "http://127.0.0.1:4588",
    );
    for (const bad of ["ftp://x", "https://x/v1", "https://u:p@x", "not a url"]) {
      expect(() => gcpKmsConfigFromEnv(KEY, { GCP_KMS_ENDPOINT: bad }), bad).toThrow(
        KmsConfigError,
      );
    }
  });
});

// ── A fake Cloud KMS ────────────────────────────────────────────────────────

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function fakeKms(
  over: {
    primaryVersion?: number;
    answer?: (call: Call) => Response | null;
    key?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const secret = randomBytes(32);
  const version = over.primaryVersion ?? 3;
  const enc = (plain: Buffer, aad: Buffer) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", secret, iv).setAAD(aad);
    const out = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from([version]), iv, c.getAuthTag(), out]);
  };
  const dec = (ct: Buffer, aad: Buffer) => {
    const d = createDecipheriv("aes-256-gcm", secret, ct.subarray(1, 13)).setAAD(aad);
    d.setAuthTag(ct.subarray(13, 29));
    return { plain: Buffer.concat([d.update(ct.subarray(29)), d.final()]), version: ct[0] };
  };
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const err = (status: number, s: string, message: string) =>
    new Response(JSON.stringify({ error: { code: status, message, status: s } }), { status });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    const custom = over.answer?.(call);
    if (custom) return custom;
    const path = new URL(url).pathname.replace(/^\/v1\//, "");
    if (call.method === "GET") {
      return ok({
        name: path,
        purpose: "ENCRYPT_DECRYPT",
        primary: {
          name: `${path}/cryptoKeyVersions/${version}`,
          state: "ENABLED",
          protectionLevel: "HSM",
          algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION",
        },
        versionTemplate: { protectionLevel: "HSM", algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION" },
        rotationPeriod: "7776000s",
        nextRotationTime: "2027-02-01T00:00:00Z",
        destroyScheduledDuration: "2592000s",
        ...over.key,
      });
    }
    const [name, op] = path.split(":");
    const aad = Buffer.from(String(call.body.additionalAuthenticatedData ?? ""), "base64");
    if (op === "encrypt") {
      const plain = Buffer.from(String(call.body.plaintext), "base64");
      const ct = enc(plain, aad);
      return ok({
        name: `${name}/cryptoKeyVersions/${version}`,
        ciphertext: ct.toString("base64"),
        ciphertextCrc32c: String(crc32c(ct)),
        verifiedPlaintextCrc32c: Number(call.body.plaintextCrc32c) === crc32c(plain),
        verifiedAdditionalAuthenticatedDataCrc32c:
          Number(call.body.additionalAuthenticatedDataCrc32c) === crc32c(aad),
        protectionLevel: "HSM",
      });
    }
    if (op === "decrypt") {
      const ct = Buffer.from(String(call.body.ciphertext), "base64");
      try {
        const { plain, version: v } = dec(ct, aad);
        return ok({
          plaintext: plain.toString("base64"),
          plaintextCrc32c: String(crc32c(plain)),
          usedPrimary: v === version,
          protectionLevel: "HSM",
        });
      } catch {
        return err(400, "INVALID_ARGUMENT", "Decryption failed: the ciphertext is invalid.");
      }
    }
    return err(404, "NOT_FOUND", "unknown");
  };
  return { calls, fetchImpl };
}

const token = (
  over: Partial<Awaited<ReturnType<GoogleCredentialChain["get"]>>> = {},
): GoogleCredentialChain => ({
  source: "service-account",
  get: async () => ({
    token: "ya29.app",
    expiresAt: NOW + 3600_000,
    source: "service-account",
    identity: "service account agentswarms@acme-prod.iam.gserviceaccount.com (key 01234567…)",
    ...over,
  }),
});

function provider(kms: ReturnType<typeof fakeKms>, env: Record<string, string> = {}, extra = {}) {
  return createGcpKmsProvider(gcpKmsConfigFromEnv(KEY, env), {
    credentials: token(),
    fetch: kms.fetchImpl,
    sleep: async () => {},
    env,
    ...extra,
  });
}

const DEK = new Uint8Array(randomBytes(32));
const AAD_B64 = Buffer.from(GCP_KMS_AAD).toString("base64");

describe("wrapping and unwrapping a data key", () => {
  it("encrypts with the key, checksums and AAD sent as strings, and stores the version that did it", async () => {
    const kms = fakeKms();
    const w = await provider(kms).wrapDek(DEK);
    expect(w.provider).toBe("gcp");
    expect(w.keyRef).toBe(KEY);
    const m = JSON.parse(w.material);
    expect(m.version).toBe(`${KEY}/cryptoKeyVersions/3`);
    const c = kms.calls[0];
    expect(c.url).toBe(`https://cloudkms.googleapis.com/v1/${KEY}:encrypt`);
    expect(c.method).toBe("POST");
    expect(c.headers.authorization).toBe("Bearer ya29.app");
    expect(c.body).toEqual({
      plaintext: Buffer.from(DEK).toString("base64"),
      plaintextCrc32c: String(crc32c(DEK)),
      additionalAuthenticatedData: AAD_B64,
      additionalAuthenticatedDataCrc32c: String(crc32c(Buffer.from(GCP_KMS_AAD))),
    });
    const back = await provider(kms).unwrapDek(w);
    expect(Buffer.from(back).equals(Buffer.from(DEK))).toBe(true);
    const d = kms.calls[1];
    expect(d.url).toBe(`https://cloudkms.googleapis.com/v1/${KEY}:decrypt`);
    expect(d.body).toEqual({
      ciphertext: m.ciphertext,
      ciphertextCrc32c: String(crc32c(Buffer.from(m.ciphertext, "base64"))),
      additionalAuthenticatedData: AAD_B64,
      additionalAuthenticatedDataCrc32c: String(crc32c(Buffer.from(GCP_KMS_AAD))),
    });
  });

  it("uses an answer only when its checksums hold", async () => {
    const unverified = fakeKms({
      answer: (c) =>
        c.url.endsWith(":encrypt")
          ? new Response(
              JSON.stringify({
                name: `${KEY}/cryptoKeyVersions/3`,
                ciphertext: "AAAA",
                ciphertextCrc32c: String(crc32c(Buffer.from("AAAA", "base64"))),
                verifiedPlaintextCrc32c: false,
                verifiedAdditionalAuthenticatedDataCrc32c: true,
              }),
            )
          : null,
    });
    await expect(provider(unverified).wrapDek(DEK)).rejects.toThrow(
      /did not confirm the checksums/,
    );
    const badCt = fakeKms({
      answer: (c) =>
        c.url.endsWith(":encrypt")
          ? new Response(
              JSON.stringify({
                name: `${KEY}/cryptoKeyVersions/3`,
                ciphertext: "AAAA",
                ciphertextCrc32c: "1",
                verifiedPlaintextCrc32c: true,
                verifiedAdditionalAuthenticatedDataCrc32c: true,
              }),
            )
          : null,
    });
    await expect(provider(badCt).wrapDek(DEK)).rejects.toThrow(
      /ciphertext whose checksum does not match/,
    );
    const good = fakeKms();
    const w = await provider(good).wrapDek(DEK);
    const badPlain = fakeKms({
      answer: (c) =>
        c.url.endsWith(":decrypt")
          ? new Response(
              JSON.stringify({
                plaintext: Buffer.from(DEK).toString("base64"),
                plaintextCrc32c: String(crc32c(DEK) ^ 1),
              }),
            )
          : null,
    });
    await expect(provider(badPlain).unwrapDek(w)).rejects.toThrow(
      /plaintext whose checksum does not match/,
    );
  });

  it("refuses an encrypt answer naming a version of another key", async () => {
    const other = fakeKms({
      answer: (c) => {
        if (!c.url.endsWith(":encrypt")) return null;
        const ct = Buffer.from("x");
        return new Response(
          JSON.stringify({
            name: "projects/evil-prj/locations/europe-west3/keyRings/agentswarms/cryptoKeys/credentials/cryptoKeyVersions/1",
            ciphertext: ct.toString("base64"),
            ciphertextCrc32c: String(crc32c(ct)),
            verifiedPlaintextCrc32c: true,
            verifiedAdditionalAuthenticatedDataCrc32c: true,
          }),
        );
      },
    });
    await expect(provider(other).wrapDek(DEK)).rejects.toThrow(
      /not a version of projects\/acme-prod/,
    );
  });

  it("unwraps at the row's own key, and refuses material naming another key's version before calling", async () => {
    const kms = fakeKms();
    const w = await provider(kms).wrapDek(DEK);
    const m = JSON.parse(w.material);
    const forged = {
      ...w,
      material: JSON.stringify({
        ...m,
        version: "projects/evil-prj/locations/x/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
      }),
    };
    const before = kms.calls.length;
    await expect(provider(kms).unwrapDek(forged)).rejects.toThrow(/refusing to use it/);
    expect(kms.calls.length).toBe(before);
    // A row for a retired key unwraps at that key, not the configured one.
    const OLD = "projects/acme-prod/locations/europe-west3/keyRings/agentswarms/cryptoKeys/old";
    const oldRow = {
      ...w,
      keyRef: OLD,
      material: JSON.stringify({ ...m, version: `${OLD}/cryptoKeyVersions/9` }),
    };
    await provider(kms)
      .unwrapDek(oldRow)
      .catch(() => {});
    expect(kms.calls.at(-1)!.url).toBe(`https://cloudkms.googleapis.com/v1/${OLD}:decrypt`);
    await expect(provider(kms).unwrapDek({ ...w, provider: "aws" })).rejects.toThrow(
      /wrapped by aws, not Cloud KMS/,
    );
    await expect(provider(kms).unwrapDek({ ...w, material: "garbage" })).rejects.toThrow(
      /not Cloud KMS material/,
    );
  });

  it("checkedVersion takes only a numbered version of the same key", () => {
    expect(checkedVersion(`${KEY}/cryptoKeyVersions/12`, KEY)).toBe(`${KEY}/cryptoKeyVersions/12`);
    for (const bad of [
      `${KEY}/cryptoKeyVersions/0`,
      `${KEY}/cryptoKeyVersions/1/x`,
      `${KEY}2/cryptoKeyVersions/1`,
      "",
    ]) {
      expect(() => checkedVersion(bad, KEY), bad).toThrow();
    }
  });

  it("sends a user credential's quota project", async () => {
    const kms = fakeKms();
    await createGcpKmsProvider(gcpKmsConfigFromEnv(KEY, {}), {
      credentials: token({ quotaProject: "acme-prod", source: "authorized-user" }),
      fetch: kms.fetchImpl,
    }).wrapDek(DEK);
    expect(kms.calls[0].headers["x-goog-user-project"]).toBe("acme-prod");
  });
});

describe("Google's errors", () => {
  const failing = (status: number, s: string, message: string) =>
    fakeKms({
      answer: () =>
        new Response(JSON.stringify({ error: { code: status, message, status: s } }), { status }),
    });

  it("say what was refused and what to do", async () => {
    await expect(
      provider(
        failing(
          403,
          "PERMISSION_DENIED",
          "Permission 'cloudkms.cryptoKeyVersions.useToEncrypt' denied on resource",
        ),
      ).wrapDek(DEK),
    ).rejects.toThrow(
      /encrypt refused \(403 PERMISSION_DENIED\): .*roles\/cloudkms\.cryptoKeyEncrypterDecrypter/,
    );
    await expect(
      provider(failing(404, "NOT_FOUND", "CryptoKey not found.")).wrapDek(DEK),
    ).rejects.toThrow(
      /Check KMS_KEY_REF: the project, the location, the key ring and the key name/,
    );
    await expect(
      provider(
        failing(
          400,
          "FAILED_PRECONDITION",
          "The request cannot be fulfilled. Resource is not enabled.",
        ),
      ).wrapDek(DEK),
    ).rejects.toThrow(/primary version is disabled, destroyed or scheduled for destruction/);
    await expect(
      provider(
        failing(
          403,
          "PERMISSION_DENIED",
          "Request is prohibited by organization's policy. vpcServiceControlsUniqueIdentifier: x",
        ),
      ).wrapDek(DEK),
    ).rejects.toThrow(/VPC Service Controls perimeter refused the call/);
  });

  it("retry twice on 429 and 5xx, then give up; never on a 4xx", async () => {
    let n = 0;
    const flaky = fakeKms({
      answer: (c) =>
        c.url.endsWith(":encrypt") && n++ < 2
          ? new Response(
              JSON.stringify({ error: { code: 503, status: "UNAVAILABLE", message: "try again" } }),
              { status: 503 },
            )
          : null,
    });
    await provider(flaky).wrapDek(DEK);
    expect(flaky.calls.filter((c) => c.url.endsWith(":encrypt"))).toHaveLength(3);
    const down = failing(503, "UNAVAILABLE", "down");
    await expect(provider(down).wrapDek(DEK)).rejects.toBeInstanceOf(GcpKmsError);
    expect(down.calls).toHaveLength(3);
    const denied = failing(403, "PERMISSION_DENIED", "no");
    await expect(provider(denied).wrapDek(DEK)).rejects.toThrow();
    expect(denied.calls).toHaveLength(1);
  });

  it("an SSRF or private-path refusal reads as itself; a network failure names the host", async () => {
    const refuse = async () => {
      throw new SsrfRefusedError("Cloud KMS is set to require a private network path, but …");
    };
    await expect(
      createGcpKmsProvider(gcpKmsConfigFromEnv(KEY, {}), {
        credentials: token(),
        fetch: refuse,
      }).wrapDek(DEK),
    ).rejects.toBeInstanceOf(SsrfRefusedError);
    const reset = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    };
    await expect(
      createGcpKmsProvider(gcpKmsConfigFromEnv(KEY, {}), {
        credentials: token(),
        fetch: reset,
      }).wrapDek(DEK),
    ).rejects.toThrow(
      /Cloud KMS encrypt: cloudkms\.googleapis\.com could not be reached \(ECONNRESET\)/,
    );
  });
});

describe("the probe", () => {
  const factsOf = (r: { facts?: Array<{ label: string; value: string }> }) =>
    Object.fromEntries((r.facts ?? []).map((f) => [f.label, f.value]));

  it("describes the key and proves encrypt and decrypt with a round trip", async () => {
    const kms = fakeKms();
    const r = await provider(kms).probe();
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("Encrypt and decrypt work (version 3).");
    expect(factsOf(r)).toMatchObject({
      "Signed in as":
        "service account agentswarms@acme-prod.iam.gserviceaccount.com (key 01234567…)",
      Key: KEY,
      Protection: "in Cloud HSM (FIPS 140-2 Level 3)",
      "Primary version": "3 · ENABLED",
      Rotation: "every 90 days, next 2027-02-01",
      Destruction: "a version scheduled for destruction can be restored for 30 days",
    });
    expect(
      kms.calls.map((c) => `${c.method} ${new URL(c.url).pathname.split(":")[1] ?? "key"}`),
    ).toEqual(["GET key", "POST encrypt", "POST decrypt"]);
  });

  it("passes for an identity that may use the key but not read it", async () => {
    const kms = fakeKms({
      answer: (c) =>
        c.method === "GET"
          ? new Response(
              JSON.stringify({
                error: {
                  code: 403,
                  status: "PERMISSION_DENIED",
                  message: "cloudkms.cryptoKeys.get denied",
                },
              }),
              { status: 403 },
            )
          : null,
    });
    const r = await provider(kms).probe();
    expect(r.ok).toBe(true);
    expect(r.detail).toBe(
      "Encrypt and decrypt work (version 3; the key's details are not readable).",
    );
    expect(factsOf(r)["Key details"]).toMatch(/not readable by this identity/);
  });

  it("fails for a disabled primary version, an asymmetric key, no rotation said plainly", async () => {
    const disabled = await provider(
      fakeKms({
        key: {
          primary: {
            name: `${KEY}/cryptoKeyVersions/3`,
            state: "DISABLED",
            protectionLevel: "SOFTWARE",
          },
          rotationPeriod: undefined,
        },
      }),
    ).probe();
    expect(disabled.ok).toBe(false);
    expect(disabled.detail).toMatch(/primary version is DISABLED/);
    expect(factsOf(disabled).Rotation).toBe("not scheduled: set a rotation period on the key");
    const asym = await provider(
      fakeKms({ key: { purpose: "ASYMMETRIC_DECRYPT", primary: undefined } }),
    ).probe();
    expect(asym.ok).toBe(false);
    expect(asym.detail).toMatch(
      /purpose is ASYMMETRIC_DECRYPT; wrapping a data key needs a symmetric ENCRYPT_DECRYPT key/,
    );
  });

  it("says when the private path is required and which endpoint it uses", async () => {
    const r = await createGcpKmsProvider(
      gcpKmsConfigFromEnv(KEY, {
        GCP_KMS_ENDPOINT: "https://cloudkms-kmsep.p.googleapis.com",
        KMS_REQUIRE_PRIVATE: "1",
      }),
      { credentials: token(), fetch: fakeKms().fetchImpl },
    ).probe();
    const f = factsOf(r);
    expect(f.Endpoint).toMatch(
      /^https:\/\/cloudkms-kmsep\.p\.googleapis\.com \(GCP_KMS_ENDPOINT\)/,
    );
    expect(f["Network rule"]).toMatch(/private path required \(KMS_REQUIRE_PRIVATE\)/);
  });
});

describe("KMS_REQUIRE_PRIVATE, through the real guarded fetch", () => {
  const realFetch = globalThis.fetch;
  let sent: string[] = [];
  const kms = fakeKms();
  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push(url);
      if (url.startsWith("https://oauth2.googleapis.com/")) {
        return new Response(JSON.stringify({ access_token: "ya29.t", expires_in: 3600 }));
      }
      return kms.fetchImpl(url, init ?? {});
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a public Cloud KMS address before anything is sent to it", async () => {
    const refusals: string[] = [];
    const p = createGcpKmsProvider(gcpKmsConfigFromEnv(KEY, { KMS_REQUIRE_PRIVATE: "true" }), {
      credentials: token(),
      onRefuse: (d) => refusals.push(d),
    });
    const err = (await p.wrapDek(DEK).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PrivatePathRequiredError);
    expect(err.message).toBe(
      "Cloud KMS is set to require a private network path, but cloudkms.googleapis.com " +
        "resolves to a public address (142.250.185.74) from this server, so the call was not sent. " +
        GCP_PRIVATE_PATH_ADVICE,
    );
    expect(refusals).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("sends to an endpoint whose name resolves privately", async () => {
    const env = {
      GCP_KMS_ENDPOINT: "https://cloudkms-private.p.googleapis.com",
      KMS_REQUIRE_PRIVATE: "true",
    };
    const w = await createGcpKmsProvider(gcpKmsConfigFromEnv(KEY, env), {
      credentials: token(),
    }).wrapDek(DEK);
    expect(w.provider).toBe("gcp");
    expect(sent).toEqual([`https://cloudkms-private.p.googleapis.com/v1/${KEY}:encrypt`]);
  });

  it("the keyring's Cloud KMS provider audits a refusal, the app as the actor; the sign-in is not held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcp-kms-"));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const file = join(dir, "sa.json");
    writeFileSync(
      file,
      JSON.stringify({
        type: "service_account",
        client_email: "agentswarms@acme-prod.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    );
    const p = providerFor(
      { provider: "gcp", keyRef: KEY },
      { KMS_REQUIRE_PRIVATE: "true", GOOGLE_APPLICATION_CREDENTIALS: file },
    );
    await expect(p.wrapDek(DEK)).rejects.toThrow(PrivatePathRequiredError);
    expect(sent).toEqual(["https://oauth2.googleapis.com/token"]);
    expect(vi.mocked(auditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        actorEmail: "system:kms",
        action: "security.kms.private_path.refused",
        resourceName: KEY,
        detail: expect.objectContaining({
          provider: "gcp",
          key_ref: KEY,
          endpoint: "https://cloudkms.googleapis.com",
          reason: expect.stringMatching(/^Cloud KMS is set to require a private network path/),
        }),
      }),
    );
  });
});

describe("the keyring with Cloud KMS", () => {
  it("is the configured external provider for a Cloud KMS resource name", () => {
    const p = configuredExternalProvider({ KMS_KEY_REF: `//cloudkms.googleapis.com/${KEY}` });
    expect(p?.id).toBe("gcp");
    expect(p?.keyRef).toBe(KEY);
  });

  it("creates a data key: 32 random bytes, encrypted, proven to decrypt, then stored", async () => {
    const kms = fakeKms();
    const row = await createDataKey({ provider: provider(kms), createdBy: "admin-1" });
    expect(kms.calls.map((c) => new URL(c.url).pathname.split(":")[1])).toEqual([
      "encrypt",
      "decrypt",
    ]);
    expect(db.ops.map((o) => o.op)).toEqual(["update", "insert"]);
    expect(db.ops[0].filters).toEqual([
      ["eq", "provider", "gcp"],
      ["is", "retired_at", null],
    ]);
    const stored = db.ops[1].payload as Record<string, unknown>;
    expect(stored).toMatchObject({ provider: "gcp", key_ref: KEY, created_by: "admin-1" });
    expect(JSON.parse(String(stored.material)).version).toBe(`${KEY}/cryptoKeyVersions/3`);
    expect(row.kid).toMatch(/^[0-9a-f]{12}$/);
  });

  it("stores nothing when decrypt does not give the same bytes back", async () => {
    const kms = fakeKms({
      answer: (c) => {
        if (!c.url.endsWith(":decrypt")) return null;
        const zero = new Uint8Array(32);
        return new Response(
          JSON.stringify({
            plaintext: Buffer.from(zero).toString("base64"),
            plaintextCrc32c: String(crc32c(zero)),
          }),
        );
      },
    });
    await expect(createDataKey({ provider: provider(kms), createdBy: null })).rejects.toThrow(
      /did not unwrap it to the same bytes/,
    );
    expect(db.ops).toEqual([]);
  });
});
