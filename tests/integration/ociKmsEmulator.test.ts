// OCI Vault against an emulator: the real provider, the real identity (an API
// key from an OCI config file, every request signed) and the real guarded
// fetch. Opt-in like every integration test. floci-oci, pinned, with
// signatures required:
//
//   docker run -d --name floci-oci -p 127.0.0.1:4599:4599 -e FLOCI_OCI_AUTH_REQUIRE_SIGNATURE=true \
//     floci/floci-oci:0.5.0@sha256:3cb5af867fb2a4e8b60f8cf6fd0acf4873108f01d481c0aac23c01ca00f935ae
//   OCI_KMS_EMULATOR=http://127.0.0.1:4599 npx vitest run \
//     --config vitest.integration.config.ts tests/integration/ociKmsEmulator.test.ts
//
// What floci-oci does as OCI Vault does, measured: the crypto API's paths and
// shapes (encrypt answers ciphertext, keyId, keyVersionId; decrypt plaintext,
// plaintextChecksum, keyId, keyVersionId), a ciphertext asked to decrypt at
// another key is 404 NotAuthorizedOrNotFound, a missing key the same, a
// disabled key 409, rotation makes a new current version and old ciphertexts
// still decrypt, GetKey gives the shape, protection mode and state. What it
// does differently: it requires a signature's header but does not verify the
// signature (so the signature is the unit tests', against the OCI Go SDK's
// vectors), it ignores associatedData and a decrypt's keyVersionId (so the
// associated data is the unit tests'), its key OCIDs have no vault part, one
// host serves every vault's endpoints, and its plaintextChecksum is CRC-32 in
// hex (not relied on, see kms/oci.server).
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createOciKmsProvider, ociKmsConfigFromEnv, OciKmsError } from "@/utils/kms/oci.server";
import { ociKeyFingerprint, signOciRequest } from "@/utils/oci/signer";

const EMULATOR = process.env.OCI_KMS_EMULATOR;
const TENANCY = "ocid1.tenancy.oc1..aaaaaaaar437integration";
const USER = "ocid1.user.oc1..aaaaaaaar437integration";

const apiKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const keyId = `${TENANCY}/${USER}/${ociKeyFingerprint(apiKey)}`;
let env: Record<string, string> = {};
let KEY = "";
let OTHER = "";

async function rest(method: string, path: string, payload?: unknown) {
  const url = `${EMULATOR}${path}`;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers = signOciRequest({ method, url, body, key: { keyId, privateKey: apiKey } });
  const res = await fetch(url, { method, headers, body });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function createKey(name: string): Promise<string> {
  const r = await rest("POST", "/20180608/keys", {
    compartmentId: TENANCY,
    displayName: name,
    keyShape: { algorithm: "AES", length: 32 },
    protectionMode: "HSM",
  });
  expect(r.status).toBe(200);
  return String(r.json.id);
}

const provider = (keyRef = KEY) => createOciKmsProvider(ociKmsConfigFromEnv(keyRef, env), { env });

describe.skipIf(!EMULATOR)("OCI Vault against floci-oci", () => {
  beforeAll(async () => {
    const vault = await rest("POST", "/20180608/vaults", {
      compartmentId: TENANCY,
      displayName: "agentswarms-it",
      vaultType: "DEFAULT",
    });
    expect(vault.status).toBe(200);
    KEY = await createKey("credential-kek");
    OTHER = await createKey("someone-elses");
    const dir = mkdtempSync(join(tmpdir(), "oci-kms-it-"));
    writeFileSync(join(dir, "key.pem"), apiKey.export({ type: "pkcs8", format: "pem" }).toString());
    writeFileSync(
      join(dir, "config"),
      `[DEFAULT]\nuser=${USER}\nfingerprint=${ociKeyFingerprint(apiKey)}\ntenancy=${TENANCY}\nregion=us-ashburn-1\nkey_file=key.pem\n`,
    );
    env = {
      OCI_CONFIG_FILE: join(dir, "config"),
      OCI_KMS_CRYPTO_ENDPOINT: EMULATOR!,
      OCI_KMS_MANAGEMENT_ENDPOINT: EMULATOR!,
    };
  });

  it("wraps a data key with the current version, and unwraps it to the same bytes", async () => {
    const dek = new Uint8Array(randomBytes(32));
    const p = provider();
    const w = await p.wrapDek(dek);
    const m = JSON.parse(w.material);
    expect(m.keyVersionId).toMatch(/^ocid1\.keyversion\.oc1\./);
    expect(Buffer.from(await p.unwrapDek(w))).toEqual(Buffer.from(dek));
  });

  it("the probe describes the key, signs in as the API key's user, and round-trips", async () => {
    const r = await provider().probe();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/^Encrypt and decrypt work \(key version …[a-z0-9]{12}\)\.$/);
    const facts = Object.fromEntries((r.facts ?? []).map((f) => [f.label, f.value]));
    expect(facts["Signed in as"]).toBe(`user ${USER} (API key ${ociKeyFingerprint(apiKey)})`);
    expect(facts.Protection).toBe("HSM-protected");
    expect(facts.Shape).toBe("AES-256");
    expect(facts["Current version"]).toMatch(/ · ENABLED$/);
  });

  it("a key that does not exist is the probe's answer, with what to check", async () => {
    const r = await provider("ocid1.key.oc1.iad.r437doesnotexist").probe();
    expect(r.ok).toBe(false);
    // OCI's 404 is also its answer to "not allowed to read": the details are
    // passed over as unreadable, and the encrypt that follows is the verdict.
    expect(r.facts?.find((f) => f.label === "Key details")?.value).toMatch(/^not readable at /);
    expect(r.detail).toMatch(
      /^OCI Vault encrypt refused \(404 NotAuthorizedOrNotFound\): .*Check KMS_KEY_REF and OCI_KMS_CRYPTO_ENDPOINT/,
    );
  });

  it("a ciphertext from another key does not unwrap under this one", async () => {
    const theirs = await provider(OTHER).wrapDek(new Uint8Array(randomBytes(32)));
    const err = (await provider()
      .unwrapDek({ ...theirs, keyRef: KEY })
      .catch((e: unknown) => e)) as OciKmsError;
    expect(err).toBeInstanceOf(OciKmsError);
    expect(err.code).toBe("NotAuthorizedOrNotFound");
  });

  it("after the key rotates, a new data key names the new version and the old one still unwraps", async () => {
    const before = await provider().wrapDek(new Uint8Array(randomBytes(32)));
    const v = await rest("POST", `/20180608/keys/${KEY}/keyVersions`, {});
    expect(v.status).toBe(200);
    const after = await provider().wrapDek(new Uint8Array(randomBytes(32)));
    expect(JSON.parse(after.material).keyVersionId).toBe(v.json.id);
    expect(JSON.parse(after.material).keyVersionId).not.toBe(
      JSON.parse(before.material).keyVersionId,
    );
    await expect(provider().unwrapDek(before)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("a disabled key fails the probe before anything is encrypted", async () => {
    expect((await rest("POST", `/20180608/keys/${KEY}/actions/disable`)).status).toBe(200);
    try {
      const r = await provider().probe();
      expect(r).toMatchObject({
        ok: false,
        detail: "The key is DISABLED; only an enabled key can encrypt.",
      });
      await expect(provider().wrapDek(new Uint8Array(32))).rejects.toThrow(
        /\(409 Conflict\).*The key cannot be used now: it is disabled, or scheduled for deletion\./,
      );
    } finally {
      expect((await rest("POST", `/20180608/keys/${KEY}/actions/enable`)).status).toBe(200);
    }
  });
});
