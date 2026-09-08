// HashiCorp Vault Transit as a key provider. The transit key is the KEK: the
// DEK goes to Vault as plaintext once, comes back wrapped ("vault:v1:…"),
// and is unwrapped by Vault on every process start. Vault keeps the key;
// the app keeps a token that may use it.
//
// Authentication, in the order a deployment usually has it: a token in the
// environment, a token in a file (a mounted secret), or a Kubernetes
// service-account login against Vault's kubernetes auth method.
import { readFileSync } from "node:fs";

import {
  KmsConfigError,
  bytesToBase64,
  base64ToBytes,
  parseVaultKeyRef,
  type KeyProvider,
  type WrappedDek,
} from "./types";

export type VaultConfig = {
  addr: string;
  namespace?: string;
  token?: string;
  tokenFile?: string;
  k8sRole?: string;
  k8sMount: string;
  k8sJwtFile: string;
  keyRef: string;
};

/** Read the VAULT_* variables. Null when Vault is not configured at all. */
export function vaultConfigFromEnv(
  keyRef: string,
  env: Record<string, string | undefined> = process.env,
): VaultConfig | null {
  const addr = (env.VAULT_ADDR ?? "").trim().replace(/\/+$/, "");
  if (!addr) return null;
  const token = (env.VAULT_TOKEN ?? "").trim() || undefined;
  const tokenFile = (env.VAULT_TOKEN_FILE ?? "").trim() || undefined;
  const k8sRole = (env.VAULT_K8S_ROLE ?? "").trim() || undefined;
  if (!token && !tokenFile && !k8sRole) {
    throw new KmsConfigError(
      "VAULT_ADDR is set but no way to authenticate: set VAULT_TOKEN, VAULT_TOKEN_FILE or VAULT_K8S_ROLE",
    );
  }
  return {
    addr,
    namespace: (env.VAULT_NAMESPACE ?? "").trim() || undefined,
    token,
    tokenFile,
    k8sRole,
    k8sMount: (env.VAULT_K8S_MOUNT ?? "").trim() || "kubernetes",
    k8sJwtFile:
      (env.VAULT_K8S_JWT_FILE ?? "").trim() ||
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    keyRef,
  };
}

type Fetch = typeof fetch;

export function createVaultProvider(config: VaultConfig, fetchImpl: Fetch = fetch): KeyProvider {
  const { mount, name } = parseVaultKeyRef(config.keyRef);
  let clientToken: string | null = null;

  async function token(): Promise<string> {
    if (clientToken) return clientToken;
    if (config.token) return (clientToken = config.token);
    if (config.tokenFile) return (clientToken = readFileSync(config.tokenFile, "utf8").trim());
    // Kubernetes auth: exchange the pod's service-account JWT for a client token.
    const jwt = readFileSync(config.k8sJwtFile, "utf8").trim();
    const res = await fetchImpl(`${config.addr}/v1/auth/${config.k8sMount}/login`, {
      method: "POST",
      headers: headers(null, config.namespace),
      body: JSON.stringify({ role: config.k8sRole, jwt }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      auth?: { client_token?: string };
      errors?: string[];
    };
    if (!res.ok || !body.auth?.client_token) {
      throw new Error(
        `Vault kubernetes login failed (${res.status}): ${(body.errors ?? []).join("; ") || "no client token"}`,
      );
    }
    return (clientToken = body.auth.client_token);
  }

  async function call(path: string, init: { method: string; body?: unknown }) {
    const res = await fetchImpl(`${config.addr}/v1/${path}`, {
      method: init.method,
      headers: headers(await token(), config.namespace),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
      errors?: string[];
    };
    if (!res.ok) {
      // A 403 is the one operators hit: the token lacks the transit policy.
      const why = (body.errors ?? []).join("; ") || res.statusText || "no detail";
      throw new Error(`Vault ${init.method} ${path} failed (${res.status}): ${why}`);
    }
    return body.data ?? {};
  }

  return {
    id: "vault",
    keyRef: config.keyRef,
    async wrapDek(dek) {
      const data = await call(`${mount}/encrypt/${name}`, {
        method: "POST",
        body: { plaintext: bytesToBase64(dek) },
      });
      const material = data.ciphertext;
      if (typeof material !== "string" || !material.startsWith("vault:")) {
        throw new Error("Vault returned no ciphertext for the data key");
      }
      return { provider: "vault", keyRef: config.keyRef, material };
    },
    async unwrapDek(wrapped) {
      if (wrapped.provider !== "vault") {
        throw new Error(`This data key was wrapped by ${wrapped.provider}, not Vault`);
      }
      const data = await call(`${mount}/decrypt/${name}`, {
        method: "POST",
        body: { ciphertext: wrapped.material },
      });
      if (typeof data.plaintext !== "string") {
        throw new Error("Vault returned no plaintext for the data key");
      }
      const dek = base64ToBytes(data.plaintext);
      if (dek.length !== 32) {
        throw new Error(`The unwrapped data key is ${dek.length} bytes, not 32`);
      }
      return dek;
    },
    async probe() {
      try {
        const data = await call(`${mount}/keys/${name}`, { method: "GET" });
        const type = typeof data.type === "string" ? data.type : "unknown type";
        return { ok: true, detail: `${config.addr} · ${mount}/keys/${name} (${type})` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };
}

function headers(token: string | null, namespace?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Vault-Token": token } : {}),
    ...(namespace ? { "X-Vault-Namespace": namespace } : {}),
  };
}
