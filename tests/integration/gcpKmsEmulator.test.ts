// Google Cloud KMS against an emulator: the real provider, the real credential
// chain (a service account key, exchanged at the emulator's token endpoint)
// and the real guarded fetch. Opt-in like every integration test. floci-gcp,
// pinned:
//
//   docker run -d --name floci-gcp -p 127.0.0.1:4588:4588 \
//     floci/floci-gcp:0.11.0@sha256:eae9683d806ceb643bcb36aee97cdb8cad13c3e2959cd053bf40e481994fde12
//   GCP_KMS_EMULATOR=http://127.0.0.1:4588 npx vitest run \
//     --config vitest.integration.config.ts tests/integration/gcpKmsEmulator.test.ts
//
// What floci-gcp does as Cloud KMS does, measured: the checksums are strings,
// verifiedPlaintextCrc32c and verifiedAdditionalAuthenticatedDataCrc32c are
// true when the CRCs are sent (and absent when not), a wrong CRC or AAD is a
// 400 INVALID_ARGUMENT, a missing key a 404 NOT_FOUND, versions rotate and
// disable, and encrypt with a disabled primary is FAILED_PRECONDITION. What
// it does differently: it accepts any assertion at /token and any token on
// every call (so the identity and IAM are the unit tests'), its STS takes
// only access tokens and its iamcredentials only cloud-platform (so
// federation and impersonation are the unit tests'), it drops a key's
// rotation period, and it still decrypts with a disabled version, which
// Cloud KMS refuses (FAILED_PRECONDITION, read with its hint in the unit tests).
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createGcpKmsProvider, gcpKmsConfigFromEnv, GcpKmsError } from "@/utils/kms/gcp.server";

const EMULATOR = process.env.GCP_KMS_EMULATOR;
const RUN = Date.now().toString(36);
const LOCATION = "projects/acme-prod/locations/europe-west3";
const RING = `${LOCATION}/keyRings/agentswarms-it`;
const KEY = `${RING}/cryptoKeys/credentials-${RUN}`;
const OTHER = `${RING}/cryptoKeys/other-${RUN}`;

let env: Record<string, string> = {};

async function rest(method: string, path: string, body?: unknown) {
  const res = await fetch(`${EMULATOR}/v1/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function createKey(name: string) {
  const r = await rest("POST", `${RING}/cryptoKeys?cryptoKeyId=${name.split("/").pop()}`, {
    purpose: "ENCRYPT_DECRYPT",
    versionTemplate: { protectionLevel: "SOFTWARE", algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION" },
  });
  expect(r.status).toBe(200);
}

const provider = (keyRef = KEY, extra: Record<string, string> = {}) =>
  createGcpKmsProvider(gcpKmsConfigFromEnv(keyRef, { ...env, ...extra }), {
    env: { ...env, ...extra },
  });

describe.skipIf(!EMULATOR)("Cloud KMS against floci-gcp", () => {
  beforeAll(async () => {
    const ring = await rest("POST", `${LOCATION}/keyRings?keyRingId=agentswarms-it`, {});
    expect([200, 409]).toContain(ring.status);
    await createKey(KEY);
    await createKey(OTHER);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const dir = mkdtempSync(join(tmpdir(), "gcp-kms-it-"));
    const file = join(dir, "sa.json");
    writeFileSync(
      file,
      JSON.stringify({
        type: "service_account",
        project_id: "acme-prod",
        private_key_id: "it0123456789",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        client_email: "agentswarms@acme-prod.iam.gserviceaccount.com",
        token_uri: `${EMULATOR}/token`,
      }),
    );
    env = { GOOGLE_APPLICATION_CREDENTIALS: file, GCP_KMS_ENDPOINT: EMULATOR! };
  });

  it("wraps a data key with the primary version, and unwraps it to the same bytes", async () => {
    const dek = new Uint8Array(randomBytes(32));
    const w = await provider().wrapDek(dek);
    expect(w).toMatchObject({ provider: "gcp", keyRef: KEY });
    expect(JSON.parse(w.material).version).toBe(`${KEY}/cryptoKeyVersions/1`);
    const back = await provider().unwrapDek(w);
    expect(Buffer.from(back).equals(Buffer.from(dek))).toBe(true);
  });

  it("the probe describes the key, signs in as the service account, and round-trips", async () => {
    const r = await provider().probe();
    expect(r).toMatchObject({ ok: true, detail: "Encrypt and decrypt work (version 1)." });
    const facts = Object.fromEntries((r.facts ?? []).map((f) => [f.label, f.value]));
    expect(facts).toMatchObject({
      Key: KEY,
      "Signed in as":
        "service account agentswarms@acme-prod.iam.gserviceaccount.com (key it012345…)",
      Protection: "software-protected",
      "Primary version": "1 · ENABLED",
      Rotation: "not scheduled: set a rotation period on the key",
    });
    expect(facts.Endpoint).toMatch(
      new RegExp(`^${EMULATOR!.replace(/[.]/g, "\\.")} \\(GCP_KMS_ENDPOINT\\)`),
    );
  });

  it("a key that does not exist is the probe's answer, with what to check", async () => {
    const r = await provider(`${RING}/cryptoKeys/missing-${RUN}`).probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/get key refused \(404 NOT_FOUND\).*Check KMS_KEY_REF/);
  });

  it("a ciphertext from another key does not unwrap under this one, nor one without the AAD", async () => {
    const w = await provider(OTHER).wrapDek(new Uint8Array(randomBytes(32)));
    const m = JSON.parse(w.material);
    // The row claims this key; Cloud KMS is asked at this key, and refuses.
    const forged = {
      ...w,
      keyRef: KEY,
      material: JSON.stringify({ ...m, version: `${KEY}/cryptoKeyVersions/1` }),
    };
    const err = (await provider()
      .unwrapDek(forged)
      .catch((e: unknown) => e)) as GcpKmsError;
    expect(err).toBeInstanceOf(GcpKmsError);
    expect(err.status).toBe("INVALID_ARGUMENT");
    // Encrypted at this key, but not as a data key (no AAD): refused too.
    const raw = await rest("POST", `${KEY}:encrypt`, {
      plaintext: Buffer.from(randomBytes(32)).toString("base64"),
    });
    const bare = {
      provider: "gcp" as const,
      keyRef: KEY,
      material: JSON.stringify({ version: raw.json.name, ciphertext: raw.json.ciphertext }),
    };
    await expect(provider().unwrapDek(bare)).rejects.toThrow(
      /decrypt refused \(400 INVALID_ARGUMENT\)/,
    );
  });

  it("after the key rotates, a new data key names the new version and the old one still unwraps", async () => {
    const dek = new Uint8Array(randomBytes(32));
    const before = await provider().wrapDek(dek);
    const v = await rest("POST", `${KEY}/cryptoKeyVersions`, {});
    expect(v.status).toBe(200);
    const n = String(v.json.name).split("/").pop();
    expect(
      (await rest("POST", `${KEY}:updatePrimaryVersion`, { cryptoKeyVersionId: n })).status,
    ).toBe(200);
    const after = await provider().wrapDek(new Uint8Array(randomBytes(32)));
    expect(JSON.parse(after.material).version).toBe(`${KEY}/cryptoKeyVersions/${n}`);
    expect(Buffer.from(await provider().unwrapDek(before)).equals(Buffer.from(dek))).toBe(true);
    const r = await provider().probe();
    expect(r.facts?.find((f) => f.label === "Primary version")?.value).toBe(`${n} · ENABLED`);
  });

  it("a disabled primary version fails the probe before anything is encrypted", async () => {
    const key = `${RING}/cryptoKeys/disabled-${RUN}`;
    await createKey(key);
    const d = await rest("PATCH", `${key}/cryptoKeyVersions/1?updateMask=state`, {
      state: "DISABLED",
    });
    expect(d.status).toBe(200);
    const r = await provider(key).probe();
    expect(r).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/primary version is DISABLED/),
    });
  });
});
