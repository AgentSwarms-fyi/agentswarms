// R437: OCI Vault as a key provider. The key OCID, the vault's endpoints, the
// associated data every call carries, the key and version an answer must name,
// OCI's errors read with what to do, and the probe a least-privileged identity
// can still pass. Driven against a fake Vault that checks every request's
// signature, binds a ciphertext to its key and version, and authenticates the
// associated data with AES-GCM, as Vault does; the real API's shapes are
// checked against an emulator in tests/integration/ociKmsEmulator.test.ts.
import {
  createCipheriv,
  createDecipheriv,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic DNS for the private-path cases: no network.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host.startsWith("private")) return [{ address: "10.0.4.20", family: 4 }];
    return [{ address: "134.70.24.1", family: 4 }];
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
import {
  OCI_KMS_AAD,
  OCI_PRIVATE_PATH_ADVICE,
  OciKmsError,
  createOciKmsProvider,
  ociKmsConfigFromEnv,
} from "@/utils/kms/oci.server";
import {
  KmsConfigError,
  keyRefProvider,
  kmsConfigFromEnv,
  parseOciKeyRef,
} from "@/utils/kms/types";
import type { OciCredentialChain } from "@/utils/oci/credentials.server";
import { ociKeyFingerprint, signOciRequest } from "@/utils/oci/signer";
import { PrivatePathRequiredError, SsrfRefusedError } from "@/utils/ssrfGuard.server";

beforeEach(() => {
  db.ops = [];
  vi.mocked(auditEvent).mockClear();
});

const VAULT = "bbpt4szqaaeug";
const KEY = `ocid1.key.oc1.iad.${VAULT}.abuwcljrr437credentialkek`;
const OTHER_KEY = `ocid1.key.oc1.iad.${VAULT}.abuwcljrr437someoneelses`;
const VERSION = `ocid1.keyversion.oc1.iad.${VAULT}.abuwcljrr437version3`;
const CRYPTO = `https://${VAULT}-crypto.kms.us-ashburn-1.oraclecloud.com`;
const MANAGEMENT = `https://${VAULT}-management.kms.us-ashburn-1.oraclecloud.com`;
const ENV = { OCI_KMS_CRYPTO_ENDPOINT: CRYPTO };

const apiKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_ID = `ocid1.tenancy.oc1..aaaar437/ocid1.user.oc1..aaaar437/${ociKeyFingerprint(apiKey.privateKey)}`;

const identity = (): OciCredentialChain => ({
  source: "api_key",
  get: async () => ({
    key: { keyId: KEY_ID, privateKey: apiKey.privateKey },
    source: "api_key",
    identity: "user ocid1.user.oc1..aaaar437 (API key 12:34…)",
    expiresAt: null,
  }),
});

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/** Did this request carry a valid signature by the app's API key over what it sent? */
function signed(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): boolean {
  const auth = headers.authorization ?? "";
  if (!auth.includes(`keyId="${KEY_ID}"`)) return false;
  const names = /headers="([^"]+)"/.exec(auth)?.[1].split(" ") ?? [];
  const u = new URL(url);
  const signing = names
    .map((n) =>
      n === "(request-target)"
        ? `(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}`
        : n === "host"
          ? `host: ${u.host}`
          : n === "content-length"
            ? `content-length: ${Buffer.byteLength(body ?? "")}` // fetch sets it from the body
            : `${n}: ${headers[n]}`,
    )
    .join("\n");
  return createVerify("RSA-SHA256")
    .update(signing)
    .verify(apiKey.publicKey, /signature="([^"]+)"/.exec(auth)?.[1] ?? "", "base64");
}

function fakeVault(
  over: {
    answer?: (c: Call) => Response | null;
    key?: Record<string, unknown>;
    version?: string;
  } = {},
) {
  const calls: Call[] = [];
  const secrets = new Map<string, Buffer>();
  const version = over.version ?? VERSION;
  const secret = (k: string, v: string) => {
    if (!secrets.has(`${k}|${v}`)) secrets.set(`${k}|${v}`, randomBytes(32));
    return secrets.get(`${k}|${v}`)!;
  };
  const aadOf = (m: unknown) => Buffer.from(JSON.stringify(m ?? null));
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const err = (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ code, message }), { status });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    if (!signed(url, call.method, call.headers, init.body as string | undefined)) {
      return err(
        401,
        "NotAuthenticated",
        "The required information to complete authentication was not provided or was incorrect.",
      );
    }
    const custom = over.answer?.(call);
    if (custom) return custom;
    const path = new URL(url).pathname;
    if (call.method === "GET" && path.startsWith("/20180608/keys/")) {
      return ok({
        id: path.slice("/20180608/keys/".length),
        currentKeyVersion: version,
        keyShape: { algorithm: "AES", length: 32 },
        protectionMode: "HSM",
        lifecycleState: "ENABLED",
        isAutoRotationEnabled: true,
        autoKeyRotationDetails: {
          rotationIntervalInDays: 90,
          timeOfNextRotation: "2027-02-01T00:00:00Z",
        },
        ...over.key,
      });
    }
    const keyId = String(call.body.keyId ?? "");
    if (path === "/20180608/encrypt") {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", secret(keyId, version), iv).setAAD(
        aadOf(call.body.associatedData),
      );
      const ct = Buffer.concat([
        c.update(Buffer.from(String(call.body.plaintext), "base64")),
        c.final(),
      ]);
      const blob = {
        k: keyId,
        v: version,
        iv: iv.toString("base64"),
        t: c.getAuthTag().toString("base64"),
        c: ct.toString("base64"),
      };
      return ok({
        ciphertext: Buffer.from(JSON.stringify(blob)).toString("base64"),
        keyId,
        keyVersionId: version,
        encryptionAlgorithm: "AES_256_GCM",
      });
    }
    if (path === "/20180608/decrypt") {
      let blob: Record<string, string>;
      try {
        blob = JSON.parse(Buffer.from(String(call.body.ciphertext), "base64").toString());
      } catch {
        return err(400, "InvalidParameter", "The ciphertext is not valid.");
      }
      // Vault looks the version up under the key it was asked to use.
      if (blob.k !== keyId) {
        return err(
          404,
          "NotAuthorizedOrNotFound",
          `Authorization failed or requested resource not found: keyVersion ${blob.v}`,
        );
      }
      if (call.body.keyVersionId && call.body.keyVersionId !== blob.v) {
        return err(400, "InvalidParameter", "The key version does not match the ciphertext.");
      }
      try {
        const d = createDecipheriv(
          "aes-256-gcm",
          secret(keyId, blob.v),
          Buffer.from(blob.iv, "base64"),
        ).setAAD(aadOf(call.body.associatedData));
        d.setAuthTag(Buffer.from(blob.t, "base64"));
        const plain = Buffer.concat([d.update(Buffer.from(blob.c, "base64")), d.final()]);
        return ok({
          plaintext: plain.toString("base64"),
          plaintextChecksum: "1234",
          keyId,
          keyVersionId: blob.v,
        });
      } catch {
        return err(400, "InvalidParameter", "Decryption failed.");
      }
    }
    return err(404, "NotAuthorizedOrNotFound", "unknown");
  };
  return { calls, fetchImpl };
}

function provider(
  vault: ReturnType<typeof fakeVault>,
  env: Record<string, string> = ENV,
  extra = {},
) {
  return createOciKmsProvider(ociKmsConfigFromEnv(KEY, env), {
    credentials: identity(),
    fetch: vault.fetchImpl,
    sleep: async () => {},
    env,
    ...extra,
  });
}

const DEK = new Uint8Array(randomBytes(32));

describe("the key reference", () => {
  it("is a key's OCID, with or without the vault's part", () => {
    expect(parseOciKeyRef(` ${KEY} `)).toEqual({
      keyRef: KEY,
      realm: "oc1",
      region: "iad",
      vault: VAULT,
    });
    expect(parseOciKeyRef("ocid1.key.oc1.us-ashburn-1.amaaaaaar437")).toEqual({
      keyRef: "ocid1.key.oc1.us-ashburn-1.amaaaaaar437",
      realm: "oc1",
      region: "us-ashburn-1",
      vault: null,
    });
  });

  it("refuses a key version, by saying why", () => {
    expect(() => parseOciKeyRef(VERSION)).toThrow(
      /names a key version .*; name the key itself \(ocid1\.key\.…\), so encrypt uses its current version and rotation works/,
    );
  });

  it("refuses anything else, and nothing it accepts can leave the path", () => {
    for (const bad of [
      "ocid1.vault.oc1.iad.x.y",
      "ocid1.key.oc1..x",
      "ocid1.key.oc1.iad.x/../y",
      "OCID1.KEY.OC1.IAD.X.Y",
      `${KEY}?x=1`,
      "https://vault.example/keys/x",
    ]) {
      expect(() => parseOciKeyRef(bad), bad).toThrow(KmsConfigError);
    }
  });

  it("tells the providers apart by shape, and KMS_PROVIDER=oci is built", () => {
    expect(keyRefProvider(KEY)).toBe("oci");
    expect(keyRefProvider("ocid1.vault.oc1.iad.x.y")).toBeNull();
    expect(keyRefProvider("transit/keys/app")).toBe("vault");
    expect(kmsConfigFromEnv({ KMS_PROVIDER: "oci", KMS_KEY_REF: KEY })).toEqual({
      provider: "oci",
      keyRef: KEY,
    });
  });
});

describe("the vault's endpoints", () => {
  it("needs the crypto endpoint, an origin; the management endpoint follows Oracle's name", () => {
    expect(() => ociKmsConfigFromEnv(KEY, {})).toThrow(
      "KMS_PROVIDER=oci needs OCI_KMS_CRYPTO_ENDPOINT: the vault's Cryptographic Endpoint, from its details page",
    );
    expect(() =>
      ociKmsConfigFromEnv(KEY, { OCI_KMS_CRYPTO_ENDPOINT: `${CRYPTO}/20180608` }),
    ).toThrow("OCI_KMS_CRYPTO_ENDPOINT must be an origin only");
    expect(ociKmsConfigFromEnv(KEY, ENV)).toMatchObject({
      cryptoEndpoint: CRYPTO,
      managementEndpoint: MANAGEMENT,
      managementFrom: "derived",
      requirePrivate: false,
    });
    expect(
      ociKmsConfigFromEnv(KEY, {
        OCI_KMS_CRYPTO_ENDPOINT: "http://r437-floci-oci:4599",
        KMS_REQUIRE_PRIVATE: "yes",
      }),
    ).toMatchObject({ managementEndpoint: null, managementFrom: null, requirePrivate: true });
    expect(
      ociKmsConfigFromEnv(KEY, {
        OCI_KMS_CRYPTO_ENDPOINT: "http://r437-floci-oci:4599",
        OCI_KMS_MANAGEMENT_ENDPOINT: "http://r437-floci-oci:4599/",
      }),
    ).toMatchObject({
      managementEndpoint: "http://r437-floci-oci:4599",
      managementFrom: "OCI_KMS_MANAGEMENT_ENDPOINT",
    });
  });
});

describe("wrapping and unwrapping a data key", () => {
  it("encrypts with the key and the associated data, signed, and stores the version that did it", async () => {
    const vault = fakeVault();
    const w = await provider(vault).wrapDek(DEK);
    expect(vault.calls).toHaveLength(1);
    const c = vault.calls[0];
    expect(c.url).toBe(`${CRYPTO}/20180608/encrypt`);
    expect(c.body).toEqual({
      keyId: KEY,
      plaintext: Buffer.from(DEK).toString("base64"),
      associatedData: { purpose: "agentswarms:credential-data-key" },
    });
    expect(signed(c.url, c.method, c.headers, JSON.stringify(c.body))).toBe(true);
    expect(c.headers).not.toHaveProperty("content-length");
    expect(w.provider).toBe("oci");
    expect(w.keyRef).toBe(KEY);
    expect(JSON.parse(w.material)).toEqual({
      keyVersionId: VERSION,
      ciphertext: expect.any(String),
    });
    expect(OCI_KMS_AAD).toEqual({ purpose: "agentswarms:credential-data-key" });
  });

  it("unwraps at the row's key and version, with the same associated data", async () => {
    const vault = fakeVault();
    const p = provider(vault);
    const w = await p.wrapDek(DEK);
    expect(Buffer.from(await p.unwrapDek(w))).toEqual(Buffer.from(DEK));
    expect(vault.calls[1].url).toBe(`${CRYPTO}/20180608/decrypt`);
    expect(vault.calls[1].body).toEqual({
      keyId: KEY,
      ciphertext: JSON.parse(w.material).ciphertext,
      associatedData: { purpose: "agentswarms:credential-data-key" },
      keyVersionId: VERSION,
    });
  });

  it("a ciphertext made with the key for anything else does not decrypt as a data key", async () => {
    const vault = fakeVault();
    // Another use of the same key: encrypted without this app's associated data.
    const body = JSON.stringify({ keyId: KEY, plaintext: Buffer.from(DEK).toString("base64") });
    const url = `${CRYPTO}/20180608/encrypt`;
    const res = await vault.fetchImpl(url, {
      method: "POST",
      headers: signOciRequest({
        method: "POST",
        url,
        body,
        key: { keyId: KEY_ID, privateKey: apiKey.privateKey },
      }),
      body,
    });
    const other = (await res.json()) as { ciphertext: string; keyVersionId: string };
    const err = (await provider(vault)
      .unwrapDek({
        provider: "oci",
        keyRef: KEY,
        material: JSON.stringify({
          keyVersionId: other.keyVersionId,
          ciphertext: other.ciphertext,
        }),
      })
      .catch((e: unknown) => e)) as OciKmsError;
    expect(err).toBeInstanceOf(OciKmsError);
    expect(err.message).toBe(
      "OCI Vault decrypt refused (400 InvalidParameter): Decryption failed.",
    );
  });

  it("refuses an answer that names another key or another version, and material from another key", async () => {
    const otherKey = fakeVault({
      answer: (c) =>
        c.url.endsWith("/encrypt")
          ? new Response(
              JSON.stringify({ ciphertext: "AAAA", keyId: OTHER_KEY, keyVersionId: VERSION }),
            )
          : null,
    });
    await expect(provider(otherKey).wrapDek(DEK)).rejects.toThrow(
      `OCI Vault encrypt answered for ${OTHER_KEY}, not ${KEY}; its answer was not used`,
    );
    const noVersion = fakeVault({
      answer: (c) =>
        c.url.endsWith("/encrypt")
          ? new Response(JSON.stringify({ ciphertext: "AAAA", keyId: KEY }))
          : null,
    });
    await expect(provider(noVersion).wrapDek(DEK)).rejects.toThrow(
      "OCI Vault encrypt returned no ciphertext or no key version; it was not used",
    );

    const vault = fakeVault();
    const w = await provider(vault).wrapDek(DEK);
    const wrongVersion = fakeVault({
      answer: (c) =>
        c.url.endsWith("/decrypt")
          ? new Response(
              JSON.stringify({ plaintext: "AAAA", keyId: KEY, keyVersionId: `${VERSION}x` }),
            )
          : null,
    });
    await expect(provider(wrongVersion).unwrapDek(w)).rejects.toThrow(
      `OCI Vault decrypted with ${VERSION}x, but the data key names ${VERSION}; it was not used`,
    );

    // A data key wrapped under another key, stored with this key's reference:
    // decrypt is asked at the row's key, and Vault does not find its version.
    const theirs = await createOciKmsProvider(ociKmsConfigFromEnv(OTHER_KEY, ENV), {
      credentials: identity(),
      fetch: vault.fetchImpl,
      env: ENV,
    }).wrapDek(DEK);
    const err = (await provider(vault)
      .unwrapDek({ ...theirs, keyRef: KEY })
      .catch((e: unknown) => e)) as OciKmsError;
    expect(err).toBeInstanceOf(OciKmsError);
    expect(err.code).toBe("NotAuthorizedOrNotFound");
  });

  it("a row made under a retired key decrypts at that key, not the one configured now", async () => {
    const vault = fakeVault();
    const old = await createOciKmsProvider(ociKmsConfigFromEnv(OTHER_KEY, ENV), {
      credentials: identity(),
      fetch: vault.fetchImpl,
      env: ENV,
    }).wrapDek(DEK);
    expect(Buffer.from(await provider(vault).unwrapDek(old))).toEqual(Buffer.from(DEK));
    expect(vault.calls.at(-1)!.body.keyId).toBe(OTHER_KEY);
  });

  it("refuses before calling: material that is not Vault's, another provider's, a row key in another vault", async () => {
    const vault = fakeVault();
    const p = provider(vault);
    await expect(p.unwrapDek({ provider: "oci", keyRef: KEY, material: "{}" })).rejects.toThrow(
      "The stored data key is not OCI Vault material",
    );
    await expect(
      p.unwrapDek({
        provider: "oci",
        keyRef: KEY,
        material: JSON.stringify({ keyVersionId: "v3", ciphertext: "AAAA" }),
      }),
    ).rejects.toThrow("not OCI Vault material");
    await expect(p.unwrapDek({ provider: "gcp", keyRef: KEY, material: "{}" })).rejects.toThrow(
      "This data key was wrapped by gcp, not OCI Vault",
    );
    await expect(
      p.unwrapDek({
        provider: "oci",
        keyRef: "ocid1.key.oc1.iad.othervault1.abuwcljrr437",
        material: JSON.stringify({ keyVersionId: VERSION, ciphertext: "AAAA" }),
      }),
    ).rejects.toThrow(
      `This data key was wrapped by a key in vault othervault1, but OCI_KMS_CRYPTO_ENDPOINT is vault ${VAULT}'s`,
    );
    expect(vault.calls).toEqual([]);
  });
});

describe("OCI's errors", () => {
  const failing = (status: number, code: string, message: string) =>
    fakeVault({ answer: () => new Response(JSON.stringify({ code, message }), { status }) });

  it("say what was refused and what to do", async () => {
    const e404 = (await provider(
      failing(
        404,
        "NotAuthorizedOrNotFound",
        "Authorization failed or requested resource not found.",
      ),
    )
      .wrapDek(DEK)
      .catch((e: unknown) => e)) as Error;
    expect(e404.message).toBe(
      "OCI Vault encrypt refused (404 NotAuthorizedOrNotFound): Authorization failed or requested resource not found. " +
        "OCI answers this both for a key that is not there and for one the app may not use. " +
        "Check KMS_KEY_REF and OCI_KMS_CRYPTO_ENDPOINT, and a policy such as: Allow dynamic-group <the app's> " +
        `to use keys in compartment <the key's> where target.key.id = '${KEY}' (a group, for an API key's user).`,
    );
    // The key's OCID and the endpoint name different vaults: said in the hint.
    const elsewhere = createOciKmsProvider(
      ociKmsConfigFromEnv(KEY, {
        OCI_KMS_CRYPTO_ENDPOINT: "https://othervault1-crypto.kms.us-ashburn-1.oraclecloud.com",
      }),
      {
        credentials: identity(),
        fetch: failing(404, "NotAuthorizedOrNotFound", "x").fetchImpl,
        env: {},
      },
    );
    await expect(elsewhere.wrapDek(DEK)).rejects.toThrow(
      `The key's OCID names vault ${VAULT}, but the endpoint is vault othervault1's.`,
    );
    await expect(
      provider(failing(401, "NotAuthenticated", "bad signature")).wrapDek(DEK),
    ).rejects.toThrow(
      /\(401 NotAuthenticated\): bad signature OCI did not accept the request's signature: .* this server's clock/,
    );
    await expect(
      provider(failing(409, "Conflict", "Key is DISABLED")).wrapDek(DEK),
    ).rejects.toThrow(
      "(409 Conflict): Key is DISABLED The key cannot be used now: it is disabled, or scheduled for deletion.",
    );
  });

  it("retry twice on 429 and 5xx, then give up; never on a 4xx", async () => {
    for (const status of [429, 500, 503]) {
      const v = failing(status, "TooManyRequests", "slow down");
      await expect(provider(v).wrapDek(DEK)).rejects.toThrow(`(${status} TooManyRequests)`);
      expect(v.calls).toHaveLength(3);
      // Each attempt signed afresh.
      expect(v.calls.every((c) => signed(c.url, c.method, c.headers, JSON.stringify(c.body)))).toBe(
        true,
      );
    }
    const v = failing(400, "InvalidParameter", "nope");
    await expect(provider(v).wrapDek(DEK)).rejects.toThrow("(400 InvalidParameter): nope");
    expect(v.calls).toHaveLength(1);
  });

  it("an SSRF or private-path refusal reads as itself; a network failure names the host", async () => {
    const refused = new SsrfRefusedError("Refused: 169.254.169.254 is a cloud metadata address");
    const p1 = provider(fakeVault(), ENV, {
      fetch: async () => {
        throw refused;
      },
    });
    await expect(p1.wrapDek(DEK)).rejects.toBe(refused);
    const p2 = provider(fakeVault(), ENV, {
      fetch: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    await expect(p2.wrapDek(DEK)).rejects.toThrow(
      `OCI Vault encrypt: ${VAULT}-crypto.kms.us-ashburn-1.oraclecloud.com could not be reached (ECONNREFUSED)`,
    );
  });
});

describe("the probe", () => {
  const facts = (r: { facts?: Array<{ label: string; value: string }> }) =>
    Object.fromEntries((r.facts ?? []).map((f) => [f.label, f.value]));

  it("describes the key and proves encrypt and decrypt with a round trip", async () => {
    const vault = fakeVault();
    const r = await provider(vault).probe();
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("Encrypt and decrypt work (key version …r437version3).");
    expect(facts(r)).toMatchObject({
      "Signed in as": "user ocid1.user.oc1..aaaar437 (API key 12:34…)",
      Key: KEY,
      Protection: "HSM-protected",
      Shape: "AES-256",
      "Current version": "…r437version3 · ENABLED",
      Rotation: "every 90 days, next 2027-02-01",
    });
    expect(facts(r)["Crypto endpoint"]).toMatch(
      new RegExp(`^${CRYPTO} \\(OCI_KMS_CRYPTO_ENDPOINT\\)`),
    );
    expect(
      vault.calls.map(
        (c) =>
          `${c.method} ${new URL(c.url).host.split(".")[0]}${new URL(c.url).pathname.replace(KEY, "<key>")}`,
      ),
    ).toEqual([
      `GET ${VAULT}-management/20180608/keys/<key>`,
      `POST ${VAULT}-crypto/20180608/encrypt`,
      `POST ${VAULT}-crypto/20180608/decrypt`,
    ]);
  });

  it("passes for an identity that may use the key but not read it, and without a management endpoint", async () => {
    const vault = fakeVault({
      answer: (c) =>
        c.method === "GET"
          ? new Response(JSON.stringify({ code: "NotAuthorizedOrNotFound", message: "x" }), {
              status: 404,
            })
          : null,
    });
    const r = await provider(vault).probe();
    expect(r.ok).toBe(true);
    expect(r.detail).toBe(
      "Encrypt and decrypt work (key version …r437version3; the key's details are not shown).",
    );
    expect(facts(r)["Key details"]).toBe(
      `not readable at ${VAULT}-management.kms.us-ashburn-1.oraclecloud.com by this identity (read keys would show them); not needed`,
    );
    const plain = { OCI_KMS_CRYPTO_ENDPOINT: "http://r437-floci-oci:4599" };
    const r2 = await createOciKmsProvider(ociKmsConfigFromEnv(KEY, plain), {
      credentials: identity(),
      fetch: fakeVault().fetchImpl,
      env: plain,
    }).probe();
    expect(r2.ok).toBe(true);
    expect(facts(r2)["Key details"]).toMatch(/^not shown: set OCI_KMS_MANAGEMENT_ENDPOINT/);
    expect(facts(r2)["Crypto endpoint"]).toMatch(
      /plain http: the data key would cross the network unencrypted, an emulator only$/,
    );
  });

  it("fails for a disabled key and an RSA key; says when nothing rotates it", async () => {
    const disabled = await provider(
      fakeVault({ key: { lifecycleState: "DISABLED", isAutoRotationEnabled: false } }),
    ).probe();
    expect(disabled).toMatchObject({
      ok: false,
      detail: "The key is DISABLED; only an enabled key can encrypt.",
    });
    expect(facts(disabled).Rotation).toBe(
      "not scheduled: turn on auto-rotation for the key, or rotate it yourself",
    );
    const rsaKey = await provider(
      fakeVault({ key: { keyShape: { algorithm: "RSA", length: 256 } } }),
    ).probe();
    expect(rsaKey).toMatchObject({
      ok: false,
      detail: "The key is RSA; wrapping a data key needs an AES key.",
    });
  });

  it("says when the private path is required, and that the identity's own call is not covered", async () => {
    const env = {
      OCI_KMS_CRYPTO_ENDPOINT: `https://private-${VAULT}-crypto.example.test`,
      KMS_REQUIRE_PRIVATE: "true",
    };
    const r = await createOciKmsProvider(ociKmsConfigFromEnv(KEY, env), {
      credentials: identity(),
      fetch: fakeVault().fetchImpl,
      env,
    }).probe();
    expect(facts(r)["Network rule"]).toBe(
      "private path required (KMS_REQUIRE_PRIVATE); an instance principal's call to the identity service is not covered",
    );
  });
});

describe("KMS_REQUIRE_PRIVATE, through the real guarded fetch", () => {
  const realFetch = globalThis.fetch;
  let sent: string[] = [];
  const vault = fakeVault();
  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(input));
      return vault.fetchImpl(String(input), init ?? {});
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a public vault address before anything is sent to it", async () => {
    const refusals: string[] = [];
    const p = createOciKmsProvider(
      ociKmsConfigFromEnv(KEY, { ...ENV, KMS_REQUIRE_PRIVATE: "true" }),
      {
        credentials: identity(),
        onRefuse: (d) => refusals.push(d),
      },
    );
    const err = (await p.wrapDek(DEK).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PrivatePathRequiredError);
    expect(err.message).toBe(
      `OCI Vault is set to require a private network path, but ${VAULT}-crypto.kms.us-ashburn-1.oraclecloud.com ` +
        "resolves to a public address (134.70.24.1) from this server, so the call was not sent. " +
        OCI_PRIVATE_PATH_ADVICE,
    );
    expect(refusals).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("sends to an endpoint whose name resolves privately", async () => {
    const env = {
      OCI_KMS_CRYPTO_ENDPOINT: "https://private-vault.example.test",
      KMS_REQUIRE_PRIVATE: "true",
    };
    const w = await createOciKmsProvider(ociKmsConfigFromEnv(KEY, env), {
      credentials: identity(),
    }).wrapDek(DEK);
    expect(w.provider).toBe("oci");
    expect(sent).toEqual(["https://private-vault.example.test/20180608/encrypt"]);
  });

  it("the keyring's OCI provider signs with the configured API key and audits a refusal, the app as the actor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oci-kms-"));
    writeFileSync(
      join(dir, "key.pem"),
      apiKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    writeFileSync(
      join(dir, "config"),
      `[DEFAULT]\nuser=ocid1.user.oc1..aaaar437\nfingerprint=${ociKeyFingerprint(apiKey.privateKey)}\ntenancy=ocid1.tenancy.oc1..aaaar437\nkey_file=key.pem\n`,
    );
    const env = { ...ENV, OCI_CONFIG_FILE: join(dir, "config") };
    // Unrestricted, the real chain's signature is accepted by the fake Vault.
    const w = await providerFor({ provider: "oci", keyRef: KEY }, env).wrapDek(DEK);
    expect(w.provider).toBe("oci");
    expect(sent).toEqual([`${CRYPTO}/20180608/encrypt`]);
    sent = [];
    const p = providerFor(
      { provider: "oci", keyRef: KEY },
      { ...env, KMS_REQUIRE_PRIVATE: "true" },
    );
    await expect(p.wrapDek(DEK)).rejects.toThrow(PrivatePathRequiredError);
    expect(sent).toEqual([]);
    expect(vi.mocked(auditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        actorEmail: "system:kms",
        action: "security.kms.private_path.refused",
        resourceName: KEY,
        detail: expect.objectContaining({
          provider: "oci",
          key_ref: KEY,
          endpoint: CRYPTO,
          reason: expect.stringMatching(/^OCI Vault is set to require a private network path/),
        }),
      }),
    );
  });
});

describe("the keyring with OCI Vault", () => {
  it("is the configured external provider for a key OCID", () => {
    const p = configuredExternalProvider({ KMS_KEY_REF: KEY, ...ENV });
    expect(p?.id).toBe("oci");
    expect(p?.keyRef).toBe(KEY);
  });

  it("creates a data key: 32 random bytes, encrypted, proven to decrypt, then stored", async () => {
    const vault = fakeVault();
    const row = await createDataKey({ provider: provider(vault), createdBy: "admin-1" });
    expect(vault.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/20180608/encrypt",
      "/20180608/decrypt",
    ]);
    expect(db.ops.map((o) => o.op)).toEqual(["update", "insert"]);
    expect(db.ops[0].filters).toEqual([
      ["eq", "provider", "oci"],
      ["is", "retired_at", null],
    ]);
    const stored = db.ops[1].payload as Record<string, unknown>;
    expect(stored).toMatchObject({ provider: "oci", key_ref: KEY, created_by: "admin-1" });
    expect(JSON.parse(String(stored.material)).keyVersionId).toBe(VERSION);
    expect(row.kid).toMatch(/^[0-9a-f]{12}$/);
  });

  it("stores nothing when decrypt does not give the same bytes back", async () => {
    const vault = fakeVault({
      answer: (c) =>
        c.url.endsWith("/decrypt")
          ? new Response(
              JSON.stringify({
                plaintext: Buffer.alloc(32).toString("base64"),
                keyId: KEY,
                keyVersionId: VERSION,
              }),
            )
          : null,
    });
    await expect(createDataKey({ provider: provider(vault), createdBy: null })).rejects.toThrow(
      /did not unwrap it to the same bytes/,
    );
    expect(db.ops).toEqual([]);
  });
});
