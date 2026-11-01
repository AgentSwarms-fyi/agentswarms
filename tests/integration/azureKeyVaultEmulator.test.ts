// Azure Key Vault against an emulator: the real provider and the real
// managed identity client, over TLS to a vault answering under a real
// *.vault.azure.net name, as a private endpoint does. Opt-in like every
// integration test. lowkey-vault, with a certificate for *.vault.azure.net
// from a throwaway CA (any CA and certificate will do; openssl shown):
//
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 \
//     -subj "/CN=test CA" -addext basicConstraints=critical,CA:TRUE
//   openssl req -newkey rsa:2048 -nodes -keyout kv.key -out kv.csr -subj "/CN=*.vault.azure.net"
//   printf 'subjectAltName=DNS:*.vault.azure.net\nextendedKeyUsage=serverAuth\n' > kv.ext
//   openssl x509 -req -in kv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out kv.pem -days 30 -extfile kv.ext
//   openssl pkcs12 -export -in kv.pem -inkey kv.key -out kv.p12 -passout pass:changeit
//   docker run -d --name kv-emulator -p 127.0.0.1:9443:8443 -p 127.0.0.1:9080:8080 \
//     -v "$PWD:/certs:ro" -e LOWKEY_ARGS="--LOWKEY_VAULT_NAMES=agentswarms-it \
//     --LOWKEY_VAULT_ALIASES=agentswarms-it.localhost=agentswarms-it.vault.azure.net:<port> \
//     --LOWKEY_VAULT_RELAXED_PORTS=true --server.ssl.key-store=/certs/kv.p12 \
//     --server.ssl.key-store-type=PKCS12 --server.ssl.key-store-password=changeit" \
//     nagyesta/lowkey-vault:7.3.127
//   AZURE_KV_EMULATOR=https://127.0.0.1:9443 AZURE_KV_EMULATOR_CA=$PWD/ca.pem \
//   AZURE_KV_EMULATOR_IDENTITY=http://127.0.0.1:9080 npx vitest run \
//     --config vitest.integration.config.ts tests/integration/azureKeyVaultEmulator.test.ts
//
// What lowkey-vault does differently from Azure, measured: it wraps with RSA
// keys only, so AES key wrap (a Managed HSM's oct-HSM keys) is covered by
// tests/unit/azureKeyVault.test.ts; unwrapKey also wants the key's
// encrypt/decrypt operations; and its errors are HTTP 500 with a Java
// exception's name, not Azure's codes (Forbidden / ForbiddenByRbac /
// KeyNotFound), so the hints keyed by those are unit-tested too. A missing
// key is a 404 in both, and a request without a token is answered with
// Azure's 401 challenge.
import { readFileSync } from "node:fs";
import tls from "node:tls";

import { Agent, fetch as undiciFetch } from "undici";
import { beforeAll, describe, expect, it } from "vitest";

import { createAzureCredentialChain } from "@/utils/azure/credentials.server";
import {
  AzureKeyVaultError,
  azureKeyVaultConfigFromEnv,
  createAzureKeyVaultProvider,
} from "@/utils/kms/azure.server";
import { kidOfDek } from "@/utils/kms/keyring.server";

const EMULATOR = process.env.AZURE_KV_EMULATOR;
const CA = process.env.AZURE_KV_EMULATOR_CA;
const IDENTITY = process.env.AZURE_KV_EMULATOR_IDENTITY;
const VAULT = "https://agentswarms-it.vault.azure.net";
const API = "api-version=7.4";

// Every connection to the vault's real name goes to the emulator, and TLS is
// checked against its CA under that name: nothing else is redirected.
const agent = EMULATOR
  ? new Agent({
      connect: (opts, callback) => {
        const target = new URL(EMULATOR);
        const socket = tls.connect({
          host: target.hostname,
          port: Number(target.port),
          servername: opts.servername || opts.hostname,
          ca: readFileSync(CA ?? ""),
          ALPNProtocols: ["http/1.1"],
        });
        socket.once("secureConnect", () => callback(null, socket));
        socket.once("error", (e) => callback(e, null));
      },
    })
  : null;

const viaEmulator = (url: string, init: RequestInit) =>
  undiciFetch(url, { ...(init as object), dispatcher: agent! }) as unknown as Promise<Response>;

const env = { AZURE_POD_IDENTITY_AUTHORITY_HOST: IDENTITY };
const identity = () =>
  createAzureCredentialChain({ scope: "https://vault.azure.net/.default", env });

function provider(keyRef: string) {
  return createAzureKeyVaultProvider(azureKeyVaultConfigFromEnv(keyRef, {}), {
    credentials: identity(),
    fetch: viaEmulator,
  });
}

async function kv(method: string, path: string, body?: unknown) {
  const token = await identity().get();
  const res = await viaEmulator(`${VAULT}${path}${path.includes("?") ? "&" : "?"}${API}`, {
    method,
    headers: {
      authorization: `Bearer ${token.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const versionOf = (kid: unknown) => String(kid).split("/").pop()!;
const createRsa = (name: string) =>
  kv("POST", `/keys/${name}/create`, {
    kty: "RSA",
    key_size: 2048,
    key_ops: ["wrapKey", "unwrapKey", "encrypt", "decrypt"],
  });

describe.skipIf(!EMULATOR || !CA || !IDENTITY)(
  "Azure Key Vault provider against an emulator",
  () => {
    const name = `kek-${Date.now()}`;
    const keyRef = `${VAULT}/keys/${name}`;
    let v1 = "";

    beforeAll(async () => {
      v1 = versionOf(((await createRsa(name)).key as { kid: string }).kid);
    }, 120_000);

    it("wraps a data key with the key's current version and unwraps it to the same 32 bytes", async () => {
      const p = provider(keyRef);
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const wrapped = await p.wrapDek(dek);
      expect(wrapped).toMatchObject({ provider: "azure", keyRef });
      const m = JSON.parse(wrapped.material);
      expect(m.kid).toBe(`${keyRef}/${v1}`);
      expect(m.alg).toBe("RSA-OAEP-256");
      const back = await p.unwrapDek(wrapped);
      expect(await kidOfDek(back)).toBe(await kidOfDek(dek));
    });

    it("after the key is rotated, wraps with the new version and still unwraps the old", async () => {
      const p = provider(keyRef);
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const old = await p.wrapDek(dek);
      const v2 = versionOf(((await createRsa(name)).key as { kid: string }).kid);
      expect(v2).not.toBe(v1);
      const fresh = await p.wrapDek(dek);
      expect(JSON.parse(fresh.material).kid).toBe(`${keyRef}/${v2}`);
      expect([...(await p.unwrapDek(old))]).toEqual([...dek]);
      expect([...(await p.unwrapDek(fresh))]).toEqual([...dek]);
    });

    it("material whose ciphertext was altered is refused by the vault", async () => {
      const p = provider(keyRef);
      const wrapped = await p.wrapDek(crypto.getRandomValues(new Uint8Array(32)));
      const m = JSON.parse(wrapped.material);
      const bytes = Buffer.from(m.value, "base64url");
      bytes[10] ^= 0xff;
      const err = await p
        .unwrapDek({
          ...wrapped,
          material: JSON.stringify({ ...m, value: bytes.toString("base64url") }),
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AzureKeyVaultError);
    });

    it("the probe describes the key and the managed identity, and a disabled key fails it", async () => {
      const ok = await provider(keyRef).probe();
      expect(ok.ok).toBe(true);
      const facts = Object.fromEntries((ok.facts ?? []).map((f) => [f.label, f.value]));
      expect(facts.Key).toMatch(new RegExp(`^${keyRef}/[0-9a-zA-Z]+$`));
      expect(facts["Key type"]).toBe("RSA 2048-bit key, software-protected");
      expect(facts["Signed in as"]).toBe("managed identity (instance metadata)");

      const other = `kek-off-${Date.now()}`;
      const created = await createRsa(other);
      await kv("PATCH", `/keys/${other}/${versionOf((created.key as { kid: string }).kid)}`, {
        attributes: { enabled: false },
      });
      const off = await provider(`${VAULT}/keys/${other}`).probe();
      expect(off.ok).toBe(false);
    });

    it("a key that does not exist is the vault's 404, with what to check", async () => {
      const err = (await provider(`${VAULT}/keys/no-such-key`)
        .wrapDek(new Uint8Array(32))
        .catch((e: unknown) => e)) as AzureKeyVaultError;
      expect(err).toBeInstanceOf(AzureKeyVaultError);
      expect(err.status).toBe(404);
    });
  },
);
