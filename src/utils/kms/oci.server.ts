// OCI Vault as a key provider. The vault's master encryption key is the KEK:
// the DEK is 32 random bytes the keyring makes (createDataKey), encrypted by
// the key's current version and decrypted once per process start. The key may
// be HSM-protected, software-protected or held by an external key manager;
// the calls are the same, the protection mode is reported.
//
// No SDK: the crypto API (20180608) at the vault's own cryptographic endpoint,
// each request signed by the app's own identity (oci/credentials.server,
// oci/signer). Every call carries the same associated data, which Vault binds
// into its AES-GCM, so a ciphertext made for anything else with the same key
// does not decrypt here.
//
// Decrypt names the key it expects, the row's own, and the version the stored
// material names: a wrapped data key from any other key — another tenancy's,
// one an attacker controls — is refused by Vault rather than unwrapped. An
// answer that names another key or version is not used.
//
// Not checked: the decrypt answer's plaintextChecksum. OCI does not say how it
// is computed (the stand-in returns CRC-32 in hex), and the keyring already
// refuses an unwrapped key whose fingerprint is not the stored one.
import { randomBytes } from "node:crypto";

import { describeConnectivity } from "@/utils/providers/connectivityPath.server";
import { SsrfRefusedError, providerFetch, withPrivatePathScope } from "@/utils/ssrfGuard.server";
import { createOciCredentialChain, type OciCredentialChain } from "@/utils/oci/credentials.server";
import { signOciRequest } from "@/utils/oci/signer";
import {
  KmsConfigError,
  base64ToBytes,
  bytesToBase64,
  parseOciKeyRef,
  type KeyProvider,
  type OciKeyRef,
  type ProbeResult,
  type WrappedDek,
} from "./types";

/** The associated data every encrypt and decrypt carries. */
export const OCI_KMS_AAD = { purpose: "agentswarms:credential-data-key" } as const;

/** What a KMS_REQUIRE_PRIVATE refusal tells the operator to check. */
export const OCI_PRIVATE_PATH_ADVICE =
  "Reach the vault at a private address: a Private Service Access endpoint for OCI Vault " +
  "where the region offers one (its private DNS answers the vault's endpoint name with the " +
  "endpoint's address), or send the call through HTTPS_PROXY. A service gateway keeps the " +
  "traffic on Oracle's network, but the vault's addresses stay public, so it does not pass this rule.";

export type OciKmsConfig = OciKeyRef & {
  /** The vault's cryptographic endpoint (origin), e.g. https://<vault>-crypto.kms.<region>.oraclecloud.com */
  cryptoEndpoint: string;
  /** Its management endpoint, for the key's details on the card; null when unknown. */
  managementEndpoint: string | null;
  managementFrom: "derived" | "OCI_KMS_MANAGEMENT_ENDPOINT" | null;
  /** KMS_REQUIRE_PRIVATE: every Vault call must take a private path. */
  requirePrivate: boolean;
};

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TRUE = /^(1|true|yes|on)$/i;
// <vault>-crypto.kms.<region>.<realm domain>: the name Oracle gives a vault's endpoint.
const ORACLE_CRYPTO = /^([a-z0-9]+)-crypto\.(kms\..+)$/;

function origin(raw: string, name: string): string {
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

/** Read the key OCID, the vault's endpoints and the rule. Throws a KmsConfigError naming what is wrong. */
export function ociKmsConfigFromEnv(keyRef: string, env: Env = process.env): OciKmsConfig {
  const ref = parseOciKeyRef(keyRef);
  const rawCrypto = (env.OCI_KMS_CRYPTO_ENDPOINT ?? "").trim();
  if (!rawCrypto) {
    throw new KmsConfigError(
      "KMS_PROVIDER=oci needs OCI_KMS_CRYPTO_ENDPOINT: the vault's Cryptographic Endpoint, from its details page (https://<vault>-crypto.kms.<region>.oraclecloud.com)",
    );
  }
  const cryptoEndpoint = origin(rawCrypto, "OCI_KMS_CRYPTO_ENDPOINT");
  const rawManagement = (env.OCI_KMS_MANAGEMENT_ENDPOINT ?? "").trim();
  let managementEndpoint: string | null = null;
  let managementFrom: OciKmsConfig["managementFrom"] = null;
  if (rawManagement) {
    managementEndpoint = origin(rawManagement, "OCI_KMS_MANAGEMENT_ENDPOINT");
    managementFrom = "OCI_KMS_MANAGEMENT_ENDPOINT";
  } else {
    const u = new URL(cryptoEndpoint);
    const m = ORACLE_CRYPTO.exec(u.hostname);
    if (m) {
      managementEndpoint = `${u.protocol}//${m[1]}-management.${m[2]}${u.port ? `:${u.port}` : ""}`;
      managementFrom = "derived";
    }
  }
  return {
    ...ref,
    cryptoEndpoint,
    managementEndpoint,
    managementFrom,
    requirePrivate: TRUE.test((env.KMS_REQUIRE_PRIVATE ?? "").trim()),
  };
}

export type OciKmsDeps = {
  credentials?: OciCredentialChain;
  /** The guarded fetch every Vault and identity call goes through. Tests replace it. */
  fetch?: Fetch;
  /** Records a private-path refusal (the audit trail); never throws. */
  onRefuse?: (detail: string) => void;
  env?: Env;
  sleep?: (ms: number) => Promise<void>;
};

/** An OCI Vault error, with the code OCI named (NotAuthorizedOrNotFound, NotAuthenticated…). */
export class OciKmsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "OciKmsError";
  }
}

/** The vault an Oracle-named endpoint belongs to, or null for any other name. */
function endpointVault(endpoint: string): string | null {
  return ORACLE_CRYPTO.exec(new URL(endpoint).hostname)?.[1] ?? null;
}

function hint(code: string, status: number, config: OciKmsConfig, keyRef: string): string {
  if (code === "NotAuthorizedOrNotFound" || status === 404) {
    const ref = parseOciKeyRef(keyRef);
    const named = endpointVault(config.cryptoEndpoint);
    const elsewhere =
      ref.vault && named && ref.vault !== named
        ? ` The key's OCID names vault ${ref.vault}, but the endpoint is vault ${named}'s.`
        : "";
    return (
      `OCI answers this both for a key that is not there and for one the app may not use.${elsewhere} ` +
      "Check KMS_KEY_REF and OCI_KMS_CRYPTO_ENDPOINT, and a policy such as: Allow dynamic-group " +
      `<the app's> to use keys in compartment <the key's> where target.key.id = '${keyRef}' ` +
      "(a group, for an API key's user)."
    );
  }
  if (code === "NotAuthenticated" || status === 401) {
    return "OCI did not accept the request's signature: check the app's identity (an API key's fingerprint and key_file, a principal's token) and this server's clock, which must be within five minutes of OCI's.";
  }
  if (code === "IncorrectState" || code === "Conflict" || status === 409) {
    return "The key cannot be used now: it is disabled, or scheduled for deletion.";
  }
  return "";
}

type StoredMaterial = { keyVersionId: string; ciphertext: string };

const VERSION_OCID = /^ocid1\.keyversion\.[a-z0-9.-]+$/;

function readMaterial(material: string): StoredMaterial {
  let m: unknown;
  try {
    m = JSON.parse(material);
  } catch {
    throw new Error("The stored data key is not OCI Vault material");
  }
  const o = (m ?? {}) as Record<string, unknown>;
  if (
    typeof o.keyVersionId !== "string" ||
    !VERSION_OCID.test(o.keyVersionId) ||
    typeof o.ciphertext !== "string" ||
    !o.ciphertext
  ) {
    throw new Error("The stored data key is not OCI Vault material");
  }
  return { keyVersionId: o.keyVersionId, ciphertext: o.ciphertext };
}

const PROTECTION: Record<string, string> = {
  HSM: "HSM-protected",
  SOFTWARE: "software-protected",
  EXTERNAL: "in an external key manager (OCI External KMS)",
};

/** A version OCID shortened for the card: its last characters identify it. */
const shortVersion = (id: string) => (id.length > 24 ? `…${id.slice(-12)}` : id);

export function createOciKmsProvider(config: OciKmsConfig, deps: OciKmsDeps = {}): KeyProvider {
  const env = deps.env ?? process.env;
  const guarded: Fetch = deps.fetch ?? ((url, init) => providerFetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const credentials = deps.credentials ?? createOciCredentialChain({ env, tokenFetch: guarded });

  // The Vault call inside the private-path scope. The identity's token is
  // fetched before it, outside (see oci/credentials).
  function scoped<T>(fn: () => Promise<T>): Promise<T> {
    return withPrivatePathScope((policy) => {
      policy.required = config.requirePrivate;
      policy.label = "OCI Vault";
      policy.advice = OCI_PRIVATE_PATH_ADVICE;
      policy.onRefuse = deps.onRefuse;
      return fn();
    });
  }

  async function call(
    op: string,
    method: "GET" | "POST",
    endpoint: string,
    path: string,
    keyRef: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = payload ? JSON.stringify(payload) : undefined;
    const target = `${endpoint}${path}`;
    for (let attempt = 0; ; attempt++) {
      const cred = await credentials.get();
      // Signed per attempt: the date is part of the signature.
      const headers = signOciRequest({ method, url: target, key: cred.key, body });
      let res: Response;
      try {
        res = await scoped(() =>
          guarded(target, { method, headers, body, signal: AbortSignal.timeout(10_000) }),
        );
      } catch (e) {
        // A refusal (the SSRF guard, the private-path rule) reads alone.
        if (e instanceof SsrfRefusedError) throw e;
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        throw new Error(
          `OCI Vault ${op}: ${new URL(endpoint).host} could not be reached (${cause?.code ?? cause?.message ?? (e as Error).message})`,
        );
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return json;
      const code = (typeof json.code === "string" && json.code) || `HTTP ${res.status}`;
      const message = typeof json.message === "string" ? json.message : "no detail";
      if ((res.status === 429 || res.status === 500 || res.status >= 502) && attempt < 2) {
        await sleep(attempt ? 800 : 200);
        continue;
      }
      const h = hint(code, res.status, config, keyRef);
      throw new OciKmsError(
        `OCI Vault ${op} refused (${res.status} ${code}): ${message}${h ? ` ${h}` : ""}`,
        code,
        res.status,
      );
    }
  }

  /** Encrypt with the key's current version; the answer must name this key. */
  async function encrypt(plain: Uint8Array): Promise<StoredMaterial> {
    const json = await call(
      "encrypt",
      "POST",
      config.cryptoEndpoint,
      "/20180608/encrypt",
      config.keyRef,
      { keyId: config.keyRef, plaintext: bytesToBase64(plain), associatedData: OCI_KMS_AAD },
    );
    if (typeof json.keyId === "string" && json.keyId !== config.keyRef) {
      throw new Error(
        `OCI Vault encrypt answered for ${json.keyId}, not ${config.keyRef}; its answer was not used`,
      );
    }
    const ciphertext = typeof json.ciphertext === "string" ? json.ciphertext : "";
    const keyVersionId = typeof json.keyVersionId === "string" ? json.keyVersionId : "";
    if (!ciphertext || !VERSION_OCID.test(keyVersionId)) {
      throw new Error(
        "OCI Vault encrypt returned no ciphertext or no key version; it was not used",
      );
    }
    return { keyVersionId, ciphertext };
  }

  async function decrypt(keyRef: string, m: StoredMaterial): Promise<Uint8Array> {
    const json = await call("decrypt", "POST", config.cryptoEndpoint, "/20180608/decrypt", keyRef, {
      keyId: keyRef,
      ciphertext: m.ciphertext,
      associatedData: OCI_KMS_AAD,
      keyVersionId: m.keyVersionId,
    });
    if (typeof json.keyId === "string" && json.keyId !== keyRef) {
      throw new Error(
        `OCI Vault decrypt answered for ${json.keyId}, not ${keyRef}; it was not used`,
      );
    }
    if (typeof json.keyVersionId === "string" && json.keyVersionId !== m.keyVersionId) {
      throw new Error(
        `OCI Vault decrypted with ${json.keyVersionId}, but the data key names ${m.keyVersionId}; it was not used`,
      );
    }
    const plaintext = typeof json.plaintext === "string" ? base64ToBytes(json.plaintext) : null;
    if (!plaintext) throw new Error("OCI Vault decrypt returned no plaintext");
    return plaintext;
  }

  return {
    id: "oci",
    keyRef: config.keyRef,
    async wrapDek(dek) {
      const material = await encrypt(dek);
      return { provider: "oci", keyRef: config.keyRef, material: JSON.stringify(material) };
    },
    async unwrapDek(wrapped: WrappedDek) {
      if (wrapped.provider !== "oci") {
        throw new Error(`This data key was wrapped by ${wrapped.provider}, not OCI Vault`);
      }
      const m = readMaterial(wrapped.material);
      // The row's own key, not whatever the configuration names now.
      const ref = parseOciKeyRef(wrapped.keyRef);
      const named = endpointVault(config.cryptoEndpoint);
      if (ref.vault && named && ref.vault !== named) {
        throw new Error(
          `This data key was wrapped by a key in vault ${ref.vault}, but OCI_KMS_CRYPTO_ENDPOINT is vault ${named}'s; a vault's keys are reached only at its own endpoint`,
        );
      }
      return decrypt(ref.keyRef, m);
    },
    async probe(): Promise<ProbeResult> {
      const facts: NonNullable<ProbeResult["facts"]> = [];
      try {
        const path = await describeConnectivity(`${config.cryptoEndpoint}/`).catch(() => null);
        const plain = new URL(config.cryptoEndpoint).protocol === "http:";
        facts.push({
          label: "Crypto endpoint",
          value: `${config.cryptoEndpoint} (OCI_KMS_CRYPTO_ENDPOINT)${path ? ` · ${path.summary}` : ""}${
            plain
              ? " · plain http: the data key would cross the network unencrypted, an emulator only"
              : ""
          }`,
        });
        if (config.requirePrivate) {
          facts.push({
            label: "Network rule",
            value:
              "private path required (KMS_REQUIRE_PRIVATE); an instance principal's call to the identity service is not covered",
          });
        }
        const cred = await credentials.get();
        facts.push({ label: "Signed in as", value: cred.identity });
        facts.push({ label: "Key", value: config.keyRef });
        // The key's details are on the management endpoint and need read
        // access to the key: best effort, for the card.
        let readable = false;
        if (!config.managementEndpoint) {
          facts.push({
            label: "Key details",
            value:
              "not shown: set OCI_KMS_MANAGEMENT_ENDPOINT, the vault's Management Endpoint, to see them; not needed",
          });
        } else {
          try {
            const key = await call(
              "get key",
              "GET",
              config.managementEndpoint,
              `/20180608/keys/${config.keyRef}`,
              config.keyRef,
            );
            readable = true;
            const shape = (key.keyShape ?? {}) as Record<string, unknown>;
            if (shape.algorithm && shape.algorithm !== "AES") {
              return {
                ok: false,
                detail: `The key is ${String(shape.algorithm)}; wrapping a data key needs an AES key.`,
                facts,
              };
            }
            const mode = String(key.protectionMode ?? "");
            facts.push({ label: "Protection", value: PROTECTION[mode] ?? (mode || "unknown") });
            if (typeof shape.length === "number") {
              facts.push({ label: "Shape", value: `AES-${shape.length * 8}` });
            }
            if (typeof key.currentKeyVersion === "string") {
              facts.push({
                label: "Current version",
                value: `${shortVersion(key.currentKeyVersion)} · ${String(key.lifecycleState ?? "unknown")}`,
              });
            }
            const auto = (key.autoKeyRotationDetails ?? {}) as Record<string, unknown>;
            const days = auto.rotationIntervalInDays;
            const next =
              typeof auto.timeOfNextRotation === "string"
                ? auto.timeOfNextRotation.slice(0, 10)
                : "";
            facts.push({
              label: "Rotation",
              value:
                key.isAutoRotationEnabled === true && typeof days === "number"
                  ? `every ${days} days${next ? `, next ${next}` : ""}`
                  : "not scheduled: turn on auto-rotation for the key, or rotate it yourself",
            });
            if (key.lifecycleState !== "ENABLED") {
              return {
                ok: false,
                detail: `The key is ${String(key.lifecycleState ?? "not enabled")}; only an enabled key can encrypt.`,
                facts,
              };
            }
          } catch (e) {
            if (!(e instanceof OciKmsError) || e.httpStatus !== 404) throw e;
            facts.push({
              label: "Key details",
              value: `not readable at ${new URL(config.managementEndpoint).host} by this identity (read keys would show them); not needed`,
            });
          }
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
          detail: `Encrypt and decrypt work (key version ${shortVersion(m.keyVersionId)}${readable ? "" : "; the key's details are not shown"}).`,
          facts,
        };
      } catch (e) {
        return { ok: false, detail: (e as Error).message, facts };
      }
    },
  };
}
