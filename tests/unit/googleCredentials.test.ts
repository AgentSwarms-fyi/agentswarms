// R435: the app's own Google Cloud identity, for Cloud KMS. Application Default
// Credentials without gcloud's file in the home directory: the file
// GOOGLE_APPLICATION_CREDENTIALS names is the source when it is set (never
// falling through to the metadata server), else the metadata server. Each
// source is driven against a fake endpoint that records what it was sent; a
// service account's assertion is verified with the key's public half.
import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GoogleCredentialsError,
  createGoogleCredentialChain,
  googleCredentialSource,
  metadataOrigin,
  serviceAccountAssertion,
} from "@/utils/google/credentials.server";
import { SsrfRefusedError } from "@/utils/ssrfGuard.server";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function recorder(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const SCOPE = "https://www.googleapis.com/auth/cloudkms";
const NOW = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const saKey = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "service_account",
    project_id: "acme-prod",
    private_key_id: "0123456789abcdef0123",
    private_key: PEM,
    client_email: "agentswarms@acme-prod.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
    ...over,
  });

const files = (map: Record<string, string>) => (p: string) => {
  if (!(p in map)) throw new Error(`ENOENT: no such file, open '${p}'`);
  return map[p];
};

const ENV = { GOOGLE_APPLICATION_CREDENTIALS: "/secrets/gcp.json" };
const oauthOk = (token = "ya29.app") =>
  json({ access_token: token, expires_in: 3599, token_type: "Bearer" });

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split(".");
  const verify = createVerify("RSA-SHA256").update(`${h}.${c}`);
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()),
    valid: verify.verify(publicKey, Buffer.from(s, "base64url")),
  };
}

describe("which source", () => {
  it("is the file GOOGLE_APPLICATION_CREDENTIALS names, by its type; else the metadata server", () => {
    const read = files({
      "/sa.json": saKey(),
      "/user.json": JSON.stringify({ type: "authorized_user" }),
      "/ext.json": JSON.stringify({ type: "external_account" }),
      "/imp.json": JSON.stringify({ type: "impersonated_service_account" }),
    });
    const at = (p: string) => googleCredentialSource({ GOOGLE_APPLICATION_CREDENTIALS: p }, read);
    expect(at("/sa.json")).toBe("service-account");
    expect(at("/user.json")).toBe("authorized-user");
    expect(at("/ext.json")).toBe("external-account");
    expect(at("/imp.json")).toBe("impersonated");
    expect(googleCredentialSource({}, read)).toBe("metadata");
  });

  it("refuses a file it cannot read, that is not JSON, or of a type it does not know, by name", () => {
    const read = files({
      "/bad.json": "{",
      "/odd.json": JSON.stringify({ type: "gdch_service_account" }),
    });
    const at = (p: string) => () =>
      googleCredentialSource({ GOOGLE_APPLICATION_CREDENTIALS: p }, read);
    expect(at("/missing.json")).toThrow(
      /Could not read GOOGLE_APPLICATION_CREDENTIALS \(\/missing\.json\)/,
    );
    expect(at("/bad.json")).toThrow(/is not JSON/);
    expect(at("/odd.json")).toThrow(/"gdch_service_account" credential; use a service_account key/);
  });
});

describe("a service account key", () => {
  it("signs an RS256 assertion with the key, for the scope, to the key's token_uri", () => {
    const jwt = serviceAccountAssertion({
      clientEmail: "a@p.iam.gserviceaccount.com",
      privateKey: PEM,
      privateKeyId: "kid-1",
      scope: SCOPE,
      audience: "https://oauth2.googleapis.com/token",
      now: NOW,
    });
    const { header, claims, valid } = decodeJwt(jwt);
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    expect(claims).toEqual({
      iss: "a@p.iam.gserviceaccount.com",
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
  });

  it("exchanges it at the token_uri for a token, and names the account and the key", async () => {
    const r = recorder(() => oauthOk());
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({ "/secrets/gcp.json": saKey() }),
      tokenFetch: r.fetchImpl,
      now: () => NOW,
    });
    const t = await chain.get();
    expect(t).toMatchObject({
      token: "ya29.app",
      source: "service-account",
      expiresAt: NOW + 3599_000,
      identity: "service account agentswarms@acme-prod.iam.gserviceaccount.com (key 01234567…)",
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(r.calls[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const { claims, valid } = decodeJwt(form.get("assertion")!);
    expect(valid).toBe(true);
    expect(claims.scope).toBe(SCOPE);
  });

  it("over Private Service Connect sends the request to the endpoint's oauth2 name, the audience unchanged", async () => {
    const r = recorder(() => oauthOk());
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      tokenUrl: "https://oauth2-kmsep.p.googleapis.com/token",
      readFile: files({ "/secrets/gcp.json": saKey() }),
      tokenFetch: r.fetchImpl,
      now: () => NOW,
    });
    await chain.get();
    expect(r.calls[0].url).toBe("https://oauth2-kmsep.p.googleapis.com/token");
    const { claims } = decodeJwt(new URLSearchParams(r.calls[0].body).get("assertion")!);
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
  });

  it("says what Google refused, and what is missing from a key", async () => {
    const r = recorder(() =>
      json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400),
    );
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({ "/secrets/gcp.json": saKey() }),
      tokenFetch: r.fetchImpl,
      now: () => NOW,
    });
    await expect(chain.get()).rejects.toThrow(
      /for service account agentswarms@acme-prod\.iam\.gserviceaccount\.com \(key 01234567…\), refused: invalid_grant: Invalid JWT Signature\./,
    );
    const noKey = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({ "/secrets/gcp.json": saKey({ private_key: "" }) }),
      tokenFetch: r.fetchImpl,
    });
    await expect(noKey.get()).rejects.toThrow(/a service account key without private_key/);
  });
});

describe("user credentials (gcloud auth application-default login)", () => {
  it("refreshes the token, and sends the quota project with every call", async () => {
    const r = recorder(() => oauthOk("ya29.user"));
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({
        "/secrets/gcp.json": JSON.stringify({
          type: "authorized_user",
          client_id: "764086051850-abc.apps.googleusercontent.com",
          client_secret: "d-FL95Q19q7MQmFpd7hHD0Ty",
          refresh_token: "1//0refresh",
          quota_project_id: "acme-prod",
        }),
      }),
      tokenFetch: r.fetchImpl,
      now: () => NOW,
    });
    const t = await chain.get();
    expect(t).toMatchObject({
      token: "ya29.user",
      source: "authorized-user",
      quotaProject: "acme-prod",
    });
    expect(t.identity).toMatch(
      /^user credentials \(gcloud auth application-default login, client 764086051850…\)$/,
    );
    const form = new URLSearchParams(r.calls[0].body);
    expect(r.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      client_id: "764086051850-abc.apps.googleusercontent.com",
      client_secret: "d-FL95Q19q7MQmFpd7hHD0Ty",
      refresh_token: "1//0refresh",
    });
  });
});

describe("workload identity federation (external_account)", () => {
  const AUD =
    "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/aks-pool/providers/aks";
  const IMP =
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/agentswarms@acme-prod.iam.gserviceaccount.com:generateAccessToken";
  const ext = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "external_account",
      audience: AUD,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { file: "/var/run/secrets/tokens/gcp" },
      ...over,
    });

  function sts(r: { calls: Call[] }, i = 0) {
    return Object.fromEntries(new URLSearchParams(r.calls[i].body));
  }

  it("exchanges the platform's token at STS, then impersonates the service account", async () => {
    const r = recorder((url) =>
      url.startsWith("https://sts.")
        ? json({
            access_token: "sts-token",
            issued_token_type: "x",
            token_type: "Bearer",
            expires_in: 3600,
          })
        : json({ accessToken: "ya29.impersonated", expireTime: "2027-01-15T09:00:00Z" }),
    );
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({
        "/secrets/gcp.json": ext({
          service_account_impersonation_url: IMP,
          service_account_impersonation: { token_lifetime_seconds: 1800 },
        }),
        "/var/run/secrets/tokens/gcp": "eyJ.k8s.token\n",
      }),
      tokenFetch: r.fetchImpl,
      now: () => NOW,
    });
    const t = await chain.get();
    expect(t).toMatchObject({
      token: "ya29.impersonated",
      expiresAt: Date.parse("2027-01-15T09:00:00Z"),
      source: "external-account",
      identity:
        "service account agentswarms@acme-prod.iam.gserviceaccount.com, through workload identity federation (pool aks-pool)",
    });
    expect(r.calls.map((c) => c.url)).toEqual(["https://sts.googleapis.com/v1/token", IMP]);
    expect(sts(r)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: AUD,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: "eyJ.k8s.token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    });
    expect(r.calls[1].headers.authorization).toBe("Bearer sts-token");
    expect(JSON.parse(r.calls[1].body)).toEqual({ scope: [SCOPE], lifetime: "1800s" });
  });

  it("without impersonation, the federated token is the one used, asked for the API's scope", async () => {
    const r = recorder(() => json({ access_token: "sts-token", expires_in: 3600 }));
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({
        "/secrets/gcp.json": ext(),
        "/var/run/secrets/tokens/gcp": "eyJ.k8s.token",
      }),
      tokenFetch: r.fetchImpl,
      now: () => NOW,
    });
    expect(await chain.get()).toMatchObject({
      token: "sts-token",
      identity: "workload identity federation (pool aks-pool)",
    });
    expect(sts(r).scope).toBe(SCOPE);
  });

  it("reads a URL source (with its headers, a JSON field), the metadata address directly, anything else guarded", async () => {
    const meta = recorder(() => json({ access_token: "azure-imds-token" }));
    const guarded = recorder((url) =>
      url.startsWith("https://sts.")
        ? json({ access_token: "sts", expires_in: 3600 })
        : json({ value: "oidc-from-ci" }),
    );
    const viaImds = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({
        "/secrets/gcp.json": ext({
          credential_source: {
            url: "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=api://x",
            headers: { Metadata: "True" },
            format: { type: "json", subject_token_field_name: "access_token" },
          },
        }),
      }),
      tokenFetch: guarded.fetchImpl,
      metadataFetch: meta.fetchImpl,
      now: () => NOW,
    });
    await viaImds.get();
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0].headers).toEqual({ Metadata: "True" });
    expect(sts(guarded).subject_token).toBe("azure-imds-token");

    const meta2 = recorder(() => json({}));
    const guarded2 = recorder((url) =>
      url.startsWith("https://sts.")
        ? json({ access_token: "sts", expires_in: 3600 })
        : json({ value: "oidc-from-ci" }),
    );
    await createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({
        "/secrets/gcp.json": ext({
          credential_source: {
            url: "https://token.ci.example/oidc",
            format: { type: "json", subject_token_field_name: "value" },
          },
        }),
      }),
      tokenFetch: guarded2.fetchImpl,
      metadataFetch: meta2.fetchImpl,
      now: () => NOW,
    }).get();
    expect(meta2.calls).toHaveLength(0);
    expect(guarded2.calls[0].url).toBe("https://token.ci.example/oidc");
    expect(sts(guarded2, 1).subject_token).toBe("oidc-from-ci");
  });

  it("refuses an AWS or executable source, and a header with a line break, before calling anything", async () => {
    const r = recorder(() => json({}));
    const chain = (cs: unknown) =>
      createGoogleCredentialChain({
        scope: SCOPE,
        env: ENV,
        readFile: files({ "/secrets/gcp.json": ext({ credential_source: cs }) }),
        tokenFetch: r.fetchImpl,
        metadataFetch: r.fetchImpl,
      }).get();
    await expect(
      chain({ environment_id: "aws1", region_url: "http://169.254.169.254/x" }),
    ).rejects.toThrow(/takes its token from AWS; this build reads a file or a URL/);
    await expect(chain({ executable: { command: "/bin/token" } })).rejects.toThrow(
      /from an executable/,
    );
    await expect(
      chain({ url: "https://token.ci.example/oidc", headers: { "X-A": "1\r\nInjected: 2" } }),
    ).rejects.toThrow(/is not a header value/);
    expect(r.calls).toHaveLength(0);
  });

  it("an SSRF refusal on the token URL reads as itself", async () => {
    const refuse = async () => {
      throw new SsrfRefusedError("Refused: 10.0.0.5 is a private address");
    };
    await expect(
      createGoogleCredentialChain({
        scope: SCOPE,
        env: ENV,
        readFile: files({ "/secrets/gcp.json": ext(), "/var/run/secrets/tokens/gcp": "t" }),
        tokenFetch: refuse,
      }).get(),
    ).rejects.toBeInstanceOf(SsrfRefusedError);
  });
});

describe("an impersonated_service_account file", () => {
  it("signs in as the source, then impersonates", async () => {
    const IMP =
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/kms-user@acme-prod.iam.gserviceaccount.com:generateAccessToken";
    const r = recorder((url) =>
      url === IMP
        ? json({ accessToken: "ya29.as-kms-user", expireTime: "2027-01-15T09:00:00Z" })
        : oauthOk("ya29.source"),
    );
    const t = await createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({
        "/secrets/gcp.json": JSON.stringify({
          type: "impersonated_service_account",
          service_account_impersonation_url: IMP,
          source_credentials: JSON.parse(saKey()),
        }),
      }),
      tokenFetch: r.fetchImpl,
      now: () => NOW,
    }).get();
    expect(t.token).toBe("ya29.as-kms-user");
    expect(t.identity).toBe(
      "service account kms-user@acme-prod.iam.gserviceaccount.com, as service account agentswarms@acme-prod.iam.gserviceaccount.com (key 01234567…)",
    );
    // The source's token is cloud-platform, to call iamcredentials.
    const { claims } = decodeJwt(new URLSearchParams(r.calls[0].body).get("assertion")!);
    expect(claims.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(r.calls[1].headers.authorization).toBe("Bearer ya29.source");
  });
});

describe("the metadata server", () => {
  const flavored = (body: unknown) => json(body, 200, { "metadata-flavor": "Google" });

  it("asks for the scope with Metadata-Flavor: Google, directly, and names the account", async () => {
    const meta = recorder((url) =>
      url.endsWith("/email")
        ? new Response("agentswarms@acme-prod.iam.gserviceaccount.com\n", {
            headers: { "metadata-flavor": "Google" },
          })
        : flavored({ access_token: "ya29.gce", expires_in: 3000, token_type: "Bearer" }),
    );
    const guarded = recorder(() => json({}));
    const t = await createGoogleCredentialChain({
      scope: SCOPE,
      env: {},
      tokenFetch: guarded.fetchImpl,
      metadataFetch: meta.fetchImpl,
      now: () => NOW,
    }).get();
    expect(t).toMatchObject({
      token: "ya29.gce",
      source: "metadata",
      identity: "service account agentswarms@acme-prod.iam.gserviceaccount.com (metadata server)",
    });
    expect(meta.calls[0].url).toBe(
      `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(SCOPE)}`,
    );
    expect(meta.calls[0].headers).toEqual({ "metadata-flavor": "Google" });
    expect(guarded.calls).toHaveLength(0);
  });

  it("refuses an answer without Metadata-Flavor: Google, and says what to set when nothing answers", async () => {
    const impostor = recorder(() => json({ access_token: "x", expires_in: 3000 }));
    await expect(
      createGoogleCredentialChain({
        scope: SCOPE,
        env: {},
        metadataFetch: impostor.fetchImpl,
      }).get(),
    ).rejects.toThrow(/not as Google's metadata server/);
    const down = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    await expect(
      createGoogleCredentialChain({ scope: SCOPE, env: {}, metadataFetch: down }).get(),
    ).rejects.toThrow(
      /No Google credentials: GOOGLE_APPLICATION_CREDENTIALS is not set, and the metadata server \(169\.254\.169\.254\) did not answer/,
    );
  });

  it("GCE_METADATA_HOST moves it, as host[:port] only", () => {
    expect(metadataOrigin({ GCE_METADATA_HOST: "127.0.0.1:8080" })).toBe("http://127.0.0.1:8080");
    expect(metadataOrigin({})).toBe("http://169.254.169.254");
    expect(() => metadataOrigin({ GCE_METADATA_HOST: "evil.example/x?" })).toThrow(
      GoogleCredentialsError,
    );
  });

  it("a set file never falls through to it", async () => {
    const meta = recorder(() =>
      json({ access_token: "x", expires_in: 3000 }, 200, { "metadata-flavor": "Google" }),
    );
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: files({ "/secrets/gcp.json": saKey() }),
      tokenFetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      metadataFetch: meta.fetchImpl,
    });
    await expect(chain.get()).rejects.toThrow(/could not be reached: ECONNREFUSED/);
    expect(meta.calls).toHaveLength(0);
  });
});

describe("caching", () => {
  it("keeps a token until five minutes before it expires, shares one fetch, and re-reads the file to refresh", async () => {
    let now = NOW;
    let key = saKey();
    const r = recorder(() => oauthOk(`ya29.${r.calls.length}`));
    const chain = createGoogleCredentialChain({
      scope: SCOPE,
      env: ENV,
      readFile: (p) => {
        if (p !== "/secrets/gcp.json") throw new Error("ENOENT");
        return key;
      },
      tokenFetch: r.fetchImpl,
      now: () => now,
    });
    const [a, b] = await Promise.all([chain.get(), chain.get()]);
    expect(a).toBe(b);
    expect(r.calls).toHaveLength(1);
    now += 3599_000 - 5 * 60_000 - 1;
    expect((await chain.get()).token).toBe(a.token);
    key = saKey({ client_email: "rotated@acme-prod.iam.gserviceaccount.com" });
    now += 2;
    const c = await chain.get();
    expect(r.calls).toHaveLength(2);
    expect(c.identity).toMatch(/^service account rotated@/);
  });
});
