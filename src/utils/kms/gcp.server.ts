// Google Cloud KMS as a key provider. The Cloud KMS key is the KEK: the DEK is
// 32 random bytes the keyring makes (createDataKey), encrypted by the key's
// primary version and decrypted once per process start. The key may be
// software, Cloud HSM or an external key manager (Cloud EKM); the calls are
// the same, the protection level is reported.
//
// No SDK: the REST API (v1) with an OAuth token from the app's own identity
// (utils/google/credentials.server). Every byte string carries its CRC-32C
// both ways, as Google asks: the service checks what it receives and says so,
// and a response whose checksum does not match is discarded rather than used.
// Every call also carries the same additional authenticated data, so a
// ciphertext made for anything else with the same key does not decrypt here.
//
// Decrypt names the key it expects, the row's own, so a wrapped data key from
// any other key — another project's, one an attacker controls — is refused by
// Cloud KMS rather than unwrapped. The stored material names the version that
// encrypted it, checked to be one of that key's.
import { randomBytes } from "node:crypto";

import { describeConnectivity } from "@/utils/providers/connectivityPath.server";
import { SsrfRefusedError, providerFetch, withPrivatePathScope } from "@/utils/ssrfGuard.server";
import {
  createGoogleCredentialChain,
  type GoogleCredentialChain,
} from "@/utils/google/credentials.server";
import { crc32c } from "./crc32c";
import {
  KmsConfigError,
  base64ToBytes,
  bytesToBase64,
  parseGcpKeyRef,
  type GcpKeyRef,
  type KeyProvider,
  type ProbeResult,
  type WrappedDek,
} from "./types";

/** The OAuth scope every Cloud KMS call's token is asked for. */
export const GCP_KMS_SCOPE = "https://www.googleapis.com/auth/cloudkms";

/** The additional authenticated data every encrypt and decrypt carries. */
export const GCP_KMS_AAD = "agentswarms:credential-data-key";

/** What a KMS_REQUIRE_PRIVATE refusal tells the operator to check. */
export const GCP_PRIVATE_PATH_ADVICE =
  "Reach Cloud KMS over a Private Service Connect endpoint (set GCP_KMS_ENDPOINT to " +
  "https://cloudkms-<endpoint>.p.googleapis.com, or map cloudkms.googleapis.com to the " +
  "endpoint's address in private DNS), or send the call through HTTPS_PROXY.";

export type GcpKmsConfig = GcpKeyRef & {
  /** Origin the calls go to, e.g. https://cloudkms.googleapis.com */
  endpoint: string;
  endpointFrom: "default" | "GCP_KMS_ENDPOINT";
  /** Over Private Service Connect, the endpoint's own oauth2 name. */
  tokenUrl?: string;
  /** KMS_REQUIRE_PRIVATE: every Cloud KMS call must take a private path. */
  requirePrivate: boolean;
};

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TRUE = /^(1|true|yes|on)$/i;
const PSC = /^cloudkms-([a-z0-9-]+)\.p\.googleapis\.com$/i;

/** Read the key reference, the endpoint and the rule. Throws a KmsConfigError naming what is wrong. */
export function gcpKmsConfigFromEnv(keyRef: string, env: Env = process.env): GcpKmsConfig {
  const ref = parseGcpKeyRef(keyRef);
  const raw = (env.GCP_KMS_ENDPOINT ?? "").trim();
  let endpoint = "https://cloudkms.googleapis.com";
  let tokenUrl: string | undefined;
  if (raw) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new KmsConfigError(`GCP_KMS_ENDPOINT "${raw}" is not a URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new KmsConfigError(`GCP_KMS_ENDPOINT must be an http(s) URL, not ${u.protocol}`);
    }
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) {
      throw new KmsConfigError(
        `GCP_KMS_ENDPOINT must be an origin only (scheme, host, port): ${raw}`,
      );
    }
    endpoint = u.origin;
    const psc = u.protocol === "https:" ? PSC.exec(u.hostname) : null;
    if (psc) tokenUrl = `https://oauth2-${psc[1].toLowerCase()}.p.googleapis.com/token`;
  }
  return {
    ...ref,
    endpoint,
    endpointFrom: raw ? "GCP_KMS_ENDPOINT" : "default",
    tokenUrl,
    requirePrivate: TRUE.test((env.KMS_REQUIRE_PRIVATE ?? "").trim()),
  };
}

export type GcpKmsDeps = {
  credentials?: GoogleCredentialChain;
  /** The guarded fetch every Cloud KMS and token call goes through. Tests replace it. */
  fetch?: Fetch;
  /** Records a private-path refusal (the audit trail); never throws. */
  onRefuse?: (detail: string) => void;
  env?: Env;
  sleep?: (ms: number) => Promise<void>;
};

/** A Cloud KMS error, with the status Google named (PERMISSION_DENIED, NOT_FOUND…). */
export class GcpKmsError extends Error {
  constructor(
    message: string,
    readonly status: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "GcpKmsError";
  }
}

const HINTS: Record<string, string> = {
  PERMISSION_DENIED:
    "Grant the app's identity the Cloud KMS CryptoKey Encrypter/Decrypter role (roles/cloudkms.cryptoKeyEncrypterDecrypter) on the key.",
  NOT_FOUND: "Check KMS_KEY_REF: the project, the location, the key ring and the key name.",
  FAILED_PRECONDITION:
    "The key cannot be used now: its primary version is disabled, destroyed or scheduled for destruction, or its external key manager is unreachable.",
  UNAUTHENTICATED:
    "The token was not accepted: check that the service account still exists and its key or federation is valid.",
};

const VPC_SC = /VPC Service Controls|vpcServiceControls/i;

/**
 * The version a stored data key names, checked against the row's own key:
 * projects/…/cryptoKeys/<key>/cryptoKeyVersions/<n>.
 */
export function checkedVersion(version: string, rowKeyRef: string): string {
  const ref = parseGcpKeyRef(rowKeyRef);
  const prefix = `${ref.keyRef}/cryptoKeyVersions/`;
  const n = version.startsWith(prefix) ? version.slice(prefix.length) : "";
  if (!/^[1-9]\d{0,9}$/.test(n)) {
    throw new Error(
      `The stored data key names ${version || "no version"}, which is not a version of ${ref.keyRef}; refusing to use it`,
    );
  }
  return `${prefix}${n}`;
}

type StoredMaterial = { version: string; ciphertext: string };

function readMaterial(material: string): StoredMaterial {
  let m: unknown;
  try {
    m = JSON.parse(material);
  } catch {
    throw new Error("The stored data key is not Cloud KMS material");
  }
  const o = (m ?? {}) as Record<string, unknown>;
  if (typeof o.version !== "string" || typeof o.ciphertext !== "string" || !o.ciphertext) {
    throw new Error("The stored data key is not Cloud KMS material");
  }
  return { version: o.version, ciphertext: o.ciphertext };
}

/** A checksum field, an int64 sent as a string. */
const crcField = (bytes: Uint8Array) => String(crc32c(bytes));
const sameCrc = (field: unknown, bytes: Uint8Array) =>
  (typeof field === "string" || typeof field === "number") && Number(field) === crc32c(bytes);

const PROTECTION: Record<string, string> = {
  SOFTWARE: "software-protected",
  HSM: "in Cloud HSM (FIPS 140-2 Level 3)",
  EXTERNAL: "in an external key manager (Cloud EKM, over the internet)",
  EXTERNAL_VPC: "in an external key manager (Cloud EKM, over a VPC)",
};

/** "2592000s" → "30 days". */
function duration(raw: unknown): string | null {
  const s = typeof raw === "string" ? /^(\d+)(?:\.\d+)?s$/.exec(raw) : null;
  if (!s) return null;
  const secs = Number(s[1]);
  if (secs % 86400 === 0) return `${secs / 86400} day${secs === 86400 ? "" : "s"}`;
  if (secs % 3600 === 0) return `${secs / 3600} hours`;
  return `${secs} seconds`;
}

export function createGcpKmsProvider(config: GcpKmsConfig, deps: GcpKmsDeps = {}): KeyProvider {
  const env = deps.env ?? process.env;
  const guarded: Fetch = deps.fetch ?? ((url, init) => providerFetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const credentials =
    deps.credentials ??
    createGoogleCredentialChain({
      scope: GCP_KMS_SCOPE,
      env,
      tokenUrl: config.tokenUrl,
      tokenFetch: guarded,
    });
  const aad = new TextEncoder().encode(GCP_KMS_AAD);

  // The Cloud KMS call inside the private-path scope. The token is fetched
  // before it, outside (see google/credentials).
  function scoped<T>(fn: () => Promise<T>): Promise<T> {
    return withPrivatePathScope((policy) => {
      policy.required = config.requirePrivate;
      policy.label = "Cloud KMS";
      policy.advice = GCP_PRIVATE_PATH_ADVICE;
      policy.onRefuse = deps.onRefuse;
      return fn();
    });
  }

  async function call(
    op: string,
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await credentials.get();
    const body = payload ? JSON.stringify(payload) : undefined;
    const target = `${config.endpoint}/v1/${path}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await scoped(() =>
          guarded(target, {
            method,
            headers: {
              authorization: `Bearer ${token.token}`,
              ...(token.quotaProject ? { "x-goog-user-project": token.quotaProject } : {}),
              ...(body ? { "content-type": "application/json" } : {}),
            },
            body,
            signal: AbortSignal.timeout(10_000),
          }),
        );
      } catch (e) {
        // A refusal (the SSRF guard, the private-path rule) reads alone.
        if (e instanceof SsrfRefusedError) throw e;
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        throw new Error(
          `Cloud KMS ${op}: ${new URL(config.endpoint).host} could not be reached (${cause?.code ?? cause?.message ?? (e as Error).message})`,
        );
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return json;
      const err = (json.error ?? {}) as Record<string, unknown>;
      const status = (typeof err.status === "string" && err.status) || `HTTP ${res.status}`;
      const message = typeof err.message === "string" ? err.message : "no detail";
      if ((res.status === 429 || res.status === 500 || res.status >= 502) && attempt < 2) {
        await sleep(attempt ? 800 : 200);
        continue;
      }
      const hint = VPC_SC.test(message)
        ? "A VPC Service Controls perimeter refused the call: this server's network or identity is outside the key's perimeter."
        : (HINTS[status] ?? "");
      throw new GcpKmsError(
        `Cloud KMS ${op} refused (${res.status} ${status}): ${message}${hint ? ` ${hint}` : ""}`,
        status,
        res.status,
      );
    }
  }

  /** Encrypt with the key's primary version; every checksum checked. */
  async function encrypt(plain: Uint8Array): Promise<StoredMaterial> {
    const json = await call("encrypt", "POST", `${config.keyRef}:encrypt`, {
      plaintext: bytesToBase64(plain),
      plaintextCrc32c: crcField(plain),
      additionalAuthenticatedData: bytesToBase64(aad),
      additionalAuthenticatedDataCrc32c: crcField(aad),
    });
    if (
      json.verifiedPlaintextCrc32c !== true ||
      json.verifiedAdditionalAuthenticatedDataCrc32c !== true
    ) {
      throw new Error(
        "Cloud KMS encrypt did not confirm the checksums it was sent; the request may have been altered on the way, so its answer was not used",
      );
    }
    const ciphertext = typeof json.ciphertext === "string" ? json.ciphertext : "";
    if (!ciphertext || !sameCrc(json.ciphertextCrc32c, base64ToBytes(ciphertext))) {
      throw new Error(
        "Cloud KMS encrypt returned a ciphertext whose checksum does not match; it was not used",
      );
    }
    const version = checkedVersion(typeof json.name === "string" ? json.name : "", config.keyRef);
    return { version, ciphertext };
  }

  async function decrypt(keyRef: string, m: StoredMaterial): Promise<Uint8Array> {
    const ct = base64ToBytes(m.ciphertext);
    const json = await call("decrypt", "POST", `${keyRef}:decrypt`, {
      ciphertext: m.ciphertext,
      ciphertextCrc32c: crcField(ct),
      additionalAuthenticatedData: bytesToBase64(aad),
      additionalAuthenticatedDataCrc32c: crcField(aad),
    });
    const plaintext = typeof json.plaintext === "string" ? base64ToBytes(json.plaintext) : null;
    if (!plaintext || !sameCrc(json.plaintextCrc32c, plaintext)) {
      throw new Error(
        "Cloud KMS decrypt returned a plaintext whose checksum does not match; it was not used",
      );
    }
    return plaintext;
  }

  return {
    id: "gcp",
    keyRef: config.keyRef,
    async wrapDek(dek) {
      const material = await encrypt(dek);
      return { provider: "gcp", keyRef: config.keyRef, material: JSON.stringify(material) };
    },
    async unwrapDek(wrapped: WrappedDek) {
      if (wrapped.provider !== "gcp") {
        throw new Error(`This data key was wrapped by ${wrapped.provider}, not Cloud KMS`);
      }
      const m = readMaterial(wrapped.material);
      // The row's own key, not whatever the material claims.
      const ref = parseGcpKeyRef(wrapped.keyRef);
      checkedVersion(m.version, ref.keyRef);
      return decrypt(ref.keyRef, m);
    },
    async probe(): Promise<ProbeResult> {
      const facts: NonNullable<ProbeResult["facts"]> = [];
      try {
        const path = await describeConnectivity(`${config.endpoint}/`).catch(() => null);
        facts.push({
          label: "Endpoint",
          value: `${config.endpoint}${config.endpointFrom === "default" ? "" : " (GCP_KMS_ENDPOINT)"}${path ? ` · ${path.summary}` : ""}`,
        });
        if (config.requirePrivate) {
          facts.push({
            label: "Network rule",
            value:
              "private path required (KMS_REQUIRE_PRIVATE); the token request to Google's sign-in is not covered",
          });
        }
        const token = await credentials.get();
        facts.push({ label: "Signed in as", value: token.identity });
        facts.push({ label: "Key", value: config.keyRef });
        // Describing the key needs cloudkms.cryptoKeys.get, which the
        // encrypter/decrypter role does not have: best effort, for the card.
        let readable = true;
        try {
          const key = await call("get key", "GET", config.keyRef);
          const primary = (key.primary ?? null) as Record<string, unknown> | null;
          const template = (key.versionTemplate ?? {}) as Record<string, unknown>;
          if (key.purpose && key.purpose !== "ENCRYPT_DECRYPT") {
            return {
              ok: false,
              detail: `The key's purpose is ${String(key.purpose)}; wrapping a data key needs a symmetric ENCRYPT_DECRYPT key.`,
              facts,
            };
          }
          const level = String(primary?.protectionLevel ?? template.protectionLevel ?? "");
          facts.push({ label: "Protection", value: PROTECTION[level] ?? (level || "unknown") });
          if (primary) {
            facts.push({
              label: "Primary version",
              value: `${String(primary.name ?? "")
                .split("/")
                .pop()} · ${String(primary.state ?? "unknown")}`,
            });
          }
          const every = duration(key.rotationPeriod);
          const next =
            typeof key.nextRotationTime === "string" ? key.nextRotationTime.slice(0, 10) : "";
          facts.push({
            label: "Rotation",
            value: every
              ? `every ${every}${next ? `, next ${next}` : ""}`
              : "not scheduled: set a rotation period on the key",
          });
          const wait = duration(key.destroyScheduledDuration);
          if (wait) {
            facts.push({
              label: "Destruction",
              value: `a version scheduled for destruction can be restored for ${wait}`,
            });
          }
          if (!primary) {
            return {
              ok: false,
              detail: "The key has no primary version to encrypt with.",
              facts,
            };
          }
          if (primary.state !== "ENABLED") {
            return {
              ok: false,
              detail: `The key's primary version is ${String(primary.state ?? "not enabled")}; only an enabled version can encrypt.`,
              facts,
            };
          }
        } catch (e) {
          if (!(e instanceof GcpKmsError) || e.status !== "PERMISSION_DENIED") throw e;
          readable = false;
          facts.push({
            label: "Key details",
            value: "not readable by this identity (Cloud KMS Viewer would show them); not needed",
          });
        }
        // The round trip proves what the app needs: encrypt and decrypt.
        const sample = new Uint8Array(randomBytes(32));
        const m = await encrypt(sample);
        const back = await decrypt(config.keyRef, m);
        if (Buffer.compare(Buffer.from(back), Buffer.from(sample)) !== 0) {
          return { ok: false, detail: "A test encrypt and decrypt did not round-trip.", facts };
        }
        return {
          ok: true,
          detail: `Encrypt and decrypt work (version ${m.version.split("/").pop()}${readable ? "" : "; the key's details are not readable"}).`,
          facts,
        };
      } catch (e) {
        return { ok: false, detail: (e as Error).message, facts };
      }
    },
  };
}
