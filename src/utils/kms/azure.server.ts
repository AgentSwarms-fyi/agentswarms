// Azure Key Vault, and Azure Managed HSM, as a key provider. The vault key is
// the KEK. Key Vault has no data-key operation, so the DEK is 32 random bytes
// the keyring makes (createDataKey), wrapped with wrapKey and unwrapped with unwrapKey once per
// process start. An RSA key wraps with RSA-OAEP-256 (Key Vault Standard keeps
// it in software, Premium's RSA-HSM in HSMs); a Managed HSM's AES key
// (oct-HSM) with A256KW, AES key wrap.
//
// No SDK: the REST API with an Entra ID token from the app's own identity
// (utils/azure/credentials.server). The stored material names the key VERSION
// that wrapped it, and unwrap asks that version, so a rotated key keeps
// unwrapping what its older versions wrapped while they stay enabled. Unwrap
// also refuses material whose key id is not under the row's own key: a
// database row an attacker rewrote cannot point the app at their own vault.
import { describeConnectivity } from "@/utils/providers/connectivityPath.server";
import { SsrfRefusedError, providerFetch, withPrivatePathScope } from "@/utils/ssrfGuard.server";
import {
  createAzureCredentialChain,
  type AzureCredentialChain,
} from "@/utils/azure/credentials.server";
import {
  KmsConfigError,
  parseAzureKeyRef,
  type AzureKeyRef,
  type KeyProvider,
  type ProbeResult,
  type WrappedDek,
} from "./types";

/** The Key Vault REST API version every call names. */
export const AZURE_KEY_VAULT_API = "7.4";

/** What a KMS_REQUIRE_PRIVATE refusal tells the operator to check. */
export const AZURE_PRIVATE_PATH_ADVICE =
  "Reach the vault over its private endpoint, with the privatelink.vaultcore.azure.net DNS zone " +
  "(privatelink.managedhsm.azure.net for a Managed HSM) linked to this server's network, or send " +
  "the call through HTTPS_PROXY.";

export type AzureKeyVaultConfig = AzureKeyRef & {
  /** KMS_REQUIRE_PRIVATE: every Key Vault call must take a private path. */
  requirePrivate: boolean;
};

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TRUE = /^(1|true|yes|on)$/i;

/** Read the key reference and the rule. Throws a KmsConfigError naming what is wrong. */
export function azureKeyVaultConfigFromEnv(
  keyRef: string,
  env: Env = process.env,
): AzureKeyVaultConfig {
  return {
    ...parseAzureKeyRef(keyRef),
    requirePrivate: TRUE.test((env.KMS_REQUIRE_PRIVATE ?? "").trim()),
  };
}

export type AzureKeyVaultDeps = {
  credentials?: AzureCredentialChain;
  /** The guarded fetch every Key Vault and Entra ID call goes through. Tests replace it. */
  fetch?: Fetch;
  /** Records a private-path refusal (the audit trail); never throws. */
  onRefuse?: (detail: string) => void;
  env?: Env;
  sleep?: (ms: number) => Promise<void>;
};

/** A Key Vault error, with the code Azure named (the inner code when there is one). */
export class AzureKeyVaultError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AzureKeyVaultError";
  }
}

const HINTS: Record<string, string> = {
  ForbiddenByRbac:
    "Give the app's identity the Key Vault Crypto Service Encryption User role on the key or the vault (get, wrapKey and unwrapKey).",
  ForbiddenByPolicy:
    "Add an access policy for the app's identity with the key permissions Get, Wrap Key and Unwrap Key.",
  ForbiddenByFirewall:
    "The vault's firewall refused this server's address: reach the vault over its private endpoint, or allow the address.",
  ForbiddenByConnection:
    "The vault accepts private endpoint connections only: reach it over its private endpoint.",
  KeyNotFound:
    "Check KMS_KEY_REF: the vault, the key name and the version, and that the key was not deleted.",
  Unauthorized:
    "The token was not accepted: check that AZURE_TENANT_ID is the vault's tenant and the identity still exists.",
};

/** RSA keys wrap with OAEP over SHA-256; a Managed HSM AES key with AES key wrap. */
export function wrapAlgorithmFor(kty: string): "RSA-OAEP-256" | "A256KW" {
  if (kty === "RSA" || kty === "RSA-HSM") return "RSA-OAEP-256";
  if (kty === "oct" || kty === "oct-HSM") return "A256KW";
  throw new KmsConfigError(
    `The key is ${kty || "of an unknown type"}; wrapping a data key needs an RSA key (Key Vault) or an AES key (Managed HSM)`,
  );
}

const ALGORITHMS = new Set(["RSA-OAEP-256", "A256KW"]);
const VERSION = /^[0-9A-Za-z]{1,64}$/;

const b64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

type StoredMaterial = { kid: string; alg: string; value: string };

function readMaterial(material: string): StoredMaterial {
  let m: unknown;
  try {
    m = JSON.parse(material);
  } catch {
    throw new Error("The stored data key is not Azure Key Vault material");
  }
  const o = m as Record<string, unknown>;
  if (typeof o.kid !== "string" || typeof o.alg !== "string" || typeof o.value !== "string") {
    throw new Error("The stored data key is not Azure Key Vault material");
  }
  return { kid: o.kid, alg: o.alg, value: o.value };
}

/**
 * The key version a stored data key names, checked against the row's own
 * key: the same vault, the same key, a version (and the same one, when the
 * reference pins it).
 */
export function checkedKid(kid: string, rowKeyRef: string): string {
  const ref = parseAzureKeyRef(rowKeyRef);
  const prefix = `${ref.vault}/keys/${ref.name}/`;
  const version = kid.startsWith(prefix) ? kid.slice(prefix.length) : "";
  if (!VERSION.test(version) || (ref.version && version !== ref.version)) {
    throw new Error(
      `The stored data key names ${kid}, which is not a version of ${ref.keyRef}; refusing to unwrap it`,
    );
  }
  return `${prefix}${version}`;
}

/**
 * An RSA key's size, from its modulus as a number. Counting bytes is wrong
 * for a modulus sent with a leading zero (a signed encoding): the emulator
 * answered a 2048-bit key with 257 bytes, and the card said 2056-bit.
 */
export function rsaBits(n: unknown): number | null {
  if (typeof n !== "string" || !n) return null;
  const bytes = Buffer.from(n, "base64url");
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return null;
  return (bytes.length - i) * 8 - (Math.clz32(bytes[i]) - 24);
}

function bits(key: Record<string, unknown>): string {
  const n = rsaBits(key.n);
  return n ? `${n}-bit ` : "";
}

function protectionOf(
  kind: AzureKeyRef["kind"],
  kty: string,
  key: Record<string, unknown>,
): string {
  const size = bits(key);
  const family = kty.startsWith("RSA") ? "RSA" : kty.startsWith("oct") ? "AES" : kty;
  if (kind === "managed-hsm")
    return `${family} ${size}key in your Managed HSM pool (single-tenant HSMs)`;
  if (kty.endsWith("-HSM")) return `${family} ${size}key in Key Vault Premium's HSMs`;
  return `${family} ${size}key, software-protected`;
}

function recoveryOf(level: string): string {
  if (!level) return "unknown";
  return /Purgeable/.test(level)
    ? `${level}: a purge destroys every credential this key wraps; turn on purge protection`
    : `${level} (purge protection on)`;
}

export function createAzureKeyVaultProvider(
  config: AzureKeyVaultConfig,
  deps: AzureKeyVaultDeps = {},
): KeyProvider {
  const env = deps.env ?? process.env;
  const guarded: Fetch = deps.fetch ?? ((url, init) => providerFetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const credentials =
    deps.credentials ??
    createAzureCredentialChain({ scope: config.scope, env, tokenFetch: guarded });

  // The Key Vault call inside the private-path scope. The token is fetched
  // before it, outside: Entra ID has no private endpoint (see credentials).
  function scoped<T>(fn: () => Promise<T>): Promise<T> {
    return withPrivatePathScope((policy) => {
      policy.required = config.requirePrivate;
      policy.label = "Azure Key Vault";
      policy.advice = AZURE_PRIVATE_PATH_ADVICE;
      policy.onRefuse = deps.onRefuse;
      return fn();
    });
  }

  async function call(
    op: string,
    method: "GET" | "POST",
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await credentials.get();
    const body = payload ? JSON.stringify(payload) : undefined;
    const target = `${url}?api-version=${AZURE_KEY_VAULT_API}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await scoped(() =>
          guarded(target, {
            method,
            headers: {
              authorization: `Bearer ${token.token}`,
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
          `Azure Key Vault ${op}: ${new URL(config.vault).host} could not be reached (${cause?.code ?? cause?.message ?? (e as Error).message})`,
        );
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return json;
      const err = (json.error ?? {}) as Record<string, unknown>;
      const inner = (err.innererror ?? {}) as Record<string, unknown>;
      const code =
        (typeof inner.code === "string" && inner.code) ||
        (typeof err.code === "string" && err.code) ||
        `HTTP ${res.status}`;
      const message = typeof err.message === "string" ? err.message : "no detail";
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(after) && after > 0 ? Math.min(after, 5) * 1000 : attempt ? 800 : 200,
        );
        continue;
      }
      const hint = HINTS[code] ?? HINTS[String(err.code)] ?? "";
      throw new AzureKeyVaultError(
        `Azure Key Vault ${op} refused (${res.status} ${code}): ${message}${hint ? ` ${hint}` : ""}`,
        code,
        res.status,
      );
    }
  }

  const keyUrl = config.version
    ? `${config.vault}/keys/${config.name}/${config.version}`
    : `${config.vault}/keys/${config.name}`;

  async function getKey() {
    const json = await call("get key", "GET", keyUrl);
    const key = (json.key ?? {}) as Record<string, unknown>;
    const attributes = (json.attributes ?? {}) as Record<string, unknown>;
    const kid = typeof key.kid === "string" ? key.kid : "";
    // The versioned id the vault answered with must be this key's.
    const versioned = checkedKid(kid, config.keyRef);
    return {
      kid: versioned,
      kty: typeof key.kty === "string" ? key.kty : "",
      ops: Array.isArray(key.key_ops) ? (key.key_ops as unknown[]).map(String) : null,
      key,
      attributes,
    };
  }

  /** Why this key cannot wrap a data key now, or null. */
  function unusable(k: Awaited<ReturnType<typeof getKey>>, now = Date.now()): string | null {
    if (k.attributes.enabled === false)
      return "The key is disabled; only an enabled key can wrap or unwrap.";
    const exp = Number(k.attributes.exp);
    if (Number.isFinite(exp) && exp > 0 && exp * 1000 <= now) {
      return `The key expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}.`;
    }
    const nbf = Number(k.attributes.nbf);
    if (Number.isFinite(nbf) && nbf > 0 && nbf * 1000 > now) {
      return `The key is not active until ${new Date(nbf * 1000).toISOString().slice(0, 10)}.`;
    }
    if (k.ops && !(k.ops.includes("wrapKey") && k.ops.includes("unwrapKey"))) {
      return `The key's permitted operations (${k.ops.join(", ") || "none"}) do not include wrapKey and unwrapKey.`;
    }
    return null;
  }

  return {
    id: "azure",
    keyRef: config.keyRef,
    async wrapDek(dek) {
      const k = await getKey();
      const why = unusable(k);
      if (why) throw new Error(why);
      const alg = wrapAlgorithmFor(k.kty);
      const json = await call("wrapKey", "POST", `${k.kid}/wrapkey`, { alg, value: b64url(dek) });
      const value = typeof json.value === "string" ? json.value : "";
      if (!value) throw new Error("Azure Key Vault wrapKey returned no value");
      // The version that wrapped it, as the vault said, checked like any other.
      const kid = checkedKid(typeof json.kid === "string" ? json.kid : k.kid, config.keyRef);
      const material: StoredMaterial = { kid, alg, value };
      return { provider: "azure", keyRef: config.keyRef, material: JSON.stringify(material) };
    },
    async unwrapDek(wrapped: WrappedDek) {
      if (wrapped.provider !== "azure") {
        throw new Error(`This data key was wrapped by ${wrapped.provider}, not Azure Key Vault`);
      }
      const m = readMaterial(wrapped.material);
      if (!ALGORITHMS.has(m.alg)) {
        throw new Error(
          `The stored data key names the algorithm ${m.alg}, which this build does not use`,
        );
      }
      // The row's own key, not whatever the material claims.
      const kid = checkedKid(m.kid, wrapped.keyRef);
      const json = await call("unwrapKey", "POST", `${kid}/unwrapkey`, {
        alg: m.alg,
        value: m.value,
      });
      if (typeof json.value !== "string" || !json.value) {
        throw new Error("Azure Key Vault unwrapKey returned no value");
      }
      return fromB64url(json.value);
    },
    async probe(): Promise<ProbeResult> {
      const facts: NonNullable<ProbeResult["facts"]> = [];
      try {
        const path = await describeConnectivity(`${config.vault}/`).catch(() => null);
        facts.push({
          label: "Endpoint",
          value: `${config.vault}${path ? ` · ${path.summary}` : ""}`,
        });
        if (config.requirePrivate) {
          facts.push({
            label: "Network rule",
            value:
              "private path required (KMS_REQUIRE_PRIVATE); the Entra ID sign-in is not covered",
          });
        }
        const token = await credentials.get();
        facts.push({ label: "Signed in as", value: token.identity });
        const k = await getKey();
        facts.push({ label: "Key", value: k.kid });
        facts.push({ label: "Key type", value: protectionOf(config.kind, k.kty, k.key) });
        const why = unusable(k);
        facts.push({ label: "State", value: why ? "not usable" : "Enabled" });
        facts.push({
          label: "Recovery",
          value: recoveryOf(String(k.attributes.recoveryLevel ?? "")),
        });
        if (why) return { ok: false, detail: why, facts };
        return {
          ok: true,
          detail: `Enabled for wrapKey and unwrapKey (${wrapAlgorithmFor(k.kty)}).`,
          facts,
        };
      } catch (e) {
        return { ok: false, detail: (e as Error).message, facts };
      }
    },
  };
}
