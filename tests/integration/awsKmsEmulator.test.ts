// AWS KMS against an emulator: the real provider, the real signer, the real
// keyring — over HTTP to whatever AWS_KMS_EMULATOR_URL names (LocalStack, or
// any KMS-compatible server). Opt-in like every integration test:
//
//   docker run -d --name kms-emulator -p 127.0.0.1:4566:4566 \
//     -e SERVICES=kms,sts localstack/localstack:4.14.0
//   AWS_KMS_EMULATOR_URL=http://127.0.0.1:4566 npx vitest run \
//     --config vitest.integration.config.ts tests/integration/awsKmsEmulator.test.ts
//
// 4.14.0 is the last LocalStack release that starts without an account: from
// 2026.03.0 the image needs an auth token. Its community edition does not
// check signatures either; the published
// SigV4 vectors (tests/unit/awsSigv4.test.ts) prove those. This proves the
// protocol: the targets, the payloads, the error shapes AWS answers with.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { signAwsRequest } from "@/utils/aws/sigv4";
import {
  AWS_KMS_ENCRYPTION_CONTEXT,
  AwsKmsError,
  awsKmsConfigFromEnv,
  createAwsKmsProvider,
} from "@/utils/kms/aws.server";
import { kidOfDek } from "@/utils/kms/keyring.server";

const EMULATOR = process.env.AWS_KMS_EMULATOR_URL;
const REGION = "eu-west-1";
const CREDS = { accessKeyId: "AKIAEMULATORTEST01", secretAccessKey: "emulator-secret" };

async function kms(op: string, payload: unknown): Promise<Record<string, unknown>> {
  const url = `${EMULATOR}/`;
  const body = JSON.stringify(payload);
  const headers = await signAwsRequest({
    service: "kms",
    region: REGION,
    credentials: CREDS,
    method: "POST",
    url,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `TrentService.${op}`,
    },
    body,
  });
  const res = await fetch(url, { method: "POST", headers, body });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${op}: ${JSON.stringify(json)}`);
  return json;
}

const env = (keyRef: string) => ({
  KMS_KEY_REF: keyRef,
  AWS_REGION: REGION,
  AWS_ENDPOINT_URL_KMS: EMULATOR,
  AWS_ACCESS_KEY_ID: CREDS.accessKeyId,
  AWS_SECRET_ACCESS_KEY: CREDS.secretAccessKey,
});

function provider(keyRef: string) {
  const e = env(keyRef);
  return createAwsKmsProvider(awsKmsConfigFromEnv(keyRef, e), { env: e });
}

describe.skipIf(!EMULATOR)("AWS KMS provider against an emulator", () => {
  let keyArn = "";
  let otherArn = "";
  let alias = "";

  beforeAll(async () => {
    const a = (await kms("CreateKey", { Description: "agentswarms R429" })) as {
      KeyMetadata: { Arn: string; KeyId: string };
    };
    const b = (await kms("CreateKey", { Description: "agentswarms R429 other" })) as {
      KeyMetadata: { Arn: string };
    };
    keyArn = a.KeyMetadata.Arn;
    otherArn = b.KeyMetadata.Arn;
    alias = `alias/agentswarms-r429-${Date.now()}`;
    await kms("CreateAlias", { AliasName: alias, TargetKeyId: a.KeyMetadata.KeyId });
  }, 120_000); // an emulator's first CreateKey can take its time

  it("generates a data key, and Decrypt gives back the same 32 bytes", async () => {
    const p = provider(keyArn);
    const { dek, wrapped } = await p.generateDek!();
    expect(dek.length).toBe(32);
    expect(wrapped).toMatchObject({ provider: "aws", keyRef: keyArn });
    const back = await p.unwrapDek(wrapped);
    expect(await kidOfDek(back)).toBe(await kidOfDek(dek));
  });

  it("wraps a data key it is handed (Encrypt), through an alias", async () => {
    const p = provider(alias);
    const dek = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await p.wrapDek(dek);
    expect(wrapped.keyRef).toBe(alias);
    expect([...(await p.unwrapDek(wrapped))]).toEqual([...dek]);
  });

  it("refuses ciphertext of another key: Decrypt names the key it expects", async () => {
    const { wrapped } = await provider(otherArn).generateDek!();
    const err = await provider(keyArn)
      .unwrapDek({ ...wrapped, keyRef: keyArn })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsKmsError);
    expect((err as AwsKmsError).type).toBe("IncorrectKeyException");
  });

  it("refuses ciphertext made under another encryption context", async () => {
    const other = (await kms("GenerateDataKey", {
      KeyId: keyArn,
      KeySpec: "AES_256",
      EncryptionContext: { "agentswarms:purpose": "something-else" },
    })) as { CiphertextBlob: string };
    const err = await provider(keyArn)
      .unwrapDek({ provider: "aws", keyRef: keyArn, material: other.CiphertextBlob })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AwsKmsError);
    expect((err as AwsKmsError).type).toBe("InvalidCiphertextException");
  });

  it("the probe describes the key, and a disabled key fails it", async () => {
    const ok = await provider(keyArn).probe();
    expect(ok.ok).toBe(true);
    expect(ok.facts?.find((f) => f.label === "Key")?.value).toBe(keyArn);
    expect(ok.facts?.find((f) => f.label === "State")?.value).toBe("Enabled");
    expect(ok.facts?.find((f) => f.label === "Signed as")?.value).toMatch(/AKIA…ST01/);

    await kms("DisableKey", { KeyId: otherArn });
    const off = await provider(otherArn).probe();
    expect(off.ok).toBe(false);
    expect(off.detail).toMatch(/Disabled/);
    await kms("EnableKey", { KeyId: otherArn });
  });

  it("a key that does not exist is NotFoundException, with the region in the hint", async () => {
    const missing = keyArn.replace(/key\/.*/, "key/00000000-0000-0000-0000-000000000000");
    const err = await provider(missing).generateDek!().catch((e: unknown) => e);
    expect((err as AwsKmsError).type).toBe("NotFoundException");
    expect((err as Error).message).toMatch(/no such key in eu-west-1/);
  });

  it("signs as a role from web identity: STS answers, then KMS takes its credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r429-wi-"));
    const tokenFile = join(dir, "token");
    // STS checks the token's issuer against an OIDC provider in real AWS; the
    // emulator takes any JWT-shaped token.
    writeFileSync(tokenFile, "eyJhbGciOiJub25lIn0.eyJzdWIiOiJyNDI5In0.");
    try {
      const e = {
        KMS_KEY_REF: keyArn,
        AWS_REGION: REGION,
        AWS_ENDPOINT_URL: EMULATOR,
        AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
        AWS_ROLE_ARN: "arn:aws:iam::000000000000:role/agentswarms-kms",
      };
      const p = createAwsKmsProvider(awsKmsConfigFromEnv(keyArn, e), { env: e });
      const probe = await p.probe();
      expect(probe.facts?.find((f) => f.label === "Signed as")?.value).toBe(
        "role arn:aws:iam::000000000000:role/agentswarms-kms (web identity)",
      );
      expect(probe.ok).toBe(true);
      const { dek, wrapped } = await p.generateDek!();
      expect([...(await p.unwrapDek(wrapped))]).toEqual([...dek]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every call carries the encryption context the docs give for the key policy", () => {
    expect(AWS_KMS_ENCRYPTION_CONTEXT).toEqual({ "agentswarms:purpose": "credential-data-key" });
  });
});
