// R431: Azure Key Vault (and Managed HSM) as a key provider. The provider
// against a fake vault that records each request, the key references it
// accepts, the private-path rule through the real guarded fetch, and the
// keyring creating a data key with it. The protocol against an emulator is
// tests/integration/azureKeyVaultEmulator.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic DNS for the private-path cases: no network.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host.startsWith("kv-private.")) return [{ address: "10.20.0.7", family: 4 }];
    return [{ address: "20.38.0.10", family: 4 }];
  },
}));

// The data key's row: a recording stand-in for the table.
const db = vi.hoisted(() => ({ ops: [] as Array<{ op: string; payload?: unknown }> }));
vi.mock("@/integrations/supabase/client.server", () => {
  const table = {
    update(payload: unknown) {
      db.ops.push({ op: "update", payload });
      return { is: async () => ({ error: null }) };
    },
    insert(payload: Record<string, unknown>) {
      db.ops.push({ op: "insert", payload });
      return {
        select: () => ({
          single: async () => ({
            data: { id: "row-1", created_at: "2026-11-01T00:00:00Z", retired_at: null, ...payload },
            error: null,
          }),
        }),
      };
    },
  };
  return { supabaseAdmin: { from: () => table } };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));

import type { AzureCredentialChain } from "@/utils/azure/credentials.server";
import {
  AZURE_KEY_VAULT_API,
  AZURE_PRIVATE_PATH_ADVICE,
  AzureKeyVaultError,
  azureKeyVaultConfigFromEnv,
  checkedKid,
  createAzureKeyVaultProvider,
  rsaBits,
  wrapAlgorithmFor,
  type AzureKeyVaultConfig,
} from "@/utils/kms/azure.server";
import { configuredExternalProvider, createDataKey, providerFor } from "@/utils/kms/keyring.server";
import {
  KmsConfigError,
  keyRefProvider,
  kmsConfigFromEnv,
  parseAzureKeyRef,
} from "@/utils/kms/types";
import { PrivatePathRequiredError, SsrfRefusedError } from "@/utils/ssrfGuard.server";
import { auditEvent } from "@/utils/audit.server";

const VAULT = "https://agentswarms-kv.vault.azure.net";
const KEY_REF = `${VAULT}/keys/credential-kek`;
const V1 = "0123456789abcdef0123456789abcdef";
const V2 = "fedcba9876543210fedcba9876543210";

const token: AzureCredentialChain = {
  source: "client-secret",
  get: async () => ({
    token: "the-access-token",
    expiresAt: Date.now() + 3_600_000,
    source: "client-secret",
    identity: "service principal 1111 in tenant 2222 (AZURE_CLIENT_SECRET)",
  }),
};

type Call = {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
};

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (
  status: number,
  code: string,
  message: string,
  inner?: string,
  headers?: HeadersInit,
) =>
  new Response(
    JSON.stringify({ error: { code, message, ...(inner ? { innererror: { code: inner } } : {}) } }),
    { status, headers },
  );

function fakeVault(
  answer: (method: string, path: string, body: Record<string, unknown> | null) => Response,
) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({
      method: init.method ?? "GET",
      url,
      body,
      headers: init.headers as Record<string, string>,
    });
    const u = new URL(url);
    return answer(init.method ?? "GET", u.pathname, body);
  };
  return { calls, fetchImpl };
}

const DEK = new Uint8Array(32).map((_, i) => i + 1);
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function keyBody(
  over: {
    kty?: string;
    ops?: string[];
    attributes?: Record<string, unknown>;
    version?: string;
  } = {},
) {
  return {
    key: {
      kid: `${KEY_REF}/${over.version ?? V1}`,
      kty: over.kty ?? "RSA",
      key_ops: over.ops ?? ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
      n: Buffer.alloc(256, 0xc1).toString("base64url"),
      e: "AQAB",
    },
    attributes: { enabled: true, recoveryLevel: "Recoverable", ...over.attributes },
  };
}

/** A vault that "wraps" by prefixing, and checks the key version like Key Vault does. */
function workingVault(kty = "RSA") {
  return fakeVault((method, path, body) => {
    if (method === "GET" && path === "/keys/credential-kek") return ok(keyBody({ kty }));
    if (method === "POST" && path === `/keys/credential-kek/${V1}/wrapkey`) {
      return ok({ kid: `${KEY_REF}/${V1}`, value: `w.${body!.alg}.${body!.value}` });
    }
    if (method === "POST" && path === `/keys/credential-kek/${V1}/unwrapkey`) {
      const v = String(body!.value);
      if (!v.startsWith(`w.${body!.alg}.`))
        return fail(400, "BadParameter", "The parameter is incorrect.");
      return ok({ kid: `${KEY_REF}/${V1}`, value: v.slice(`w.${body!.alg}.`.length) });
    }
    return fail(
      404,
      "KeyNotFound",
      `A key with (name/id) ${path} was not found in this key vault.`,
    );
  });
}

function config(over: Partial<AzureKeyVaultConfig> = {}): AzureKeyVaultConfig {
  return { ...parseAzureKeyRef(KEY_REF), requirePrivate: false, ...over };
}

const noSleep = async () => {};

beforeEach(() => {
  db.ops = [];
  vi.mocked(auditEvent).mockClear();
});

describe("key references", () => {
  it("reads a Key Vault or Managed HSM key identifier, and the scope its tokens need", () => {
    expect(parseAzureKeyRef(KEY_REF)).toEqual({
      keyRef: KEY_REF,
      vault: VAULT,
      name: "credential-kek",
      version: null,
      kind: "vault",
      scope: "https://vault.azure.net/.default",
    });
    expect(parseAzureKeyRef(`${KEY_REF}/${V1}/`)).toMatchObject({
      version: V1,
      keyRef: `${KEY_REF}/${V1}`,
    });
    expect(parseAzureKeyRef("https://contoso-hsm.managedhsm.azure.net/keys/kek")).toMatchObject({
      kind: "managed-hsm",
      scope: "https://managedhsm.azure.net/.default",
    });
    expect(parseAzureKeyRef("https://kv-cn1.vault.azure.cn/keys/k").scope).toBe(
      "https://vault.azure.cn/.default",
    );
    expect(parseAzureKeyRef("https://kv-gov1.vault.usgovcloudapi.net/keys/k").scope).toBe(
      "https://vault.usgovcloudapi.net/.default",
    );
    // Host names are case-insensitive; the stored reference is normalised.
    expect(
      parseAzureKeyRef("https://AgentSwarms-KV.Vault.Azure.Net/keys/credential-kek").keyRef,
    ).toBe(KEY_REF);
  });

  it("refuses anything that is not a key on Azure's own vault domains", () => {
    for (const bad of [
      "http://agentswarms-kv.vault.azure.net/keys/k",
      "https://agentswarms-kv.vault.azure.net:8443/keys/k",
      "https://agentswarms-kv.vault.azure.net/keys/k?x=1",
      "https://user@agentswarms-kv.vault.azure.net/keys/k",
      "https://agentswarms-kv.vault.azure.net/secrets/k",
      "https://agentswarms-kv.vault.azure.net/keys/",
      "https://agentswarms-kv.vault.azure.net.evil.example/keys/k",
      "https://evil.example/keys/k",
      "https://evilvault.azure.netx/keys/k", // the domain must END the name
      "https://vault.azure.net/keys/k",
      "https://ab.vault.azure.net/keys/k", // vault names are 3–24 characters
      "https://a--b.vault.azure.net/keys/k",
      "https://1kv.vault.azure.net/keys/k",
      "https://agentswarms-kv.vault.azure.net/keys/bad_name",
      "https://agentswarms-kv.vault.azure.net/keys/k/not-hex!",
    ]) {
      expect(() => parseAzureKeyRef(bad), bad).toThrow(KmsConfigError);
    }
  });

  it("is recognised by its shape, and KMS_PROVIDER=azure is built", () => {
    expect(keyRefProvider(KEY_REF)).toBe("azure");
    expect(keyRefProvider("https://evil.example/keys/k")).toBe(null);
    expect(kmsConfigFromEnv({ KMS_PROVIDER: "azure", KMS_KEY_REF: KEY_REF })).toEqual({
      provider: "azure",
      keyRef: KEY_REF,
    });
    expect(
      azureKeyVaultConfigFromEnv(KEY_REF, { KMS_REQUIRE_PRIVATE: "true" }).requirePrivate,
    ).toBe(true);
  });

  it("checks a stored key id against the row's own key", () => {
    expect(checkedKid(`${KEY_REF}/${V1}`, KEY_REF)).toBe(`${KEY_REF}/${V1}`);
    expect(() =>
      checkedKid(`https://attacker.vault.azure.net/keys/credential-kek/${V1}`, KEY_REF),
    ).toThrow(/is not a version of/);
    expect(() => checkedKid(`${VAULT}/keys/other-key/${V1}`, KEY_REF)).toThrow(
      /is not a version of/,
    );
    expect(() => checkedKid(`${KEY_REF}/${V1}/../x`, KEY_REF)).toThrow(/is not a version of/);
    expect(() => checkedKid(`${KEY_REF}`, KEY_REF)).toThrow(/is not a version of/);
    // A reference that pins a version accepts that version only.
    expect(() => checkedKid(`${KEY_REF}/${V2}`, `${KEY_REF}/${V1}`)).toThrow(/is not a version of/);
  });

  it("reads an RSA key's size from its modulus, a leading zero byte or not", () => {
    const n2048 = Buffer.alloc(256, 0xff);
    expect(rsaBits(n2048.toString("base64url"))).toBe(2048);
    // The emulator's signed encoding: 257 bytes for the same key.
    expect(rsaBits(Buffer.concat([Buffer.from([0]), n2048]).toString("base64url"))).toBe(2048);
    expect(
      rsaBits(Buffer.concat([Buffer.from([0x40]), Buffer.alloc(383, 1)]).toString("base64url")),
    ).toBe(3071);
    expect(rsaBits("")).toBe(null);
    expect(rsaBits(undefined)).toBe(null);
    expect(rsaBits(Buffer.alloc(4).toString("base64url"))).toBe(null);
  });

  it("wraps with RSA-OAEP-256 for RSA keys and A256KW for a Managed HSM AES key", () => {
    expect(wrapAlgorithmFor("RSA")).toBe("RSA-OAEP-256");
    expect(wrapAlgorithmFor("RSA-HSM")).toBe("RSA-OAEP-256");
    expect(wrapAlgorithmFor("oct-HSM")).toBe("A256KW");
    expect(() => wrapAlgorithmFor("EC")).toThrow(/needs an RSA key/);
  });
});

describe("the calls", () => {
  it("wraps with the key's current version and keeps that version with the material", async () => {
    const { calls, fetchImpl } = workingVault();
    const p = createAzureKeyVaultProvider(config(), { credentials: token, fetch: fetchImpl });
    const w = await p.wrapDek(DEK);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${KEY_REF}?api-version=${AZURE_KEY_VAULT_API}`,
      `POST ${KEY_REF}/${V1}/wrapkey?api-version=${AZURE_KEY_VAULT_API}`,
    ]);
    expect(calls[1].body).toEqual({ alg: "RSA-OAEP-256", value: b64url(DEK) });
    expect(calls[1].headers).toEqual({
      authorization: "Bearer the-access-token",
      "content-type": "application/json",
    });
    expect(w.provider).toBe("azure");
    expect(w.keyRef).toBe(KEY_REF);
    expect(JSON.parse(w.material)).toEqual({
      kid: `${KEY_REF}/${V1}`,
      alg: "RSA-OAEP-256",
      value: `w.RSA-OAEP-256.${b64url(DEK)}`,
    });
    expect(await p.unwrapDek(w)).toEqual(DEK);
    expect(calls[2].url).toBe(`${KEY_REF}/${V1}/unwrapkey?api-version=${AZURE_KEY_VAULT_API}`);
  });

  it("refuses to wrap with a key that is disabled or may not wrap, before calling wrapKey", async () => {
    for (const body of [keyBody({ attributes: { enabled: false } }), keyBody({ ops: ["sign"] })]) {
      const { calls, fetchImpl } = fakeVault(() => ok(body));
      await expect(
        createAzureKeyVaultProvider(config(), { credentials: token, fetch: fetchImpl }).wrapDek(
          DEK,
        ),
      ).rejects.toThrow(/disabled|do not include wrapKey/);
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
    }
  });

  it("uses AES key wrap with a Managed HSM AES key", async () => {
    const { calls, fetchImpl } = workingVault("oct-HSM");
    const w = await createAzureKeyVaultProvider(config(), {
      credentials: token,
      fetch: fetchImpl,
    }).wrapDek(DEK);
    expect(calls[1].body).toMatchObject({ alg: "A256KW" });
    expect(JSON.parse(w.material).alg).toBe("A256KW");
  });

  it("unwraps only material of the row's own key, in an algorithm it uses", async () => {
    const { calls, fetchImpl } = workingVault();
    const p = createAzureKeyVaultProvider(config(), { credentials: token, fetch: fetchImpl });
    const material = (kid: string, alg = "RSA-OAEP-256") =>
      JSON.stringify({ kid, alg, value: "x" });
    await expect(
      p.unwrapDek({
        provider: "azure",
        keyRef: KEY_REF,
        material: material(`https://attacker.vault.azure.net/keys/credential-kek/${V1}`),
      }),
    ).rejects.toThrow(/is not a version of/);
    await expect(
      p.unwrapDek({
        provider: "azure",
        keyRef: KEY_REF,
        material: material(`${KEY_REF}/${V1}`, "RSA1_5"),
      }),
    ).rejects.toThrow(/names the algorithm RSA1_5/);
    await expect(
      p.unwrapDek({ provider: "azure", keyRef: KEY_REF, material: "not json" }),
    ).rejects.toThrow(/not Azure Key Vault material/);
    await expect(p.unwrapDek({ provider: "aws", keyRef: KEY_REF, material: "{}" })).rejects.toThrow(
      /wrapped by aws, not Azure Key Vault/,
    );
    expect(calls).toEqual([]); // none of these reached the vault
  });

  it("says what Key Vault refused and what to do about it", async () => {
    const forbidden = fakeVault(() =>
      fail(
        403,
        "Forbidden",
        "Caller is not authorized to perform action on resource.",
        "ForbiddenByRbac",
      ),
    );
    const err = (await createAzureKeyVaultProvider(config(), {
      credentials: token,
      fetch: forbidden.fetchImpl,
    })
      .wrapDek(DEK)
      .catch((e: unknown) => e)) as AzureKeyVaultError;
    expect(err).toBeInstanceOf(AzureKeyVaultError);
    expect(err.code).toBe("ForbiddenByRbac");
    expect(err.message).toBe(
      "Azure Key Vault get key refused (403 ForbiddenByRbac): Caller is not authorized to perform action on resource. " +
        "Give the app's identity the Key Vault Crypto Service Encryption User role on the key or the vault (get, wrapKey and unwrapKey).",
    );
    const missing = fakeVault(() =>
      fail(
        404,
        "KeyNotFound",
        "A key with (name/id) credential-kek was not found in this key vault.",
      ),
    );
    await expect(
      createAzureKeyVaultProvider(config(), {
        credentials: token,
        fetch: missing.fetchImpl,
      }).wrapDek(DEK),
    ).rejects.toThrow(/\(404 KeyNotFound\).*Check KMS_KEY_REF/);
  });

  it("retries throttling and server errors, honouring Retry-After up to five seconds", async () => {
    let n = 0;
    const slept: number[] = [];
    const { calls, fetchImpl } = fakeVault(() =>
      ++n === 1
        ? fail(
            429,
            "Throttled",
            "Request was not processed because too many requests were received.",
            undefined,
            {
              "retry-after": "30",
            },
          )
        : n === 2
          ? fail(503, "ServiceUnavailable", "")
          : ok(keyBody()),
    );
    const r = await createAzureKeyVaultProvider(config(), {
      credentials: token,
      fetch: fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).probe();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([5000, 800]);
    const down = fakeVault(() => fail(500, "InternalError", "boom"));
    await expect(
      createAzureKeyVaultProvider(config(), {
        credentials: token,
        fetch: down.fetchImpl,
        sleep: noSleep,
      }).wrapDek(DEK),
    ).rejects.toThrow(/\(500 InternalError\): boom/);
    expect(down.calls).toHaveLength(3);
  });

  it("an unreachable vault is named; a refusal by the guard reads alone", async () => {
    const unreachable = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    };
    await expect(
      createAzureKeyVaultProvider(config(), { credentials: token, fetch: unreachable }).wrapDek(
        DEK,
      ),
    ).rejects.toThrow(
      "Azure Key Vault get key: agentswarms-kv.vault.azure.net could not be reached (ENOTFOUND)",
    );
    const guard = async () => {
      throw new SsrfRefusedError("refused");
    };
    const err = await createAzureKeyVaultProvider(config(), { credentials: token, fetch: guard })
      .wrapDek(DEK)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfRefusedError);
    expect((err as Error).message).toBe("refused");
  });
});

describe("the probe", () => {
  const facts = (r: { facts?: Array<{ label: string; value: string }> }) =>
    Object.fromEntries((r.facts ?? []).map((f) => [f.label, f.value]));
  const probing = (body: unknown) =>
    createAzureKeyVaultProvider(config(), {
      credentials: token,
      fetch: fakeVault(() => ok(body)).fetchImpl,
    }).probe();

  it("names the key version, what protects it, its recovery, and who the app signs in as", async () => {
    const r = await probing(keyBody());
    expect(r).toMatchObject({
      ok: true,
      detail: "Enabled for wrapKey and unwrapKey (RSA-OAEP-256).",
    });
    expect(facts(r)).toMatchObject({
      "Signed in as": "service principal 1111 in tenant 2222 (AZURE_CLIENT_SECRET)",
      Key: `${KEY_REF}/${V1}`,
      "Key type": "RSA 2048-bit key, software-protected",
      State: "Enabled",
      Recovery: "Recoverable (purge protection on)",
    });
    expect(facts(r).Endpoint).toMatch(
      /^https:\/\/agentswarms-kv\.vault\.azure\.net · direct to 20\.38\.0\.10 \(public\)/,
    );
    expect(facts(await probing(keyBody({ kty: "RSA-HSM" })))["Key type"]).toBe(
      "RSA 2048-bit key in Key Vault Premium's HSMs",
    );
    expect(
      facts(await probing(keyBody({ attributes: { recoveryLevel: "Recoverable+Purgeable" } })))
        .Recovery,
    ).toBe(
      "Recoverable+Purgeable: a purge destroys every credential this key wraps; turn on purge protection",
    );
  });

  it("says a Managed HSM key lives in the customer's own pool", async () => {
    const p = createAzureKeyVaultProvider(
      {
        ...parseAzureKeyRef("https://contoso-hsm.managedhsm.azure.net/keys/credential-kek"),
        requirePrivate: false,
      },
      {
        credentials: token,
        fetch: fakeVault(() =>
          ok({
            key: {
              kid: `https://contoso-hsm.managedhsm.azure.net/keys/credential-kek/${V1}`,
              kty: "oct-HSM",
              key_ops: ["wrapKey", "unwrapKey"],
            },
            attributes: { enabled: true, recoveryLevel: "Recoverable" },
          }),
        ).fetchImpl,
      },
    );
    const r = await p.probe();
    expect(r).toMatchObject({ ok: true, detail: "Enabled for wrapKey and unwrapKey (A256KW)." });
    expect(facts(r)["Key type"]).toBe("AES key in your Managed HSM pool (single-tenant HSMs)");
  });

  it("fails for a key that is disabled, expired, not yet active, not allowed to wrap, or not RSA/AES", async () => {
    expect(await probing(keyBody({ attributes: { enabled: false } }))).toMatchObject({
      ok: false,
      detail: "The key is disabled; only an enabled key can wrap or unwrap.",
    });
    expect((await probing(keyBody({ attributes: { exp: 1_600_000_000 } }))).detail).toBe(
      "The key expired on 2020-09-13.",
    );
    expect((await probing(keyBody({ attributes: { nbf: 4_100_000_000 } }))).detail).toMatch(
      /not active until 2099/,
    );
    expect((await probing(keyBody({ ops: ["sign", "verify"] }))).detail).toBe(
      "The key's permitted operations (sign, verify) do not include wrapKey and unwrapKey.",
    );
    expect(await probing(keyBody({ kty: "EC" }))).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/needs an RSA key/),
    });
  });

  it("a key id from another key in the answer is refused, not trusted", async () => {
    const r = await probing({
      ...keyBody(),
      key: { ...keyBody().key, kid: `${VAULT}/keys/other/${V1}` },
    });
    expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/is not a version of/) });
  });

  it("a sign-in failure is the probe's answer, with the facts gathered so far", async () => {
    const broken: AzureCredentialChain = {
      source: "workload-identity",
      get: async () => {
        throw new Error(
          "Microsoft Entra ID refused a token for workload identity x: invalid_client: AADSTS700213",
        );
      },
    };
    const { calls, fetchImpl } = workingVault();
    const r = await createAzureKeyVaultProvider(config(), {
      credentials: broken,
      fetch: fetchImpl,
    }).probe();
    expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/AADSTS700213/) });
    expect(facts(r).Endpoint).toBeDefined();
    expect(calls).toEqual([]);
  });
});

describe("KMS_REQUIRE_PRIVATE, through the real guarded fetch", () => {
  const realFetch = globalThis.fetch;
  let sent: string[] = [];
  const secretEnv = {
    AZURE_TENANT_ID: "72f988bf-86f1-41af-91ab-2d7cd011db47",
    AZURE_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
    AZURE_CLIENT_SECRET: "s",
  };
  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      sent.push(url);
      if (url.startsWith("https://login.microsoftonline.com/")) {
        return ok({ access_token: "t", expires_in: 3600 });
      }
      if (url.includes("/unwrapkey")) return ok({ value: b64url(DEK) });
      return ok(keyBody());
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a public vault address before anything is sent to it; the Entra ID sign-in is not held", async () => {
    const refusals: string[] = [];
    const p = createAzureKeyVaultProvider(config({ requirePrivate: true }), {
      env: secretEnv,
      onRefuse: (d) => refusals.push(d),
    });
    const err = (await p
      .unwrapDek({
        provider: "azure",
        keyRef: KEY_REF,
        material: JSON.stringify({ kid: `${KEY_REF}/${V1}`, alg: "RSA-OAEP-256", value: "x" }),
      })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PrivatePathRequiredError);
    expect(err.message).toBe(
      "Azure Key Vault is set to require a private network path, but agentswarms-kv.vault.azure.net " +
        "resolves to a public address (20.38.0.10) from this server, so the call was not sent. " +
        AZURE_PRIVATE_PATH_ADVICE,
    );
    expect(err.message).not.toMatch(/model traffic/);
    expect(refusals).toHaveLength(1);
    // Entra ID has no private endpoint: the sign-in went, the vault call did not.
    expect(sent).toEqual([
      "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/token",
    ]);
  });

  it("sends to a vault whose name resolves privately (its private endpoint)", async () => {
    const ref = "https://kv-private.vault.azure.net/keys/credential-kek";
    const p = createAzureKeyVaultProvider(
      { ...parseAzureKeyRef(ref), requirePrivate: true },
      { env: secretEnv },
    );
    const dek = await p.unwrapDek({
      provider: "azure",
      keyRef: ref,
      material: JSON.stringify({ kid: `${ref}/${V1}`, alg: "RSA-OAEP-256", value: "x" }),
    });
    expect(dek).toEqual(DEK);
    expect(sent[1]).toBe(`${ref}/${V1}/unwrapkey?api-version=${AZURE_KEY_VAULT_API}`);
  });

  it("the keyring's Azure provider audits a refusal, with the app as the actor", async () => {
    const p = providerFor(
      { provider: "azure", keyRef: KEY_REF },
      { KMS_REQUIRE_PRIVATE: "true", ...secretEnv },
    );
    await expect(
      p.unwrapDek({
        provider: "azure",
        keyRef: KEY_REF,
        material: JSON.stringify({ kid: `${KEY_REF}/${V1}`, alg: "RSA-OAEP-256", value: "x" }),
      }),
    ).rejects.toThrow(PrivatePathRequiredError);
    expect(vi.mocked(auditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        actorEmail: "system:kms",
        action: "security.kms.private_path.refused",
        resourceName: KEY_REF,
        detail: expect.objectContaining({
          provider: "azure",
          key_ref: KEY_REF,
          reason: expect.stringMatching(
            /^Azure Key Vault is set to require a private network path/,
          ),
        }),
      }),
    );
  });
});

describe("the keyring with Azure Key Vault", () => {
  it("is the configured external provider for an Azure key reference", () => {
    const p = configuredExternalProvider({
      KMS_KEY_REF: KEY_REF,
      AZURE_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
    });
    expect(p?.id).toBe("azure");
    expect(p?.keyRef).toBe(KEY_REF);
  });

  it("creates a data key: 32 random bytes, wrapped, proven to unwrap, then stored", async () => {
    const { calls, fetchImpl } = workingVault();
    const p = createAzureKeyVaultProvider(config(), { credentials: token, fetch: fetchImpl });
    const row = await createDataKey({ provider: p, createdBy: "admin-1" });
    expect(calls.map((c) => c.url.replace(/\?.*/, "").replace(VAULT, ""))).toEqual([
      "/keys/credential-kek",
      `/keys/credential-kek/${V1}/wrapkey`,
      `/keys/credential-kek/${V1}/unwrapkey`,
    ]);
    expect(db.ops.map((o) => o.op)).toEqual(["update", "insert"]);
    const stored = db.ops[1].payload as Record<string, unknown>;
    expect(stored).toMatchObject({ provider: "azure", key_ref: KEY_REF, created_by: "admin-1" });
    expect(JSON.parse(String(stored.material)).kid).toBe(`${KEY_REF}/${V1}`);
    expect(row.kid).toMatch(/^[0-9a-f]{12}$/);
  });

  it("stores nothing when unwrapKey does not give the same bytes back", async () => {
    const { fetchImpl } = fakeVault((method, path, body) => {
      if (method === "GET") return ok(keyBody());
      if (path.endsWith("/wrapkey"))
        return ok({ kid: `${KEY_REF}/${V1}`, value: `w.${body!.value}` });
      return ok({ value: b64url(new Uint8Array(32)) });
    });
    const p = createAzureKeyVaultProvider(config(), { credentials: token, fetch: fetchImpl });
    await expect(createDataKey({ provider: p, createdBy: null })).rejects.toThrow(
      /did not unwrap it to the same bytes/,
    );
    expect(db.ops).toEqual([]);
  });
});
