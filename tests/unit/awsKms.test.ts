// R429: AWS KMS as a key provider. The provider against a fake KMS that
// records each request (target, payload, signature scope), the configuration
// it reads, the private-path rule through the real guarded fetch, and the
// keyring creating a data key with it. The protocol against an emulator is
// tests/integration/awsKmsEmulator.test.ts; the signer, the AWS test suite.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic DNS for the private-path cases: no network.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host.startsWith("vpce-")) return [{ address: "10.20.0.7", family: 4 }];
    return [{ address: "52.94.0.10", family: 4 }];
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

import type { AwsCredentialChain } from "@/utils/aws/credentials.server";
import {
  AWS_KMS_ENCRYPTION_CONTEXT,
  AwsKmsError,
  awsKmsConfigFromEnv,
  createAwsKmsProvider,
  type AwsKmsConfig,
} from "@/utils/kms/aws.server";
import {
  configuredExternalProvider,
  createDataKey,
  kidOfDek,
  providerFor,
} from "@/utils/kms/keyring.server";
import { KmsConfigError, bytesToBase64, keyRefProvider, parseAwsKeyRef } from "@/utils/kms/types";
import { PrivatePathRequiredError } from "@/utils/ssrfGuard.server";
import { auditEvent } from "@/utils/audit.server";

const ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";

const staticCreds: AwsCredentialChain = {
  source: "env",
  get: async () => ({
    accessKeyId: "AKIATESTKEY0001",
    secretAccessKey: "s",
    expiresAt: null,
    source: "env",
    identity: "access key AKIA…0001 (AWS_ACCESS_KEY_ID)",
  }),
};

type Call = {
  url: string;
  target: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
};

function fakeKms(answer: (target: string, payload: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    const target = headers["x-amz-target"];
    calls.push({ url, target, payload, headers });
    return answer(target, payload);
  };
  return { calls, fetchImpl };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ __type: type, message }), { status });

const DEK = new Uint8Array(32).map((_, i) => i + 1);

/** A KMS that "wraps" by prefixing, and checks KeyId and context like AWS does. */
function workingKms(keyArn = ARN) {
  return fakeKms((target, p) => {
    const ctxOk =
      JSON.stringify(p.EncryptionContext) === JSON.stringify(AWS_KMS_ENCRYPTION_CONTEXT);
    switch (target) {
      case "TrentService.GenerateDataKey":
        return ok({
          CiphertextBlob: `wrapped:${bytesToBase64(DEK)}`,
          Plaintext: bytesToBase64(DEK),
          KeyId: keyArn,
        });
      case "TrentService.Encrypt":
        return ok({ CiphertextBlob: `wrapped:${p.Plaintext}`, KeyId: keyArn });
      case "TrentService.Decrypt":
        if (!ctxOk) return fail(400, "InvalidCiphertextException", "");
        return ok({ Plaintext: String(p.CiphertextBlob).replace(/^wrapped:/, ""), KeyId: keyArn });
      case "TrentService.DescribeKey":
        return ok({
          KeyMetadata: {
            Arn: keyArn,
            KeyState: "Enabled",
            KeyUsage: "ENCRYPT_DECRYPT",
            KeySpec: "SYMMETRIC_DEFAULT",
            Origin: "AWS_KMS",
          },
        });
      default:
        return fail(400, "UnknownOperationException", target);
    }
  });
}

function config(over: Partial<AwsKmsConfig> = {}): AwsKmsConfig {
  return {
    keyRef: ARN,
    region: "eu-west-1",
    endpoint: "https://kms.eu-west-1.amazonaws.com",
    endpointFrom: "default",
    requirePrivate: false,
    ...over,
  };
}

const noSleep = async () => {};

beforeEach(() => {
  db.ops = [];
  vi.mocked(auditEvent).mockClear();
});

describe("the key reference", () => {
  it("reads key ARNs, alias ARNs, aliases and key ids, with the ARN's region", () => {
    expect(parseAwsKeyRef(ARN)).toEqual({ kind: "key-arn", region: "eu-west-1" });
    expect(parseAwsKeyRef("arn:aws:kms:us-east-1:111122223333:alias/agentswarms")).toEqual({
      kind: "alias-arn",
      region: "us-east-1",
    });
    expect(
      parseAwsKeyRef(
        "arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/mrk-1234abcd12ab34cd56ef1234567890ab",
      ),
    ).toEqual({
      kind: "key-arn",
      region: "us-gov-west-1",
    });
    expect(parseAwsKeyRef("alias/team/agentswarms")).toEqual({ kind: "alias", region: null });
    expect(parseAwsKeyRef("1234abcd-12ab-34cd-56ef-1234567890ab")).toEqual({
      kind: "key-id",
      region: null,
    });
  });

  it("refuses what is not a KMS key, and AWS-managed aliases", () => {
    for (const bad of [
      "arn:aws:s3:::bucket",
      "arn:aws:kms:eu-west-1:1111:key/abc", // short account
      "arn:aws:kms:eu-west-1:111122223333:key/not a key",
      "alias/",
      "alias/has space",
      "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    ]) {
      expect(() => parseAwsKeyRef(bad), bad).toThrow(KmsConfigError);
    }
    expect(() => parseAwsKeyRef("alias/aws/s3")).toThrow(/AWS-managed key/);
    expect(() => parseAwsKeyRef("arn:aws:kms:eu-west-1:111122223333:alias/aws/ebs")).toThrow(
      /AWS-managed/,
    );
  });

  it("says which provider a reference belongs to", () => {
    expect(keyRefProvider("transit/keys/app")).toBe("vault");
    expect(keyRefProvider(ARN)).toBe("aws");
    expect(keyRefProvider("alias/app")).toBe("aws");
    expect(keyRefProvider("1234abcd-12ab-34cd-56ef-1234567890ab")).toBe("aws");
    expect(keyRefProvider("something")).toBeNull();
  });
});

describe("reading the AWS configuration", () => {
  it("the region comes from the ARN first, then AWS_REGION, then AWS_DEFAULT_REGION", () => {
    expect(awsKmsConfigFromEnv(ARN, { AWS_REGION: "us-east-1" }).region).toBe("eu-west-1");
    expect(awsKmsConfigFromEnv("alias/app", { AWS_REGION: "us-east-2" }).region).toBe("us-east-2");
    expect(awsKmsConfigFromEnv("alias/app", { AWS_DEFAULT_REGION: "ap-south-1" }).region).toBe(
      "ap-south-1",
    );
    expect(() => awsKmsConfigFromEnv("alias/app", {})).toThrow(
      /names no region: use the key's ARN, or set AWS_REGION/,
    );
    expect(() => awsKmsConfigFromEnv("alias/app", { AWS_REGION: "eu-west-1.evil.test#" })).toThrow(
      KmsConfigError,
    );
  });

  it("the endpoint: regional by default, FIPS on request, China's domain, an operator override", () => {
    expect(awsKmsConfigFromEnv(ARN, {})).toMatchObject({
      endpoint: "https://kms.eu-west-1.amazonaws.com",
      endpointFrom: "default",
      requirePrivate: false,
    });
    expect(awsKmsConfigFromEnv(ARN, { AWS_USE_FIPS_ENDPOINT: "true" })).toMatchObject({
      endpoint: "https://kms-fips.eu-west-1.amazonaws.com",
      endpointFrom: "AWS_USE_FIPS_ENDPOINT",
    });
    expect(awsKmsConfigFromEnv("alias/app", { AWS_REGION: "cn-north-1" }).endpoint).toBe(
      "https://kms.cn-north-1.amazonaws.com.cn",
    );
    expect(
      awsKmsConfigFromEnv(ARN, {
        AWS_ENDPOINT_URL: "http://emu:4566",
        AWS_ENDPOINT_URL_KMS: "https://vpce-0abc.kms.eu-west-1.vpce.amazonaws.com/",
      }),
    ).toMatchObject({
      endpoint: "https://vpce-0abc.kms.eu-west-1.vpce.amazonaws.com",
      endpointFrom: "AWS_ENDPOINT_URL_KMS",
    });
    expect(awsKmsConfigFromEnv(ARN, { AWS_ENDPOINT_URL: "http://emu:4566" }).endpointFrom).toBe(
      "AWS_ENDPOINT_URL",
    );
    expect(awsKmsConfigFromEnv(ARN, { KMS_REQUIRE_PRIVATE: "true" }).requirePrivate).toBe(true);
  });

  it("an override is an origin: no path, query, fragment or user info", () => {
    for (const bad of [
      "kms.local",
      "ftp://kms.local",
      "https://kms.local/x",
      "https://kms.local/?a=1",
      "https://u:p@kms.local",
    ]) {
      expect(() => awsKmsConfigFromEnv(ARN, { AWS_ENDPOINT_URL_KMS: bad }), bad).toThrow(
        KmsConfigError,
      );
    }
  });

  it("KMS_PROVIDER=aws builds the AWS provider; a configured key ref makes it the external one", () => {
    const env = { KMS_KEY_REF: ARN, AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "s" };
    expect(providerFor({ provider: "aws", keyRef: ARN }, env)).toMatchObject({
      id: "aws",
      keyRef: ARN,
    });
    expect(configuredExternalProvider(env)).toMatchObject({ id: "aws", keyRef: ARN });
    // A Vault reference still means Vault, and without VAULT_ADDR, nothing.
    expect(configuredExternalProvider({ KMS_KEY_REF: "transit/keys/app" })).toBeNull();
    expect(() => configuredExternalProvider({ KMS_KEY_REF: "alias/app" })).toThrow(
      /names no region/,
    );
  });
});

describe("the calls", () => {
  it("GenerateDataKey: AES_256 under the configured key, with the encryption context, signed for kms", async () => {
    const { calls, fetchImpl } = workingKms();
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    const { dek, wrapped } = await p.generateDek!();
    expect([...dek]).toEqual([...DEK]);
    expect(wrapped).toEqual({
      provider: "aws",
      keyRef: ARN,
      material: `wrapped:${bytesToBase64(DEK)}`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://kms.eu-west-1.amazonaws.com/");
    expect(calls[0].target).toBe("TrentService.GenerateDataKey");
    expect(calls[0].headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(calls[0].payload).toEqual({
      KeyId: ARN,
      KeySpec: "AES_256",
      EncryptionContext: { "agentswarms:purpose": "credential-data-key" },
    });
    expect(calls[0].headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY0001\/\d{8}\/eu-west-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
  });

  it("Decrypt names the row's key and sends the context; the unwrapped key must be 32 bytes", async () => {
    const { calls, fetchImpl } = workingKms();
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    const older = "arn:aws:kms:eu-west-1:111122223333:key/0000aaaa-12ab-34cd-56ef-1234567890ab";
    await p.unwrapDek({
      provider: "aws",
      keyRef: older,
      material: `wrapped:${bytesToBase64(DEK)}`,
    });
    expect(calls[0].target).toBe("TrentService.Decrypt");
    expect(calls[0].payload).toEqual({
      KeyId: older,
      CiphertextBlob: `wrapped:${bytesToBase64(DEK)}`,
      EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
    });
    await expect(
      p.unwrapDek({
        provider: "aws",
        keyRef: ARN,
        material: `wrapped:${bytesToBase64(new Uint8Array(16))}`,
      }),
    ).rejects.toThrow(/16 bytes, not 32/);
    await expect(
      p.unwrapDek({ provider: "vault", keyRef: "transit/keys/x", material: "vault:v1:x" }),
    ).rejects.toThrow(/wrapped by vault, not AWS KMS/);
  });

  it("Encrypt wraps a key it is handed, under the context", async () => {
    const { calls, fetchImpl } = workingKms();
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    const w = await p.wrapDek(DEK);
    expect(w.material).toBe(`wrapped:${bytesToBase64(DEK)}`);
    expect(calls[0].payload).toEqual({
      KeyId: ARN,
      Plaintext: bytesToBase64(DEK),
      EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
    });
  });

  it("an answer without the key is an error, never an empty key", async () => {
    const { fetchImpl } = fakeKms(() => ok({ KeyId: ARN }));
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    await expect(p.generateDek!()).rejects.toThrow(/returned no plaintext/);
    await expect(p.wrapDek(DEK)).rejects.toThrow(/returned no ciphertext/);
  });

  it("errors carry AWS's type, its message, and what to check", async () => {
    const cases: Array<[string, number, RegExp]> = [
      [
        "AccessDeniedException",
        400,
        /needs kms:Decrypt on .*encryption context agentswarms:purpose=credential-data-key/,
      ],
      [
        "com.amazon.coral.service#UnrecognizedClientException",
        400,
        /did not accept the app's credentials/,
      ],
      ["IncorrectKeyException", 400, /wrapped by a different KMS key than/],
      [
        "InvalidCiphertextException",
        400,
        /not ciphertext of this key with this encryption context/,
      ],
      ["KMSInvalidStateException", 400, /disabled or pending deletion/],
      ["NotFoundException", 400, /no such key in eu-west-1/],
    ];
    for (const [type, status, hint] of cases) {
      const { fetchImpl } = fakeKms(() => fail(status, type, "the message"));
      const p = createAwsKmsProvider(config(), {
        credentials: staticCreds,
        fetch: fetchImpl,
        sleep: noSleep,
      });
      const err = await p
        .unwrapDek({ provider: "aws", keyRef: ARN, material: "x" })
        .catch((e: unknown) => e);
      expect(err, type).toBeInstanceOf(AwsKmsError);
      expect((err as AwsKmsError).type).toBe(type.slice(type.lastIndexOf("#") + 1));
      expect((err as Error).message).toMatch(/^AWS KMS Decrypt failed \(400\): \w+: the message\./);
      expect((err as Error).message, type).toMatch(hint);
    }
  });

  it("retries throttling and 5xx twice, freshly signed, and nothing else", async () => {
    let n = 0;
    const { calls, fetchImpl } = fakeKms(() =>
      ++n < 3
        ? fail(400, "ThrottlingException", "slow down")
        : ok({ Plaintext: bytesToBase64(DEK) }),
    );
    const waits: number[] = [];
    const p = createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    });
    await p.unwrapDek({ provider: "aws", keyRef: ARN, material: "x" });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([200, 800]);

    const always = fakeKms(() => fail(503, "ServiceUnavailableException", "down"));
    const p2 = createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: always.fetchImpl,
      sleep: noSleep,
    });
    await expect(p2.unwrapDek({ provider: "aws", keyRef: ARN, material: "x" })).rejects.toThrow(
      /\(503\)/,
    );
    expect(always.calls).toHaveLength(3);

    const denied = fakeKms(() => fail(400, "AccessDeniedException", "no"));
    const p3 = createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: denied.fetchImpl,
      sleep: noSleep,
    });
    await expect(p3.unwrapDek({ provider: "aws", keyRef: ARN, material: "x" })).rejects.toThrow(
      AwsKmsError,
    );
    expect(denied.calls).toHaveLength(1);
  });

  it("an endpoint that cannot be reached says which, and why", async () => {
    const fetchImpl = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    await expect(p.generateDek!()).rejects.toThrow(
      "AWS KMS GenerateDataKey: https://kms.eu-west-1.amazonaws.com could not be reached (ECONNREFUSED)",
    );
  });
});

describe("the probe", () => {
  function describing(meta: Record<string, unknown>) {
    return fakeKms(() =>
      ok({
        KeyMetadata: {
          Arn: ARN,
          KeyState: "Enabled",
          KeyUsage: "ENCRYPT_DECRYPT",
          KeySpec: "SYMMETRIC_DEFAULT",
          Origin: "AWS_KMS",
          ...meta,
        },
      }),
    );
  }
  const facts = (r: { facts?: Array<{ label: string; value: string }> }) =>
    Object.fromEntries((r.facts ?? []).map((f) => [f.label, f.value]));

  it("describes the key, where its material lives, the endpoint and who the app signs as", async () => {
    const { calls, fetchImpl } = describing({});
    const r = await createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: fetchImpl,
    }).probe();
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.target)).toEqual(["TrentService.DescribeKey"]);
    expect(facts(r)).toMatchObject({
      Key: ARN,
      State: "Enabled",
      "Key material": "generated and kept in AWS KMS's HSMs",
      "Signed as": "access key AKIA…0001 (AWS_ACCESS_KEY_ID)",
    });
    expect(facts(r).Endpoint).toMatch(
      /^https:\/\/kms\.eu-west-1\.amazonaws\.com · direct to 52\.94\.0\.10 \(public\)/,
    );
  });

  it("names a CloudHSM or external key store behind the key", async () => {
    const hsm = await createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: describing({ Origin: "AWS_CLOUDHSM", CustomKeyStoreId: "cks-1234567890abcdef0" })
        .fetchImpl,
    }).probe();
    expect(facts(hsm)["Key material"]).toBe(
      "kept in your AWS CloudHSM cluster (custom key store cks-1234567890abcdef0)",
    );
    const xks = await createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: describing({ Origin: "EXTERNAL_KEY_STORE", CustomKeyStoreId: "cks-x" }).fetchImpl,
    }).probe();
    expect(facts(xks)["Key material"]).toMatch(/external key manager, through an XKS proxy/);
  });

  it("fails for a key that is not enabled, or not a symmetric encryption key", async () => {
    const off = await createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: describing({ KeyState: "PendingDeletion" }).fetchImpl,
    }).probe();
    expect(off).toMatchObject({ ok: false, detail: expect.stringMatching(/PendingDeletion/) });
    const rsa = await createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: describing({ KeySpec: "RSA_2048" }).fetchImpl,
    }).probe();
    expect(rsa).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/RSA_2048.*SYMMETRIC_DEFAULT/),
    });
    const signing = await createAwsKmsProvider(config(), {
      credentials: staticCreds,
      fetch: describing({ KeyUsage: "GENERATE_VERIFY_MAC", KeySpec: "HMAC_256" }).fetchImpl,
    }).probe();
    expect(signing.ok).toBe(false);
  });

  it("a credentials failure is the probe's answer, with the facts gathered so far", async () => {
    const broken: AwsCredentialChain = {
      source: "web-identity",
      get: async () => {
        throw new Error(
          "STS refused AssumeRoleWithWebIdentity for arn:aws:iam::1:role/r: AccessDenied: no",
        );
      },
    };
    const { calls, fetchImpl } = describing({});
    const r = await createAwsKmsProvider(config(), {
      credentials: broken,
      fetch: fetchImpl,
    }).probe();
    expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/STS refused/) });
    expect(facts(r).Endpoint).toBeDefined();
    expect(calls).toEqual([]);
  });
});

describe("KMS_REQUIRE_PRIVATE, through the real guarded fetch", () => {
  const realFetch = globalThis.fetch;
  let sent: string[] = [];
  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return ok({ Plaintext: bytesToBase64(DEK) });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a public KMS address before anything is sent, and audits the refusal", async () => {
    const refusals: string[] = [];
    const p = createAwsKmsProvider(config({ requirePrivate: true }), {
      credentials: staticCreds,
      onRefuse: (d) => refusals.push(d),
    });
    const err = await p
      .unwrapDek({ provider: "aws", keyRef: ARN, material: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrivatePathRequiredError);
    expect((err as Error).message).toMatch(
      /^AWS KMS is set to require a private network path, but kms\.eu-west-1\.amazonaws\.com resolves to a public address \(52\.94\.0\.10\)/,
    );
    expect(refusals).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("sends to a VPC endpoint that resolves privately", async () => {
    const p = createAwsKmsProvider(
      config({
        requirePrivate: true,
        endpoint: "https://vpce-0abc.kms.eu-west-1.vpce.amazonaws.com",
      }),
      { credentials: staticCreds },
    );
    await p.unwrapDek({ provider: "aws", keyRef: ARN, material: "x" });
    expect(sent).toHaveLength(1);
  });

  it("without the rule, a public address is the normal path", async () => {
    const p = createAwsKmsProvider(config(), { credentials: staticCreds });
    await p.unwrapDek({ provider: "aws", keyRef: ARN, material: "x" });
    expect(sent).toEqual(["https://kms.eu-west-1.amazonaws.com/"]);
  });

  it("the STS exchange on the way is held to the same rule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r429-sts-"));
    writeFileSync(join(dir, "token"), "the.jwt.token");
    const env = {
      AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "token"),
      AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/r",
      AWS_REGION: "eu-west-1",
    };
    const refusals: string[] = [];
    const p = createAwsKmsProvider(
      config({
        requirePrivate: true,
        endpoint: "https://vpce-0abc.kms.eu-west-1.vpce.amazonaws.com",
      }),
      { env, onRefuse: (d) => refusals.push(d) },
    );
    try {
      const err = await p
        .unwrapDek({ provider: "aws", keyRef: ARN, material: "x" })
        .catch((e: unknown) => e);
      // The refusal itself: nothing was sent, so not "could not be reached".
      expect(err).toBeInstanceOf(PrivatePathRequiredError);
      expect((err as Error).message).toMatch(
        /^AWS KMS is set to require a private network path, but sts\.eu-west-1\.amazonaws\.com resolves to a public address/,
      );
      expect(refusals).toHaveLength(1);
      expect(sent).toEqual([]); // neither STS nor KMS was sent anything
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the keyring's AWS provider audits a refusal as security.kms.private_path.refused", async () => {
    const p = providerFor(
      { provider: "aws", keyRef: ARN },
      { KMS_REQUIRE_PRIVATE: "true", AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "s" },
    );
    await expect(p.unwrapDek({ provider: "aws", keyRef: ARN, material: "x" })).rejects.toThrow(
      PrivatePathRequiredError,
    );
    expect(vi.mocked(auditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        action: "security.kms.private_path.refused",
        detail: expect.objectContaining({
          provider: "aws",
          key_ref: ARN,
          endpoint: "https://kms.eu-west-1.amazonaws.com",
        }),
      }),
    );
  });
});

describe("creating a data key with AWS KMS", () => {
  it("lets KMS generate it, proves Decrypt gives it back, then retires the old row and stores the new one", async () => {
    const { calls, fetchImpl } = workingKms();
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    const row = await createDataKey({ provider: p, createdBy: "admin-1" });
    expect(calls.map((c) => c.target)).toEqual([
      "TrentService.GenerateDataKey",
      "TrentService.Decrypt",
    ]);
    expect(db.ops.map((o) => o.op)).toEqual(["update", "insert"]);
    expect(db.ops[1].payload).toEqual({
      provider: "aws",
      key_ref: ARN,
      material: `wrapped:${bytesToBase64(DEK)}`,
      kid: await kidOfDek(DEK),
      created_by: "admin-1",
    });
    expect(row.kid).toBe(await kidOfDek(DEK));
  });

  it("stores nothing when Decrypt does not give the same bytes back", async () => {
    const { fetchImpl } = fakeKms((target) =>
      target === "TrentService.GenerateDataKey"
        ? ok({ CiphertextBlob: "blob", Plaintext: bytesToBase64(DEK) })
        : ok({ Plaintext: bytesToBase64(new Uint8Array(32)) }),
    );
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    await expect(createDataKey({ provider: p, createdBy: null })).rejects.toThrow(
      /did not unwrap it to the same bytes/,
    );
    expect(db.ops).toEqual([]);
  });

  it("stores nothing when Decrypt is refused (a role that may generate but not decrypt)", async () => {
    const { fetchImpl } = fakeKms((target) =>
      target === "TrentService.GenerateDataKey"
        ? ok({ CiphertextBlob: "blob", Plaintext: bytesToBase64(DEK) })
        : fail(400, "AccessDeniedException", "not allowed"),
    );
    const p = createAwsKmsProvider(config(), { credentials: staticCreds, fetch: fetchImpl });
    await expect(createDataKey({ provider: p, createdBy: null })).rejects.toThrow(/kms:Decrypt/);
    expect(db.ops).toEqual([]);
  });

  it("stores nothing when the provider generates a key that is not 32 bytes", async () => {
    const short = {
      ...createAwsKmsProvider(config(), {
        credentials: staticCreds,
        fetch: workingKms().fetchImpl,
      }),
      generateDek: async () => ({
        dek: new Uint8Array(16),
        wrapped: { provider: "aws" as const, keyRef: ARN, material: "m" },
      }),
    };
    await expect(createDataKey({ provider: short, createdBy: null })).rejects.toThrow(
      /16-byte data key, not 32/,
    );
    expect(db.ops).toEqual([]);
  });
});
