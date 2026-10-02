// Envelope encryption: the keyring under each provider, the Vault Transit
// provider against a fake Vault, and the fail-closed paths that decide
// whether the feature is safe. Nothing is re-implemented: the real keyring,
// the real crypto module.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  __setKeyringLoaderForTests,
  currentKid,
  decryptJson,
  encryptJson,
  keyringFingerprints,
  keyringReady,
  reEncryptBlob,
  resetKeyringCache,
} from "@/utils/providers/crypto.server";
import {
  buildKeyring,
  createDataKey,
  envProvider,
  kidOfDek,
  kidOfSecret,
  type DekRow,
} from "@/utils/kms/keyring.server";
import {
  KmsConfigError,
  base64ToBytes,
  bytesToBase64,
  kmsConfigFromEnv,
  parseVaultKeyRef,
  type KeyProvider,
  type WrappedDek,
} from "@/utils/kms/types";
import { createVaultProvider, vaultConfigFromEnv } from "@/utils/kms/vault.server";

const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);

/** A provider that XORs with a fixed pad — enough to prove wrap/unwrap plumbing. */
function fakeProvider(
  opts: { pad?: number; failUnwrap?: boolean; corrupt?: boolean } = {},
): KeyProvider {
  const pad = opts.pad ?? 0x5a;
  return {
    id: "vault",
    keyRef: "transit/keys/fake",
    async wrapDek(dek) {
      const out = dek.map((b) => b ^ pad);
      return {
        provider: "vault",
        keyRef: "transit/keys/fake",
        material: `fake:${bytesToBase64(out)}`,
      };
    },
    async unwrapDek(w: WrappedDek) {
      if (opts.failUnwrap) throw new Error("permission denied");
      const bytes = base64ToBytes(w.material.replace(/^fake:/, "")).map((b) => b ^ pad);
      if (opts.corrupt) bytes[0] ^= 0xff;
      return bytes;
    },
    async probe() {
      return { ok: true, detail: "fake" };
    },
  };
}

async function dekRow(provider: KeyProvider, dek: Uint8Array, retired = false): Promise<DekRow> {
  const w = await provider.wrapDek(dek);
  return {
    id: crypto.randomUUID(),
    provider: "vault",
    key_ref: w.keyRef,
    material: w.material,
    kid: await kidOfDek(dek),
    created_at: new Date().toISOString(),
    retired_at: retired ? new Date().toISOString() : null,
  };
}

const original = { ...process.env };
afterEach(() => {
  __setKeyringLoaderForTests(null);
  resetKeyringCache();
  for (const k of [
    "KMS_PROVIDER",
    "KMS_KEY_REF",
    "PROVIDER_CREDS_SECRET",
    "PROVIDER_CREDS_SECRET_OLD",
    "VAULT_ADDR",
    "VAULT_TOKEN",
  ]) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("reading the configuration", () => {
  it("defaults to env, and env needs nothing else", () => {
    expect(kmsConfigFromEnv({})).toEqual({ provider: "env" });
    expect(kmsConfigFromEnv({ KMS_PROVIDER: "ENV " })).toEqual({ provider: "env" });
  });

  it("refuses an unknown provider, a designed-not-built one, and a missing key ref — by name", () => {
    expect(() => kmsConfigFromEnv({ KMS_PROVIDER: "kms" })).toThrow(/not a key provider/);
    expect(() => kmsConfigFromEnv({ KMS_PROVIDER: "aws", KMS_KEY_REF: "arn:x" })).toThrow(
      /not built/,
    );
    expect(() => kmsConfigFromEnv({ KMS_PROVIDER: "vault" })).toThrow(/KMS_KEY_REF/);
    expect(kmsConfigFromEnv({ KMS_PROVIDER: "vault", KMS_KEY_REF: "transit/keys/app" })).toEqual({
      provider: "vault",
      keyRef: "transit/keys/app",
    });
  });

  it("reads a Vault key ref and the Vault variables, and knows when Vault is absent", () => {
    expect(parseVaultKeyRef("transit/keys/app")).toEqual({ mount: "transit", name: "app" });
    expect(() => parseVaultKeyRef("app")).toThrow(KmsConfigError);
    expect(vaultConfigFromEnv("transit/keys/app", {})).toBeNull();
    expect(() => vaultConfigFromEnv("transit/keys/app", { VAULT_ADDR: "http://v:8200" })).toThrow(
      /no way to authenticate/,
    );
    const c = vaultConfigFromEnv("transit/keys/app", {
      VAULT_ADDR: "http://v:8200/",
      VAULT_TOKEN: "t",
    });
    expect(c?.addr).toBe("http://v:8200");
    expect(c?.k8sMount).toBe("kubernetes");
  });
});

describe("the keyring under the env provider is what it always was", () => {
  it("derives the key and fingerprint from PROVIDER_CREDS_SECRET and accepts previous secrets", async () => {
    const k = await buildKeyring({
      config: { provider: "env" },
      envSecret: SECRET_A,
      envPrevious: [SECRET_B, SECRET_A],
      rows: [],
      provider: null,
    });
    expect(k.current.kid).toBe(await kidOfSecret(SECRET_A));
    expect(k.previous.map((p) => p.kid)).toEqual([await kidOfSecret(SECRET_B)]);
    expect(k.activeDek).toBeNull();
  });

  it("refuses to run without a secret rather than inventing one", async () => {
    await expect(
      buildKeyring({
        config: { provider: "env" },
        envSecret: undefined,
        envPrevious: [],
        rows: [],
        provider: null,
      }),
    ).rejects.toThrow(/PROVIDER_CREDS_SECRET is not configured/);
  });
});

describe("the keyring under an external provider", () => {
  const config = { provider: "vault" as const, keyRef: "transit/keys/fake" };

  it("unwraps the active data key and keeps retired keys and env secrets for reading", async () => {
    const provider = fakeProvider();
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const oldDek = crypto.getRandomValues(new Uint8Array(32));
    const k = await buildKeyring({
      config,
      envSecret: SECRET_A,
      envPrevious: [],
      rows: [await dekRow(provider, dek), await dekRow(provider, oldDek, true)],
      provider,
    });
    expect(k.current.kid).toBe(await kidOfDek(dek));
    expect(k.current.source).toBe("dek");
    expect(k.previous.map((p) => p.source)).toEqual(["dek-retired", "env"]);
    expect(k.activeDek?.kid).toBe(k.current.kid);
  });

  it("fails closed: no data key, wrong key ref, unwrap refused, corrupt material — never a fresh key", async () => {
    const provider = fakeProvider();
    const dek = crypto.getRandomValues(new Uint8Array(32));
    await expect(
      buildKeyring({ config, envSecret: SECRET_A, envPrevious: [], rows: [], provider }),
    ).rejects.toThrow(/no data key exists/);
    const row = await dekRow(provider, dek);
    await expect(
      buildKeyring({
        config: { ...config, keyRef: "transit/keys/other" },
        envSecret: SECRET_A,
        envPrevious: [],
        rows: [row],
        provider,
      }),
    ).rejects.toThrow(/KMS_KEY_REF is transit\/keys\/other/);
    await expect(
      buildKeyring({
        config,
        envSecret: SECRET_A,
        envPrevious: [],
        rows: [row],
        provider: fakeProvider({ failUnwrap: true }),
      }),
    ).rejects.toThrow(/Could not unwrap the data key .*permission denied/);
    await expect(
      buildKeyring({
        config,
        envSecret: SECRET_A,
        envPrevious: [],
        rows: [row],
        provider: fakeProvider({ corrupt: true }),
      }),
    ).rejects.toThrow(/fingerprint .* does not match/);
    // The mutation that would hide all of the above: a keyring that wraps a
    // new key when it cannot unwrap the old one.
    const src = readFileSync("src/utils/kms/keyring.server.ts", "utf8");
    const build = src.slice(
      src.indexOf("export async function buildKeyring"),
      src.indexOf("function dedupe"),
    );
    expect(build).not.toMatch(/\bwrapDek\(/);
    expect(build).not.toContain("getRandomValues");
  });

  it("a switch is a rotation: what env wrote still reads, what is written goes under the data key", async () => {
    process.env.PROVIDER_CREDS_SECRET = SECRET_A;
    delete process.env.KMS_PROVIDER;
    resetKeyringCache();
    const underEnv = await encryptJson({ token: "sk-live" });
    expect(underEnv.kid).toBe(await kidOfSecret(SECRET_A));

    const provider = fakeProvider();
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const rows = [await dekRow(provider, dek)];
    __setKeyringLoaderForTests(() =>
      buildKeyring({ config, envSecret: SECRET_A, envPrevious: [], rows, provider }),
    );
    expect(await currentKid()).toBe(await kidOfDek(dek));
    expect(await decryptJson(underEnv.ciphertext, underEnv.iv, underEnv.kid)).toEqual({
      token: "sk-live",
    });
    const moved = await reEncryptBlob(underEnv);
    expect(moved.changed).toBe(true);
    expect(moved.blob.kid).toBe(await kidOfDek(dek));
    expect(await decryptJson(moved.blob.ciphertext, moved.blob.iv)).toEqual({ token: "sk-live" });
    const fp = await keyringFingerprints();
    expect(fp.previous).toContain(await kidOfSecret(SECRET_A));
    expect(await keyringReady()).toEqual({ ok: true });
  });

  it("readiness reports a keyring that cannot load, with the reason", async () => {
    __setKeyringLoaderForTests(async () => {
      throw new Error("Could not unwrap the data key (vault): permission denied");
    });
    const r = await keyringReady();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining("permission denied") });
  });

  it("creating a data key proves the round trip before storing anything", async () => {
    // A provider that wraps fine and unwraps to different bytes must be
    // refused before any row is written — the caller never reaches the DB.
    const liar: KeyProvider = {
      ...fakeProvider(),
      unwrapDek: async () => crypto.getRandomValues(new Uint8Array(32)),
    };
    await expect(createDataKey({ provider: liar, createdBy: null })).rejects.toThrow(
      /did not unwrap it to the same bytes/,
    );
  });

  it("the env provider keeps no wrapped key and says so", async () => {
    const p = envProvider({ PROVIDER_CREDS_SECRET: "x" });
    await expect(p.wrapDek(new Uint8Array(32))).rejects.toThrow(/cannot wrap/);
    expect((await p.probe()).ok).toBe(true);
    expect((await envProvider({}).probe()).ok).toBe(false);
  });
});

describe("the Vault Transit provider, against a fake Vault", () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
  function fakeVault(opts: { status?: number; keyType?: string } = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body,
      });
      if (opts.status && opts.status >= 400) {
        return new Response(JSON.stringify({ errors: ["permission denied"] }), {
          status: opts.status,
        });
      }
      if (url.endsWith("/auth/kubernetes/login")) {
        return new Response(JSON.stringify({ auth: { client_token: "k8s-token" } }), {
          status: 200,
        });
      }
      if (url.includes("/encrypt/")) {
        return new Response(
          JSON.stringify({ data: { ciphertext: `vault:v1:${body.plaintext}` } }),
          { status: 200 },
        );
      }
      if (url.includes("/decrypt/")) {
        return new Response(
          JSON.stringify({ data: { plaintext: body.ciphertext.replace(/^vault:v1:/, "") } }),
          { status: 200 },
        );
      }
      if (url.includes("/keys/")) {
        return new Response(JSON.stringify({ data: { type: opts.keyType ?? "aes256-gcm96" } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const config = vaultConfigFromEnv("transit/keys/app", {
    VAULT_ADDR: "http://vault:8200",
    VAULT_TOKEN: "root-token",
    VAULT_NAMESPACE: "team-a",
  })!;

  it("wraps and unwraps through transit with the token and namespace headers", async () => {
    const { calls, fetchImpl } = fakeVault();
    const p = createVaultProvider(config, fetchImpl);
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const w = await p.wrapDek(dek);
    expect(w).toEqual({
      provider: "vault",
      keyRef: "transit/keys/app",
      material: `vault:v1:${bytesToBase64(dek)}`,
    });
    expect(await p.unwrapDek(w)).toEqual(dek);
    expect(calls[0].url).toBe("http://vault:8200/v1/transit/encrypt/app");
    expect(calls[0].headers["X-Vault-Token"]).toBe("root-token");
    expect(calls[0].headers["X-Vault-Namespace"]).toBe("team-a");
    expect(calls[1].url).toBe("http://vault:8200/v1/transit/decrypt/app");
    expect((await p.probe()).ok).toBe(true);
    expect(calls[2].method).toBe("GET");
  });

  it("surfaces Vault's refusal with the status and the reason, and probe reports honestly", async () => {
    const { fetchImpl } = fakeVault({ status: 403 });
    const p = createVaultProvider(config, fetchImpl);
    await expect(
      p.unwrapDek({ provider: "vault", keyRef: "transit/keys/app", material: "vault:v1:x" }),
    ).rejects.toThrow(/failed \(403\): permission denied/);
    expect(await p.probe()).toMatchObject({ ok: false, detail: expect.stringContaining("403") });
  });

  it("refuses a data key that is not 32 bytes and material another provider wrapped", async () => {
    const { fetchImpl } = fakeVault();
    const p = createVaultProvider(config, fetchImpl);
    await expect(
      p.unwrapDek({
        provider: "vault",
        keyRef: "transit/keys/app",
        material: `vault:v1:${bytesToBase64(new Uint8Array(16))}`,
      }),
    ).rejects.toThrow(/16 bytes, not 32/);
    await expect(p.unwrapDek({ provider: "aws", keyRef: "arn", material: "x" })).rejects.toThrow(
      /wrapped by aws/,
    );
  });

  it("logs in with the pod's service-account JWT when a Kubernetes role is set", async () => {
    const { calls, fetchImpl } = fakeVault();
    const jwtFile = `${process.cwd()}/package.json`; // any readable file stands in for the mounted JWT
    const p = createVaultProvider(
      {
        ...config,
        token: undefined,
        tokenFile: undefined,
        k8sRole: "agentswarms",
        k8sJwtFile: jwtFile,
      },
      fetchImpl,
    );
    expect((await p.probe()).ok).toBe(true);
    expect(calls[0].url).toBe("http://vault:8200/v1/auth/kubernetes/login");
    expect(calls[0].body.role).toBe("agentswarms");
    expect(calls[1].headers["X-Vault-Token"]).toBe("k8s-token");
  });
});

describe("the wiring", () => {
  it("readiness and the boot check fail closed under an external provider", () => {
    const ready = readFileSync("src/routes/api/health.ready.ts", "utf8");
    expect(ready).toContain("keyringReady()");
    expect(ready).toContain("keys: keys.ok");
    const boot = readFileSync("server.mjs", "utf8");
    expect(boot).toContain('if (kmsProvider && kmsProvider !== "env")');
    expect(boot).toContain("body?.checks?.keys === false");
    expect(boot).toContain("process.exit(1)");
  });

  it("the data key is created only by a superadmin, audited, and the cache dropped", () => {
    const fn = readFileSync("src/utils/providers/keyRotation.functions.ts", "utf8");
    expect(fn).toContain("export const createKmsDataKey");
    expect(fn).toContain("await requireSuperadmin(data.access_token)");
    expect(fn).toContain('action: "security.kms.data_key.create"');
    expect(fn).toContain("resetKeyringCache()");
  });

  it("the settings card shows the provider and the docs describe the switch", () => {
    expect(readFileSync("src/routes/_authenticated/admin.iam.tsx", "utf8")).toContain(
      "Create a data key in",
    );
    expect(readFileSync("docs/KEY_MANAGEMENT.md", "utf8")).toContain("KMS_PROVIDER=vault");
    expect(readFileSync("SECURITY.md", "utf8")).toContain("Vault Transit");
    expect(readFileSync(".env.example", "utf8")).toContain("KMS_PROVIDER=");
  });
});
