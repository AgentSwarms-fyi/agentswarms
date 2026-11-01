// R431: the app's own Microsoft Entra ID identity, for Azure Key Vault. The
// chain picks the first configured source and never falls through to another
// identity; each source is driven against a fake endpoint that records what
// it was sent. The managed identity endpoints (link-local or loopback,
// refused by the SSRF guard everywhere else) are reached only at fixed URLs,
// or ones the operator set, directly, without following a redirect.
import { createHash, createVerify, X509Certificate } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AzureCredentialsError,
  authorityHost,
  azureCredentialSource,
  certificateAssertion,
  createAzureCredentialChain,
  managedIdentityEndpoint,
} from "@/utils/azure/credentials.server";
import { SsrfRefusedError } from "@/utils/ssrfGuard.server";

import { selfSignedCert } from "../fixtures/selfSignedCert";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function recorder(answer: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : "",
    });
    return answer(url, init);
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const CLIENT = "11111111-2222-3333-4444-555555555555";
const SCOPE = "https://vault.azure.net/.default";
const NOW = 1_800_000_000_000;

const secretEnv = {
  AZURE_TENANT_ID: TENANT,
  AZURE_CLIENT_ID: CLIENT,
  AZURE_CLIENT_SECRET: "the-secret",
};

const tokenOk = () => json({ token_type: "Bearer", expires_in: 3599, access_token: "entra-token" });

describe("which source", () => {
  it("is the first one configured, in DefaultAzureCredential's order", () => {
    expect(azureCredentialSource(secretEnv)).toBe("client-secret");
    // All three present: the secret, as DefaultAzureCredential's environment source does.
    expect(
      azureCredentialSource({
        ...secretEnv,
        AZURE_CLIENT_CERTIFICATE_PATH: "/c.pem",
        AZURE_FEDERATED_TOKEN_FILE: "/t",
      }),
    ).toBe("client-secret");
    expect(
      azureCredentialSource({
        ...secretEnv,
        AZURE_CLIENT_SECRET: "",
        AZURE_CLIENT_CERTIFICATE_PATH: "/c.pem",
        AZURE_FEDERATED_TOKEN_FILE: "/t",
      }),
    ).toBe("client-certificate");
    expect(
      azureCredentialSource({
        AZURE_TENANT_ID: TENANT,
        AZURE_CLIENT_ID: CLIENT,
        AZURE_FEDERATED_TOKEN_FILE: "/t",
      }),
    ).toBe("workload-identity");
    expect(azureCredentialSource({})).toBe("managed-identity");
    // A client id alone names a user-assigned managed identity.
    expect(azureCredentialSource({ AZURE_CLIENT_ID: CLIENT })).toBe("managed-identity");
  });

  it("refuses half a configuration by name, rather than trying another identity", () => {
    expect(() =>
      azureCredentialSource({ AZURE_CLIENT_SECRET: "s", AZURE_CLIENT_ID: CLIENT }),
    ).toThrow(
      /A client secret needs AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET; AZURE_TENANT_ID is not set/,
    );
    expect(() => azureCredentialSource({ AZURE_FEDERATED_TOKEN_FILE: "/t" })).toThrow(
      /AZURE_TENANT_ID and AZURE_CLIENT_ID are not set/,
    );
    expect(() => azureCredentialSource({ ...secretEnv, AZURE_CLIENT_ID: "not-a-guid" })).toThrow(
      /AZURE_CLIENT_ID "not-a-guid" is not an application/,
    );
    expect(() => azureCredentialSource({ ...secretEnv, AZURE_TENANT_ID: "../evil" })).toThrow(
      /AZURE_TENANT_ID "..\/evil" is not a tenant/,
    );
    expect(() => azureCredentialSource({ AZURE_CLIENT_ID: "x" })).toThrow(AzureCredentialsError);
  });

  it("takes the authority as an https origin only", () => {
    expect(authorityHost({})).toBe("https://login.microsoftonline.com");
    expect(authorityHost({ AZURE_AUTHORITY_HOST: "https://login.chinacloudapi.cn/" })).toBe(
      "https://login.chinacloudapi.cn",
    );
    expect(() => authorityHost({ AZURE_AUTHORITY_HOST: "http://login.example" })).toThrow(
      /https origin/,
    );
    expect(() => authorityHost({ AZURE_AUTHORITY_HOST: "https://u:p@login.example" })).toThrow();
  });
});

describe("a client secret", () => {
  it("is exchanged at the tenant's token endpoint for the vault's scope, and cached", async () => {
    const { calls, fetchImpl } = recorder(() => tokenOk());
    let now = NOW;
    const chain = createAzureCredentialChain({
      scope: SCOPE,
      env: secretEnv,
      tokenFetch: fetchImpl,
      now: () => now,
    });
    const [a, b] = await Promise.all([chain.get(), chain.get()]);
    expect(a).toBe(b); // one exchange for concurrent callers
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(calls[0].method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT,
      scope: SCOPE,
      client_secret: "the-secret",
    });
    expect(a).toMatchObject({
      token: "entra-token",
      expiresAt: NOW + 3599_000,
      source: "client-secret",
      identity: `service principal ${CLIENT} in tenant ${TENANT} (AZURE_CLIENT_SECRET)`,
    });
    expect(a.identity).not.toContain("the-secret");
    now += 3599_000 - 6 * 60_000; // still outside the five-minute margin
    await chain.get();
    expect(calls).toHaveLength(1);
    now += 2 * 60_000; // inside it
    await chain.get();
    expect(calls).toHaveLength(2);
  });

  it("says what Entra ID said, and that it could not be reached", async () => {
    const refused = recorder(() =>
      json(
        {
          error: "invalid_client",
          error_description:
            "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 1\r\nCorrelation ID: 2",
        },
        401,
      ),
    );
    await expect(
      createAzureCredentialChain({
        scope: SCOPE,
        env: secretEnv,
        tokenFetch: refused.fetchImpl,
      }).get(),
    ).rejects.toThrow(
      `Microsoft Entra ID refused a token for service principal ${CLIENT} in tenant ${TENANT} (AZURE_CLIENT_SECRET): invalid_client: AADSTS7000215: Invalid client secret provided.`,
    );
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      createAzureCredentialChain({ scope: SCOPE, env: secretEnv, tokenFetch: down }).get(),
    ).rejects.toThrow(/Microsoft Entra ID at login\.microsoftonline\.com could not be reached/);
  });

  it("lets a refusal by the SSRF guard read alone", async () => {
    const guard = async () => {
      throw new SsrfRefusedError("refused: a private address");
    };
    const err = await createAzureCredentialChain({
      scope: SCOPE,
      env: secretEnv,
      tokenFetch: guard,
    })
      .get()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfRefusedError);
    expect((err as Error).message).toBe("refused: a private address");
  });
});

describe("a client certificate", () => {
  const { keyPem, certPem } = selfSignedCert();

  it("signs an assertion Entra ID can check: RS256, the certificate's x5t, the token URL as audience", async () => {
    const { calls, fetchImpl } = recorder(() => tokenOk());
    const reads: string[] = [];
    const chain = createAzureCredentialChain({
      scope: SCOPE,
      env: {
        AZURE_TENANT_ID: TENANT,
        AZURE_CLIENT_ID: CLIENT,
        AZURE_CLIENT_CERTIFICATE_PATH: "/c.pem",
      },
      tokenFetch: fetchImpl,
      readFile: (p) => {
        reads.push(p);
        return certPem + keyPem; // certificate first: the order must not matter
      },
      now: () => NOW,
    });
    const t = await chain.get();
    expect(reads).toEqual(["/c.pem"]);
    const form = Object.fromEntries(new URLSearchParams(calls[0].body));
    expect(form.client_assertion_type).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(form.client_secret).toBeUndefined();
    const [h, c, s] = form.client_assertion.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    const der = new X509Certificate(certPem).raw;
    expect(header).toEqual({
      alg: "RS256",
      typ: "JWT",
      x5t: createHash("sha1").update(der).digest("base64url"),
    });
    expect(claims).toMatchObject({
      aud: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      iss: CLIENT,
      sub: CLIENT,
      nbf: NOW / 1000,
      exp: NOW / 1000 + 600,
    });
    expect(typeof claims.jti).toBe("string");
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(new X509Certificate(certPem).publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    expect(t.identity).toMatch(
      new RegExp(
        `^service principal ${CLIENT} in tenant ${TENANT} \\(certificate [0-9a-f]{8}…\\)$`,
      ),
    );
  });

  it("refuses a key that is not the certificate's, a PEM with no certificate, and an unreadable key", () => {
    const other = selfSignedCert("other");
    const base = { clientId: CLIENT, audience: "https://x/token", now: NOW };
    expect(() => certificateAssertion({ pem: keyPem + other.certPem, ...base })).toThrow(
      /the private key does not belong to the certificate/,
    );
    expect(() => certificateAssertion({ pem: keyPem, ...base })).toThrow(
      /holds no PEM certificate/,
    );
    expect(() =>
      certificateAssertion({
        pem: certPem + "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
        ...base,
      }),
    ).toThrow(/the private key could not be read/);
  });
});

describe("workload identity", () => {
  it("presents the projected token, read again at every exchange", async () => {
    const { calls, fetchImpl } = recorder(() => json({ access_token: "wi", expires_in: 60 }));
    let n = 0;
    const chain = createAzureCredentialChain({
      scope: SCOPE,
      env: {
        AZURE_TENANT_ID: TENANT,
        AZURE_CLIENT_ID: CLIENT,
        AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/azure/tokens/azure-identity-token",
        AZURE_AUTHORITY_HOST: "https://login.microsoftonline.us/",
      },
      tokenFetch: fetchImpl,
      readFile: () => `kubelet-token-${++n}\n`,
      now: () => NOW,
    });
    const t = await chain.get();
    await chain.get(); // 60 s tokens are inside the margin: exchanged again
    expect(calls.map((c) => c.url)).toEqual([
      `https://login.microsoftonline.us/${TENANT}/oauth2/v2.0/token`,
      `https://login.microsoftonline.us/${TENANT}/oauth2/v2.0/token`,
    ]);
    expect(calls.map((c) => new URLSearchParams(c.body).get("client_assertion"))).toEqual([
      "kubelet-token-1",
      "kubelet-token-2",
    ]);
    expect(t).toMatchObject({
      source: "workload-identity",
      identity: `workload identity ${CLIENT} in tenant ${TENANT}`,
    });
  });

  it("an empty or unreadable token file is the error", async () => {
    const env = {
      AZURE_TENANT_ID: TENANT,
      AZURE_CLIENT_ID: CLIENT,
      AZURE_FEDERATED_TOKEN_FILE: "/t",
    };
    await expect(
      createAzureCredentialChain({
        scope: SCOPE,
        env,
        tokenFetch: async () => tokenOk(),
        readFile: () => " \n",
      }).get(),
    ).rejects.toThrow("AZURE_FEDERATED_TOKEN_FILE (/t) is empty");
    await expect(
      createAzureCredentialChain({
        scope: SCOPE,
        env,
        tokenFetch: async () => tokenOk(),
        readFile: () => {
          throw new Error("ENOENT");
        },
      }).get(),
    ).rejects.toThrow("Could not read AZURE_FEDERATED_TOKEN_FILE (/t): ENOENT");
  });
});

describe("managed identity", () => {
  it("asks the instance metadata service for the vault's resource, with the Metadata header", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json({
        access_token: "mi",
        expires_on: String(NOW / 1000 + 3600),
        resource: "https://vault.azure.net",
      }),
    );
    const t = await createAzureCredentialChain({
      scope: SCOPE,
      env: {},
      metadataFetch: fetchImpl,
      tokenFetch: async () => {
        throw new Error("Entra ID must not be called");
      },
      now: () => NOW,
    }).get();
    expect(calls).toEqual([
      {
        url: "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net",
        method: "GET",
        headers: { metadata: "true" },
        body: "",
      },
    ]);
    expect(t).toMatchObject({
      token: "mi",
      expiresAt: NOW + 3600_000,
      identity: "managed identity (instance metadata)",
    });
  });

  it("names a user-assigned identity by its client id, and says plainly when there is no identity", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json({ error: "invalid_request", error_description: "Identity not found" }, 400),
    );
    await expect(
      createAzureCredentialChain({
        scope: SCOPE,
        env: { AZURE_CLIENT_ID: CLIENT },
        metadataFetch: fetchImpl,
      }).get(),
    ).rejects.toThrow(
      `The instance metadata service gave no token for the user-assigned identity ${CLIENT}: invalid_request: Identity not found`,
    );
    expect(new URL(calls[0].url).searchParams.get("client_id")).toBe(CLIENT);
    const silent = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    await expect(
      createAzureCredentialChain({ scope: SCOPE, env: {}, metadataFetch: silent }).get(),
    ).rejects.toThrow(
      /No Azure credentials: .* the instance metadata service \(169\.254\.169\.254\) did not answer \(connect ETIMEDOUT\)\. Run with a managed identity/,
    );
  });

  it("uses App Service's endpoint and header when the platform sets them", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json({ access_token: "as", expires_on: NOW / 1000 + 3600 }),
    );
    await createAzureCredentialChain({
      scope: "https://managedhsm.azure.net/.default",
      env: { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "hdr" },
      metadataFetch: fetchImpl,
      now: () => NOW,
    }).get();
    expect(calls[0].url).toBe(
      "http://localhost:42356/msi/token?api-version=2019-08-01&resource=https%3A%2F%2Fmanagedhsm.azure.net",
    );
    expect(calls[0].headers).toEqual({ "x-identity-header": "hdr" });
  });

  it("holds the endpoints to the loopback and link-local over http; the operator may move the metadata service", () => {
    expect(() =>
      managedIdentityEndpoint({
        IDENTITY_ENDPOINT: "http://10.0.0.5/msi/token",
        IDENTITY_HEADER: "h",
      }),
    ).toThrow(/must be https, or http to the loopback or a link-local address/);
    expect(
      managedIdentityEndpoint({
        IDENTITY_ENDPOINT: "https://id.example/msi/token",
        IDENTITY_HEADER: "h",
      }).url,
    ).toBe("https://id.example/msi/token");
    expect(() => managedIdentityEndpoint({ IDENTITY_ENDPOINT: "http://127.0.0.1:1/t" })).toThrow(
      "IDENTITY_ENDPOINT is set without IDENTITY_HEADER",
    );
    expect(
      managedIdentityEndpoint({ AZURE_POD_IDENTITY_AUTHORITY_HOST: "http://lowkey-vault:8080" }),
    ).toEqual({ kind: "imds", url: "http://lowkey-vault:8080/metadata/identity/oauth2/token" });
    expect(() =>
      managedIdentityEndpoint({ AZURE_POD_IDENTITY_AUTHORITY_HOST: "http://h:8080/path" }),
    ).toThrow(/must be an origin/);
  });

  it("refuses a header with a line break", async () => {
    await expect(
      createAzureCredentialChain({
        scope: SCOPE,
        env: { IDENTITY_ENDPOINT: "http://127.0.0.1:1/t", IDENTITY_HEADER: "a\r\nX-Evil: 1" },
        metadataFetch: async () => json({}),
      }).get(),
    ).rejects.toThrow("IDENTITY_HEADER contains a line break");
  });
});

describe("the metadata client", () => {
  it("connects directly and refuses redirects", async () => {
    const real = globalThis.fetch;
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return json({ access_token: "mi", expires_in: 3600 });
    }) as typeof fetch;
    try {
      await createAzureCredentialChain({ scope: SCOPE, env: {} }).get();
    } finally {
      globalThis.fetch = real;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].redirect).toBe("error");
    expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });
});
