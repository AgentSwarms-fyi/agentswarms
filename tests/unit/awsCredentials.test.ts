// R429: the app's own AWS identity. The chain picks the first configured
// source and never falls through to another identity; each source is driven
// against a fake endpoint that records what it was sent. The metadata
// endpoints (link-local, refused by the SSRF guard everywhere else) are
// reached only at fixed URLs, directly, without following a redirect.
import { describe, expect, it } from "vitest";

import {
  AwsCredentialsError,
  awsCredentialSource,
  containerCredentialsUrl,
  createAwsCredentialChain,
  imdsEndpoint,
  stsEndpoint,
  xmlText,
} from "@/utils/aws/credentials.server";

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

const LATER = "2099-01-01T00:00:00Z";

const STS_OK = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>ASIAWEBIDENTITY0001</AccessKeyId>
      <SecretAccessKey>wi/secret+key</SecretAccessKey>
      <SessionToken>FwoGZXIvYXdzE&amp;token=</SessionToken>
      <Expiration>${LATER}</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

const creds = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      AccessKeyId: "ASIAMETADATA00001",
      SecretAccessKey: "meta-secret",
      Token: "meta-token",
      Expiration: LATER,
      ...extra,
    }),
  );

describe("which source the environment selects", () => {
  it("in the SDKs' order: keys, web identity, container, instance profile", () => {
    expect(awsCredentialSource({ AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "s" })).toBe("env");
    expect(
      awsCredentialSource({
        AWS_WEB_IDENTITY_TOKEN_FILE: "/t",
        AWS_ROLE_ARN: "arn:aws:iam::1:role/r",
      }),
    ).toBe("web-identity");
    expect(awsCredentialSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" })).toBe(
      "container",
    );
    expect(
      awsCredentialSource({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1" }),
    ).toBe("container");
    expect(awsCredentialSource({})).toBe("instance-metadata");
    // Keys win over a role that is also configured.
    expect(
      awsCredentialSource({
        AWS_ACCESS_KEY_ID: "A",
        AWS_SECRET_ACCESS_KEY: "s",
        AWS_ROLE_ARN: "arn:aws:iam::1:role/r",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/t",
      }),
    ).toBe("env");
  });

  it("half a pair is an error naming the missing variable, not a fall-through", () => {
    expect(() => awsCredentialSource({ AWS_ACCESS_KEY_ID: "A" })).toThrow(
      /AWS_ACCESS_KEY_ID is set without AWS_SECRET_ACCESS_KEY/,
    );
    expect(() => awsCredentialSource({ AWS_SECRET_ACCESS_KEY: "s" })).toThrow(
      /AWS_SECRET_ACCESS_KEY is set without AWS_ACCESS_KEY_ID/,
    );
    expect(() => awsCredentialSource({ AWS_ROLE_ARN: "arn:aws:iam::1:role/r" })).toThrow(
      /AWS_ROLE_ARN is set without AWS_WEB_IDENTITY_TOKEN_FILE/,
    );
    expect(() => awsCredentialSource({ AWS_WEB_IDENTITY_TOKEN_FILE: "/t" })).toThrow(
      AwsCredentialsError,
    );
  });
});

describe("env keys", () => {
  it("are used as given, never expire, and the identity masks the key id", async () => {
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env: {
        AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SECRET_ACCESS_KEY: "s",
        AWS_SESSION_TOKEN: "t",
      },
    });
    const c = await chain.get();
    expect(c).toMatchObject({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "s",
      sessionToken: "t",
      expiresAt: null,
      source: "env",
      identity: "access key AKIA…MPLE (AWS_ACCESS_KEY_ID)",
    });
    expect(c.identity).not.toContain("IOSFODNN7EXA");
  });
});

describe("web identity (EKS IRSA, any OIDC federation)", () => {
  const env = {
    AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
    AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/agentswarms-kms",
  };

  it("exchanges the token at the regional STS endpoint, unsigned, and reads the XML", async () => {
    const { calls, fetchImpl } = recorder(() => new Response(STS_OK));
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env,
      stsFetch: fetchImpl,
      readFile: () => "the.jwt.token\n",
    });
    const c = await chain.get();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sts.eu-west-1.amazonaws.com/");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers).not.toHaveProperty("authorization");
    const form = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(form)).toEqual({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: env.AWS_ROLE_ARN,
      RoleSessionName: "agentswarms-kms",
      WebIdentityToken: "the.jwt.token",
    });
    expect(c).toMatchObject({
      accessKeyId: "ASIAWEBIDENTITY0001",
      secretAccessKey: "wi/secret+key",
      sessionToken: "FwoGZXIvYXdzE&token=",
      source: "web-identity",
      identity: `role ${env.AWS_ROLE_ARN} (web identity)`,
      expiresAt: Date.parse(LATER),
    });
  });

  it("re-reads the token file at every exchange (the kubelet rotates it)", async () => {
    let n = 0;
    const tokens: string[] = [];
    const { fetchImpl } = recorder((_u, init) => {
      tokens.push(new URLSearchParams(String(init.body)).get("WebIdentityToken")!);
      return new Response(STS_OK.replace(LATER, "2026-01-01T00:10:00Z"));
    });
    let now = Date.parse("2026-01-01T00:00:00Z");
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env,
      stsFetch: fetchImpl,
      readFile: () => `token-${++n}`,
      now: () => now,
    });
    await chain.get();
    now += 6 * 60 * 1000; // inside the five-minute margin: refresh
    await chain.get();
    expect(tokens).toEqual(["token-1", "token-2"]);
  });

  it("an STS refusal names the role, the code and the message", async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response(
          "<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>",
          { status: 403 },
        ),
    );
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env,
      stsFetch: fetchImpl,
      readFile: () => "t",
    });
    await expect(chain.get()).rejects.toThrow(
      `STS refused AssumeRoleWithWebIdentity for ${env.AWS_ROLE_ARN}: AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity`,
    );
  });

  it("an unreadable or empty token file, and a bad session name, are refused before STS", async () => {
    const { calls, fetchImpl } = recorder(() => new Response(STS_OK));
    const missing = createAwsCredentialChain({
      region: "eu-west-1",
      env,
      stsFetch: fetchImpl,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(missing.get()).rejects.toThrow(
      /Could not read AWS_WEB_IDENTITY_TOKEN_FILE .*ENOENT/,
    );
    const empty = createAwsCredentialChain({
      region: "eu-west-1",
      env,
      stsFetch: fetchImpl,
      readFile: () => " ",
    });
    await expect(empty.get()).rejects.toThrow(/is empty/);
    const badName = createAwsCredentialChain({
      region: "eu-west-1",
      env: { ...env, AWS_ROLE_SESSION_NAME: "has spaces" },
      stsFetch: fetchImpl,
      readFile: () => "t",
    });
    await expect(badName.get()).rejects.toThrow(/not a session name/);
    expect(calls).toEqual([]);
  });

  it("an answer without credentials is an error, not empty keys", async () => {
    const { fetchImpl } = recorder(() => new Response("<AssumeRoleWithWebIdentityResponse/>"));
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env,
      stsFetch: fetchImpl,
      readFile: () => "t",
    });
    await expect(chain.get()).rejects.toThrow(/returned no AccessKeyId/);
  });

  it("the endpoint: an override wins, China regions take their own domain", () => {
    expect(stsEndpoint("cn-north-1", {})).toBe("https://sts.cn-north-1.amazonaws.com.cn/");
    expect(stsEndpoint("eu-west-1", { AWS_ENDPOINT_URL: "http://emu:4566/" })).toBe(
      "http://emu:4566/",
    );
    expect(
      stsEndpoint("eu-west-1", {
        AWS_ENDPOINT_URL: "http://emu:4566",
        AWS_ENDPOINT_URL_STS: "https://vpce-1.sts.eu-west-1.vpce.amazonaws.com",
      }),
    ).toBe("https://vpce-1.sts.eu-west-1.vpce.amazonaws.com/");
  });

  it("reads one element and decodes the XML entities", () => {
    expect(xmlText("<a><B>x&lt;y&amp;z</B></a>", "B")).toBe("x<y&z");
    expect(xmlText("<a/>", "B")).toBeNull();
  });
});

describe("container credentials (ECS task role, EKS Pod Identity)", () => {
  it("a relative URI goes to the ECS agent address", async () => {
    const { calls, fetchImpl } = recorder(() =>
      creds({ RoleArn: "arn:aws:iam::111122223333:role/task" }),
    );
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc" },
      metadataFetch: fetchImpl,
    });
    const c = await chain.get();
    expect(calls[0].url).toBe("http://169.254.170.2/v2/credentials/abc");
    expect(calls[0].headers).not.toHaveProperty("authorization");
    expect(c).toMatchObject({
      accessKeyId: "ASIAMETADATA00001",
      sessionToken: "meta-token",
      source: "container",
      identity: "role arn:aws:iam::111122223333:role/task (container credentials)",
    });
  });

  it("a full URI sends the authorization token, re-read from its file every time", async () => {
    let n = 0;
    const { calls, fetchImpl } = recorder(() => creds({ Expiration: "2026-01-01T00:01:00Z" }));
    let now = Date.parse("2026-01-01T00:00:00Z");
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env: {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/secrets/pods.eks.amazonaws.com/token",
        AWS_CONTAINER_AUTHORIZATION_TOKEN: "ignored-when-the-file-is-set",
      },
      metadataFetch: fetchImpl,
      readFile: () => `pod-token-${++n}\n`,
      now: () => now,
    });
    await chain.get();
    now += 1000;
    await chain.get(); // expires inside the margin: fetched again
    expect(calls.map((c) => c.headers.authorization)).toEqual(["pod-token-1", "pod-token-2"]);
  });

  it("an http full URI is allowed only to the loopback and the agent addresses", () => {
    for (const ok of [
      "http://127.0.0.1:51679/creds",
      "http://localhost/creds",
      "http://[::1]/creds",
      "http://169.254.170.2/creds",
      "http://169.254.170.23/v1/credentials",
      "http://[fd00:ec2::23]/v1/credentials",
      "https://creds.example.com/v1",
    ]) {
      expect(containerCredentialsUrl({ AWS_CONTAINER_CREDENTIALS_FULL_URI: ok })).toBe(
        new URL(ok).toString(),
      );
    }
    for (const bad of [
      "http://169.254.169.254/latest",
      "http://10.0.0.5/creds",
      "file:///etc/passwd",
      "nonsense",
    ]) {
      expect(() => containerCredentialsUrl({ AWS_CONTAINER_CREDENTIALS_FULL_URI: bad })).toThrow(
        AwsCredentialsError,
      );
    }
    expect(() =>
      containerCredentialsUrl({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "v2/no-slash" }),
    ).toThrow(/must start with \//);
  });

  it("a token with a line break is refused (it would split the header)", async () => {
    const { calls, fetchImpl } = recorder(() => creds());
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env: {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
        AWS_CONTAINER_AUTHORIZATION_TOKEN: "a\r\nX-Injected: 1",
      },
      metadataFetch: fetchImpl,
    });
    await expect(chain.get()).rejects.toThrow(/line break/);
    expect(calls).toEqual([]);
  });
});

describe("instance profile (IMDSv2 only)", () => {
  function imds(opts: { tokenStatus?: number; role?: string; code?: string } = {}) {
    return recorder((url, init) => {
      if (url.endsWith("/latest/api/token")) {
        return init.method === "PUT" && !opts.tokenStatus
          ? new Response("imds-session-token")
          : new Response("", { status: opts.tokenStatus ?? 405 });
      }
      if (url.endsWith("/security-credentials/")) {
        return opts.role === ""
          ? new Response("", { status: 404 })
          : new Response(`${opts.role ?? "app-role"}\n`);
      }
      return creds(opts.code ? { Code: opts.code } : { Code: "Success" });
    });
  }

  it("takes a session token with PUT, then the role, then its credentials", async () => {
    const { calls, fetchImpl } = imds();
    const c = await createAwsCredentialChain({
      region: "eu-west-1",
      env: {},
      metadataFetch: fetchImpl,
    }).get();
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      "PUT http://169.254.169.254/latest/api/token",
      "GET http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "GET http://169.254.169.254/latest/meta-data/iam/security-credentials/app-role",
    ]);
    expect(calls[0].headers["x-aws-ec2-metadata-token-ttl-seconds"]).toBe("21600");
    expect(calls[1].headers["x-aws-ec2-metadata-token"]).toBe("imds-session-token");
    expect(calls[2].headers["x-aws-ec2-metadata-token"]).toBe("imds-session-token");
    expect(c).toMatchObject({
      source: "instance-metadata",
      identity: "instance profile role app-role",
    });
  });

  it("never falls back to IMDSv1 when no token is given", async () => {
    const { calls, fetchImpl } = imds({ tokenStatus: 403 });
    await expect(
      createAwsCredentialChain({ region: "eu-west-1", env: {}, metadataFetch: fetchImpl }).get(),
    ).rejects.toThrow(/gave no IMDSv2 token \(HTTP 403\)/);
    expect(calls).toHaveLength(1);
  });

  it("off EC2: the error says how to give the app credentials", async () => {
    const fetchImpl = async () => {
      throw new Error("connect ETIMEDOUT 169.254.169.254:80");
    };
    await expect(
      createAwsCredentialChain({ region: "eu-west-1", env: {}, metadataFetch: fetchImpl }).get(),
    ).rejects.toThrow(/No AWS credentials: .*ETIMEDOUT.*Run with a role/);
  });

  it("AWS_EC2_METADATA_DISABLED means no call at all", async () => {
    const { calls, fetchImpl } = imds();
    await expect(
      createAwsCredentialChain({
        region: "eu-west-1",
        env: { AWS_EC2_METADATA_DISABLED: "true" },
        metadataFetch: fetchImpl,
      }).get(),
    ).rejects.toThrow(/AWS_EC2_METADATA_DISABLED/);
    expect(calls).toEqual([]);
  });

  it("no role, a role name that is not one, and a failed Code are errors", async () => {
    for (const [opts, re] of [
      [{ role: "" }, /no instance profile role/],
      [{ role: "../../latest/user-data" }, /no instance profile role/],
      [{ code: "Failure" }, /returned no credentials: Failure/],
    ] as const) {
      const { fetchImpl } = imds(opts);
      await expect(
        createAwsCredentialChain({ region: "eu-west-1", env: {}, metadataFetch: fetchImpl }).get(),
      ).rejects.toThrow(re);
    }
  });

  it("the endpoint: IPv4 by default, IPv6 by mode, or the operator's", () => {
    expect(imdsEndpoint({})).toBe("http://169.254.169.254");
    expect(imdsEndpoint({ AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: "IPv6" })).toBe(
      "http://[fd00:ec2::254]",
    );
    expect(imdsEndpoint({ AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://imds.test:1338/" })).toBe(
      "http://imds.test:1338",
    );
  });
});

describe("caching", () => {
  it("one fetch for concurrent callers, and none again until five minutes before expiry", async () => {
    const { calls, fetchImpl } = recorder(() => creds({ Expiration: "2026-01-01T01:00:00Z" }));
    let now = Date.parse("2026-01-01T00:00:00Z");
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/c" },
      metadataFetch: fetchImpl,
      now: () => now,
    });
    await Promise.all([chain.get(), chain.get(), chain.get()]);
    expect(calls).toHaveLength(1);
    now = Date.parse("2026-01-01T00:54:00Z");
    await chain.get();
    expect(calls).toHaveLength(1);
    now = Date.parse("2026-01-01T00:56:00Z");
    await chain.get();
    expect(calls).toHaveLength(2);
  });

  it("a failed fetch is not remembered", async () => {
    let fail = true;
    const { calls, fetchImpl } = recorder(() =>
      fail ? new Response("{}", { status: 500 }) : creds(),
    );
    const chain = createAwsCredentialChain({
      region: "eu-west-1",
      env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/c" },
      metadataFetch: fetchImpl,
    });
    await expect(chain.get()).rejects.toThrow(/refused: HTTP 500/);
    fail = false;
    await expect(chain.get()).resolves.toMatchObject({ source: "container" });
    expect(calls).toHaveLength(2);
  });
});

describe("the metadata client", () => {
  it("connects directly and refuses redirects", async () => {
    // The default metadataFetch, observed through the global fetch it calls.
    const real = globalThis.fetch;
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return creds();
    }) as typeof fetch;
    try {
      await createAwsCredentialChain({
        region: "eu-west-1",
        env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/c" },
      }).get();
    } finally {
      globalThis.fetch = real;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].redirect).toBe("error");
    expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });
});
