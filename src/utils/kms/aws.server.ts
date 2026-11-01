// AWS KMS as a key provider. The KMS key is the KEK: GenerateDataKey makes
// the DEK inside AWS KMS (its HSMs, or the CloudHSM cluster behind a custom
// key store) and returns it twice, plain and wrapped; Decrypt unwraps it once
// per process start. AWS keeps the key; the app keeps a role that may use it.
//
// No SDK: the JSON API (TrentService.*) signed with SigV4, credentials from
// the app's own identity (utils/aws/credentials.server). Every call carries
// the same encryption context, so a key policy can allow this use and nothing
// else, and every CloudTrail entry names it:
//
//   "Condition": { "StringEquals":
//     { "kms:EncryptionContext:agentswarms:purpose": "credential-data-key" } }
//
// Decrypt names the key it expects (KeyId), so a wrapped data key from any
// other KMS key — another account's, one an attacker controls — is refused by
// AWS rather than unwrapped.
import { describeConnectivity } from "@/utils/providers/connectivityPath.server";
import { cloudRegion } from "@/utils/providers/cloudRegion";
import { SsrfRefusedError, providerFetch, withPrivatePathScope } from "@/utils/ssrfGuard.server";
import { createAwsCredentialChain, type AwsCredentialChain } from "@/utils/aws/credentials.server";
import { signAwsRequest } from "@/utils/aws/sigv4";
import {
  KmsConfigError,
  base64ToBytes,
  bytesToBase64,
  parseAwsKeyRef,
  type KeyProvider,
  type ProbeResult,
  type WrappedDek,
} from "./types";

export const AWS_KMS_ENCRYPTION_CONTEXT = { "agentswarms:purpose": "credential-data-key" } as const;

/** What a KMS_REQUIRE_PRIVATE refusal tells the operator to check. */
export const KMS_PRIVATE_PATH_ADVICE =
  "Point AWS_ENDPOINT_URL_KMS (and AWS_ENDPOINT_URL_STS, for web identity) at a VPC endpoint " +
  "this server resolves to a private address, turn on the endpoint's private DNS, or send the " +
  "call through HTTPS_PROXY.";

export type AwsKmsConfig = {
  keyRef: string;
  /** The key's region: from its ARN, else AWS_REGION / AWS_DEFAULT_REGION. */
  region: string;
  /** Origin the calls go to, e.g. https://kms.eu-west-1.amazonaws.com */
  endpoint: string;
  /** Where the endpoint came from, for the settings card. */
  endpointFrom: "default" | "AWS_USE_FIPS_ENDPOINT" | "AWS_ENDPOINT_URL_KMS" | "AWS_ENDPOINT_URL";
  /** KMS_REQUIRE_PRIVATE: every KMS and STS call must take a private path. */
  requirePrivate: boolean;
};

type Env = Record<string, string | undefined>;

const TRUE = /^(1|true|yes|on)$/i;

function domainOf(region: string): string {
  return region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
}

function endpointOverride(raw: string, name: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new KmsConfigError(`${name} "${raw}" is not a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new KmsConfigError(`${name} must be an http(s) URL, not ${u.protocol}`);
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) {
    throw new KmsConfigError(`${name} must be an origin only (scheme, host, port): ${raw}`);
  }
  return u.origin;
}

/** Read the AWS variables for a KMS key. Throws a KmsConfigError naming what is wrong. */
export function awsKmsConfigFromEnv(keyRef: string, env: Env = process.env): AwsKmsConfig {
  const ref = parseAwsKeyRef(keyRef);
  const fromEnv = (env.AWS_REGION ?? "").trim() || (env.AWS_DEFAULT_REGION ?? "").trim();
  const rawRegion = ref.region ?? fromEnv;
  if (!rawRegion) {
    throw new KmsConfigError(
      `KMS_KEY_REF ${keyRef.trim()} names no region: use the key's ARN, or set AWS_REGION`,
    );
  }
  let region: string;
  try {
    region = cloudRegion(rawRegion, "The AWS KMS region");
  } catch (e) {
    throw new KmsConfigError((e as Error).message);
  }
  const kmsOverride = (env.AWS_ENDPOINT_URL_KMS ?? "").trim();
  const anyOverride = (env.AWS_ENDPOINT_URL ?? "").trim();
  let endpoint: string;
  let endpointFrom: AwsKmsConfig["endpointFrom"];
  if (kmsOverride) {
    endpoint = endpointOverride(kmsOverride, "AWS_ENDPOINT_URL_KMS");
    endpointFrom = "AWS_ENDPOINT_URL_KMS";
  } else if (anyOverride) {
    endpoint = endpointOverride(anyOverride, "AWS_ENDPOINT_URL");
    endpointFrom = "AWS_ENDPOINT_URL";
  } else if (TRUE.test((env.AWS_USE_FIPS_ENDPOINT ?? "").trim())) {
    endpoint = `https://kms-fips.${region}.${domainOf(region)}`;
    endpointFrom = "AWS_USE_FIPS_ENDPOINT";
  } else {
    endpoint = `https://kms.${region}.${domainOf(region)}`;
    endpointFrom = "default";
  }
  return {
    keyRef: keyRef.trim(),
    region,
    endpoint,
    endpointFrom,
    requirePrivate: TRUE.test((env.KMS_REQUIRE_PRIVATE ?? "").trim()),
  };
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type AwsKmsDeps = {
  credentials?: AwsCredentialChain;
  /** The guarded fetch every KMS and STS call goes through. Tests replace it. */
  fetch?: Fetch;
  /** Records a private-path refusal (the audit trail); never throws. */
  onRefuse?: (detail: string) => void;
  env?: Env;
  sleep?: (ms: number) => Promise<void>;
};

/** A KMS error, with the exception type AWS named. */
export class AwsKmsError extends Error {
  constructor(
    message: string,
    readonly type: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AwsKmsError";
  }
}

const RETRYABLE = new Set([
  "ThrottlingException",
  "KMSInternalException",
  "DependencyTimeoutException",
  "ServiceUnavailableException",
  "InternalFailure",
]);

/** What an operator should check, for the errors they will actually see. */
function hint(type: string, op: string, keyRef: string, region: string): string {
  switch (type) {
    case "AccessDeniedException":
      return ` The app's role needs kms:${op} on ${keyRef}, allowed by the key policy too, with the encryption context agentswarms:purpose=credential-data-key.`;
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "IncompleteSignature":
    case "ExpiredTokenException":
      return " AWS did not accept the app's credentials.";
    case "NotFoundException":
      return ` There is no such key in ${region}.`;
    case "DisabledException":
    case "KMSInvalidStateException":
      return " The key is disabled or pending deletion.";
    case "IncorrectKeyException":
      return ` The data key was wrapped by a different KMS key than ${keyRef}.`;
    case "InvalidCiphertextException":
      return " The stored data key is not ciphertext of this key with this encryption context.";
    default:
      return "";
  }
}

export function createAwsKmsProvider(config: AwsKmsConfig, deps: AwsKmsDeps = {}): KeyProvider {
  const env = deps.env ?? process.env;
  const guarded: Fetch = deps.fetch ?? ((url, init) => providerFetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const credentials =
    deps.credentials ?? createAwsCredentialChain({ region: config.region, env, stsFetch: guarded });

  // Inside the private-path scope: the KMS call, and the STS exchange the
  // credentials may need on the way.
  function scoped<T>(fn: () => Promise<T>): Promise<T> {
    return withPrivatePathScope((policy) => {
      policy.required = config.requirePrivate;
      policy.label = "AWS KMS";
      policy.advice = KMS_PRIVATE_PATH_ADVICE;
      policy.onRefuse = deps.onRefuse;
      return fn();
    });
  }

  async function call(op: string, payload: Record<string, unknown>, keyRef = config.keyRef) {
    return scoped(async () => {
      const creds = await credentials.get();
      const body = JSON.stringify(payload);
      const url = `${config.endpoint}/`;
      for (let attempt = 0; ; attempt++) {
        const headers = await signAwsRequest({
          service: "kms",
          region: config.region,
          credentials: creds,
          method: "POST",
          url,
          headers: {
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": `TrentService.${op}`,
          },
          body,
        });
        let res: Response;
        try {
          res = await guarded(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10_000),
          });
        } catch (e) {
          // A refusal (the SSRF guard, the private-path rule) reads alone.
          if (e instanceof SsrfRefusedError) throw e;
          const cause = (e as { cause?: { code?: string; message?: string } }).cause;
          const why = cause?.code ?? cause?.message ?? (e as Error).message;
          throw new Error(`AWS KMS ${op}: ${config.endpoint} could not be reached (${why})`);
        }
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok) return json;
        const rawType = typeof json.__type === "string" ? json.__type : `HTTP ${res.status}`;
        const type = rawType.slice(rawType.lastIndexOf("#") + 1);
        if ((RETRYABLE.has(type) || res.status >= 500) && attempt < 2) {
          await sleep(200 * 4 ** attempt);
          continue;
        }
        const message =
          typeof json.message === "string"
            ? json.message
            : typeof json.Message === "string"
              ? json.Message
              : res.statusText || "no detail";
        throw new AwsKmsError(
          `AWS KMS ${op} failed (${res.status}): ${type}: ${message}.${hint(type, op, keyRef, config.region)}`,
          type,
          res.status,
        );
      }
    });
  }

  function dekFrom(json: Record<string, unknown>, op: string): Uint8Array {
    if (typeof json.Plaintext !== "string") {
      throw new Error(`AWS KMS ${op} returned no plaintext for the data key`);
    }
    const dek = base64ToBytes(json.Plaintext);
    if (dek.length !== 32) throw new Error(`The unwrapped data key is ${dek.length} bytes, not 32`);
    return dek;
  }

  function wrappedFrom(json: Record<string, unknown>, op: string): WrappedDek {
    const blob = json.CiphertextBlob;
    if (typeof blob !== "string" || !blob) {
      throw new Error(`AWS KMS ${op} returned no ciphertext for the data key`);
    }
    return { provider: "aws", keyRef: config.keyRef, material: blob };
  }

  return {
    id: "aws",
    keyRef: config.keyRef,
    async generateDek() {
      const json = await call("GenerateDataKey", {
        KeyId: config.keyRef,
        KeySpec: "AES_256",
        EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
      });
      return {
        dek: dekFrom(json, "GenerateDataKey"),
        wrapped: wrappedFrom(json, "GenerateDataKey"),
      };
    },
    async wrapDek(dek) {
      const json = await call("Encrypt", {
        KeyId: config.keyRef,
        Plaintext: bytesToBase64(dek),
        EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
      });
      return wrappedFrom(json, "Encrypt");
    },
    async unwrapDek(wrapped) {
      if (wrapped.provider !== "aws") {
        throw new Error(`This data key was wrapped by ${wrapped.provider}, not AWS KMS`);
      }
      // The row's own key: a retired data key may have been wrapped by an
      // earlier KMS key, which AWS checks against the ciphertext.
      const json = await call(
        "Decrypt",
        {
          KeyId: wrapped.keyRef,
          CiphertextBlob: wrapped.material,
          EncryptionContext: AWS_KMS_ENCRYPTION_CONTEXT,
        },
        wrapped.keyRef,
      );
      return dekFrom(json, "Decrypt");
    },
    async probe(): Promise<ProbeResult> {
      const facts: NonNullable<ProbeResult["facts"]> = [];
      try {
        const path = await describeConnectivity(`${config.endpoint}/`).catch(() => null);
        facts.push({
          label: "Endpoint",
          value:
            `${config.endpoint}` +
            (config.endpointFrom === "default" ? "" : ` (${config.endpointFrom})`) +
            (path ? ` · ${path.summary}` : ""),
        });
        if (config.requirePrivate)
          facts.push({
            label: "Network rule",
            value: "private path required (KMS_REQUIRE_PRIVATE)",
          });
        const creds = await scoped(() => credentials.get());
        facts.push({ label: "Signed as", value: creds.identity });
        const json = await call("DescribeKey", { KeyId: config.keyRef });
        const meta = (json.KeyMetadata ?? {}) as Record<string, unknown>;
        const s = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : "");
        const arn = s("Arn") || config.keyRef;
        facts.push({ label: "Key", value: arn });
        facts.push({
          label: "Key material",
          value: materialOf(s("Origin"), s("CustomKeyStoreId")),
        });
        if (meta.MultiRegion === true) facts.push({ label: "Multi-Region", value: "yes" });
        const state = s("KeyState") || (meta.Enabled === true ? "Enabled" : "unknown");
        const spec = s("KeySpec") || s("CustomerMasterKeySpec");
        const usage = s("KeyUsage");
        facts.push({ label: "State", value: state });
        if (state !== "Enabled") {
          return {
            ok: false,
            detail: `The key is ${state}; only an enabled key can wrap or unwrap.`,
            facts,
          };
        }
        if (usage !== "ENCRYPT_DECRYPT" || spec !== "SYMMETRIC_DEFAULT") {
          return {
            ok: false,
            detail: `The key is ${spec || "an unknown spec"} for ${usage || "an unknown use"}; a symmetric encryption key (SYMMETRIC_DEFAULT, ENCRYPT_DECRYPT) is needed.`,
            facts,
          };
        }
        // The key's name is in the facts; repeating it here put the ARN on
        // the card five times (found from the UI, R430).
        return { ok: true, detail: `Enabled for encryption, in ${config.region}.`, facts };
      } catch (e) {
        return { ok: false, detail: (e as Error).message, facts };
      }
    },
  };
}

function materialOf(origin: string, customKeyStoreId: string): string {
  switch (origin) {
    case "AWS_KMS":
      return "generated and kept in AWS KMS's HSMs";
    case "AWS_CLOUDHSM":
      return `kept in your AWS CloudHSM cluster (custom key store ${customKeyStoreId || "unknown"})`;
    case "EXTERNAL_KEY_STORE":
      return `kept in your external key manager, through an XKS proxy (custom key store ${customKeyStoreId || "unknown"})`;
    case "EXTERNAL":
      return "imported key material";
    default:
      return origin || "unknown";
  }
}
