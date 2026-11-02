// R437: the app's own OCI identity (src/utils/oci/credentials.server.ts) — an
// API key from an OCI config file, a resource principal, or an instance
// principal exchanged at the identity service — chosen once, never falling
// through to another.
//
// The instance principal's protocol is the OCI Go SDK's (common/auth): the
// metadata service's /opc/v2 paths with "Authorization: Bearer Oracle", the
// federation body, and the keyId <tenancy>/fed-x509-sha256/<SHA-256 of the
// certificate>. The certificate chain is a test-only stand-in
// (tests/fixtures/ociInstanceIdentity.ts).
import {
  createHash,
  createVerify,
  generateKeyPairSync,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createOciCredentialChain,
  ociAuthSource,
  parseOciConfig,
  type OciCredentialDeps,
} from "@/utils/oci/credentials.server";
import { ociKeyFingerprint } from "@/utils/oci/signer";
import {
  INSTANCE,
  INTERMEDIATE_CERT,
  LEAF_CERT,
  LEAF_KEY,
  TENANCY,
} from "../fixtures/ociInstanceIdentity";

const USER = "ocid1.user.oc1..aaaaaaaar437user";
const TEN = "ocid1.tenancy.oc1..aaaaaaaar437tenancy";

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (k: KeyObject) => k.export({ type: "pkcs8", format: "pem" }).toString();
const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;

/** Verify an Authorization header's signature over the signing string it names. */
function verify(
  auth: string,
  headers: Record<string, string>,
  method: string,
  url: string,
  pub: KeyObject,
  body = "",
) {
  const names = /headers="([^"]+)"/.exec(auth)![1].split(" ");
  const u = new URL(url);
  const signing = names
    .map((n) =>
      n === "(request-target)"
        ? `(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}`
        : n === "host"
          ? `host: ${u.host}`
          : n === "content-length"
            ? `content-length: ${Buffer.byteLength(body)}` // fetch sets it from the body
            : `${n}: ${headers[n]}`,
    )
    .join("\n");
  return createVerify("RSA-SHA256")
    .update(signing)
    .verify(pub, /signature="([^"]+)"/.exec(auth)![1], "base64");
}

const notFound = (p: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });

function files(map: Record<string, string>) {
  return (p: string) => {
    // Paths as the platform resolves them: in production a Linux container's.
    const k = Object.keys(map).find((m) => resolve(m) === resolve(p));
    if (k) return map[k];
    throw notFound(p);
  };
}

describe("which identity", () => {
  it("OCI_AUTH names it; otherwise a config file, then a resource principal, then the instance", () => {
    expect(ociAuthSource({ OCI_AUTH: "Instance-Principal", OCI_CONFIG_FILE: "/c" })).toBe(
      "instance_principal",
    );
    expect(ociAuthSource({ OCI_CONFIG_FILE: "/c", OCI_RESOURCE_PRINCIPAL_VERSION: "2.2" })).toBe(
      "api_key",
    );
    expect(ociAuthSource({ OCI_RESOURCE_PRINCIPAL_VERSION: "2.2" })).toBe("resource_principal");
    expect(ociAuthSource({})).toBe("instance_principal");
  });

  it("refuses what it does not support by name, not by falling back", () => {
    expect(() => ociAuthSource({ OCI_AUTH: "oke_workload_identity" })).toThrow(
      /OKE workload identity is not supported by this release; on OKE use the node pool's instance principal/,
    );
    expect(() => ociAuthSource({ OCI_AUTH: "security_token" })).toThrow(/oci session authenticate/);
    expect(() => ociAuthSource({ OCI_AUTH: "magic" })).toThrow(
      /OCI_AUTH must be api_key, instance_principal or resource_principal, not magic/,
    );
  });
});

describe("an API key from an OCI config file", () => {
  const { privateKey, publicKey } = rsa();
  const fp = ociKeyFingerprint(privateKey);
  const config = (extra = "") =>
    `# written by oci setup config\n[DEFAULT]\nuser=${USER}\nfingerprint=${fp}\ntenancy=${TEN}\nregion=us-ashburn-1\nkey_file=keys/app.pem\n${extra}`;
  const env = { OCI_CONFIG_FILE: "/etc/oci/config" };

  it("signs as tenancy/user/fingerprint, the key file read beside the config", async () => {
    const chain = createOciCredentialChain({
      env,
      readFile: files({ "/etc/oci/config": config(), "/etc/oci/keys/app.pem": pem(privateKey) }),
    });
    const c = await chain.get();
    expect(chain.source).toBe("api_key");
    expect(c.key.keyId).toBe(`${TEN}/${USER}/${fp}`);
    expect(c.identity).toBe(`user ${USER} (API key ${fp})`);
    expect(c.expiresAt).toBeNull();
    expect(ociKeyFingerprint(c.key.privateKey)).toBe(ociKeyFingerprint(publicKey));
  });

  it("a profile takes DEFAULT's values unless it sets its own", () => {
    const text = `[DEFAULT]\nuser=a\ntenancy=t\n; a comment\n[app]\nuser = b\nkey_file=/k\n`;
    expect(parseOciConfig(text, "app")).toEqual({ user: "b", tenancy: "t", key_file: "/k" });
    expect(parseOciConfig(text, "DEFAULT")).toEqual({ user: "a", tenancy: "t" });
    expect(parseOciConfig(text, "other")).toBeNull();
  });

  it("names what is missing, and a profile that is not there", async () => {
    const get = (text: string, profile?: string) =>
      createOciCredentialChain({
        env: { ...env, ...(profile ? { OCI_CONFIG_PROFILE: profile } : {}) },
        readFile: files({ "/etc/oci/config": text }),
      }).get();
    await expect(get(`[DEFAULT]\nuser=${USER}\n`)).rejects.toThrow(
      "The [DEFAULT] profile in /etc/oci/config has no fingerprint, key_file, tenancy: an API key needs the user, its fingerprint, key_file and the tenancy",
    );
    await expect(get(config(), "app")).rejects.toThrow(
      "OCI_CONFIG_FILE (/etc/oci/config) has no [app] profile",
    );
    await expect(createOciCredentialChain({ env, readFile: files({}) }).get()).rejects.toThrow(
      "OCI_CONFIG_FILE (/etc/oci/config) could not be read: ENOENT",
    );
  });

  it("says which half is wrong when the key file is not the fingerprint's key", async () => {
    const other = rsa().privateKey;
    await expect(
      createOciCredentialChain({
        env,
        readFile: files({ "/etc/oci/config": config(), "/etc/oci/keys/app.pem": pem(other) }),
      }).get(),
    ).rejects.toThrow(
      `key_file ${resolve("/etc/oci/keys/app.pem")} is the API key ${ociKeyFingerprint(other)}, but the [DEFAULT] profile names ${fp}: they must be the same key`,
    );
  });

  it("reads an encrypted key with its pass_phrase, and says so without one", async () => {
    const enc = privateKey
      .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "r437-pass" })
      .toString();
    const get = (extra: string) =>
      createOciCredentialChain({
        env,
        readFile: files({ "/etc/oci/config": config(extra), "/etc/oci/keys/app.pem": enc }),
      }).get();
    await expect(get("pass_phrase=r437-pass\n")).resolves.toMatchObject({ source: "api_key" });
    await expect(get("")).rejects.toThrow(
      `key_file ${resolve("/etc/oci/keys/app.pem")} is encrypted: give its pass phrase`,
    );
    await expect(get("pass_phrase=wrong\n")).rejects.toThrow(
      "could not be decrypted with the pass phrase given",
    );
  });

  it("refuses a key that is not RSA, and OCIDs that are not a user's and a tenancy's", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    await expect(
      createOciCredentialChain({
        env,
        readFile: files({ "/etc/oci/config": config(), "/etc/oci/keys/app.pem": pem(ec) }),
      }).get(),
    ).rejects.toThrow("is not an RSA key; OCI signs with RSA");
    await expect(
      createOciCredentialChain({
        env,
        readFile: files({ "/etc/oci/config": config().replace(USER, TEN) }),
      }).get(),
    ).rejects.toThrow("user must be a user OCID and its tenancy a tenancy OCID");
  });

  it("reads the files again after a while, so a replaced key is used", async () => {
    let now = 1_000_000;
    const second = rsa().privateKey;
    const map: Record<string, string> = {
      "/etc/oci/config": config(),
      "/etc/oci/keys/app.pem": pem(privateKey),
    };
    const chain = createOciCredentialChain({ env, readFile: files(map), now: () => now });
    const first = await chain.get();
    map["/etc/oci/config"] = config().replace(fp, ociKeyFingerprint(second));
    map["/etc/oci/keys/app.pem"] = pem(second);
    now += 14 * 60 * 1000;
    expect(await chain.get()).toBe(first);
    now += 2 * 60 * 1000;
    expect((await chain.get()).key.keyId).toBe(`${TEN}/${USER}/${ociKeyFingerprint(second)}`);
  });
});

describe("a resource principal (version 2.2)", () => {
  const { privateKey } = rsa();
  const exp = 2_000_000;
  const token = jwt({ exp, res_type: "fnfunc", res_id: "ocid1.fnfunc.oc1.iad.r437" });

  it("signs as ST$<token> with its key, each the value or a file", async () => {
    for (const e of [
      { OCI_RESOURCE_PRINCIPAL_RPST: token, OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: pem(privateKey) },
      {
        OCI_RESOURCE_PRINCIPAL_RPST: "/rp/rpst",
        OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: "/rp/key.pem",
      },
    ]) {
      const c = await createOciCredentialChain({
        env: { OCI_RESOURCE_PRINCIPAL_VERSION: "2.2", ...e },
        readFile: files({ "/rp/rpst": `${token}\n`, "/rp/key.pem": pem(privateKey) }),
      }).get();
      expect(c.key.keyId).toBe(`ST$${token}`);
      expect(c.identity).toBe("resource principal fnfunc ocid1.fnfunc.oc1.iad.r437");
      expect(c.expiresAt).toBe(exp * 1000);
    }
  });

  it("takes a new token from its file five minutes before the old one expires", async () => {
    let now = exp * 1000 - 10 * 60 * 1000;
    const map = { "/rp/rpst": token, "/rp/key.pem": pem(privateKey) };
    const chain = createOciCredentialChain({
      env: {
        OCI_RESOURCE_PRINCIPAL_VERSION: "2.2",
        OCI_RESOURCE_PRINCIPAL_RPST: "/rp/rpst",
        OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM: "/rp/key.pem",
      },
      readFile: files(map),
      now: () => now,
    });
    expect((await chain.get()).key.keyId).toBe(`ST$${token}`);
    const next = jwt({ exp: exp + 3600 });
    map["/rp/rpst"] = next;
    now += 4 * 60 * 1000;
    expect((await chain.get()).key.keyId).toBe(`ST$${token}`);
    now += 2 * 60 * 1000;
    expect((await chain.get()).key.keyId).toBe(`ST$${next}`);
  });

  it("refuses another version, and names what is missing", async () => {
    await expect(
      createOciCredentialChain({ env: { OCI_RESOURCE_PRINCIPAL_VERSION: "1.1" } }).get(),
    ).rejects.toThrow(
      "OCI_RESOURCE_PRINCIPAL_VERSION=1.1 is not supported: this release reads version 2.2",
    );
    await expect(
      createOciCredentialChain({ env: { OCI_RESOURCE_PRINCIPAL_VERSION: "2.2" } }).get(),
    ).rejects.toThrow(
      "A resource principal needs OCI_RESOURCE_PRINCIPAL_RPST and OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM",
    );
  });
});

describe("an instance principal", () => {
  const session = rsa();
  const token = jwt({ exp: 3_000_000, sub: INSTANCE });
  type Call = { url: string; init: RequestInit };
  let metadata: Call[];
  let federation: Call[];
  let instanceDoc: Record<string, unknown>;
  let answer: { status: number; body: Record<string, unknown> };

  const metadataFetch: NonNullable<OciCredentialDeps["metadataFetch"]> = async (url, init) => {
    metadata.push({ url, init });
    const path = new URL(url).pathname.replace(/^\/opc\/v2/, "");
    const body =
      path === "/instance/"
        ? JSON.stringify(instanceDoc)
        : path === "/identity/cert.pem"
          ? LEAF_CERT
          : path === "/identity/key.pem"
            ? LEAF_KEY
            : path === "/identity/intermediate.pem"
              ? INTERMEDIATE_CERT
              : null;
    return new Response(body ?? "not found", { status: body === null ? 404 : 200 });
  };
  const tokenFetch: NonNullable<OciCredentialDeps["tokenFetch"]> = async (url, init) => {
    federation.push({ url, init });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const chain = (env: Record<string, string> = {}) =>
    createOciCredentialChain({
      env,
      metadataFetch,
      tokenFetch,
      sessionKey: () => session,
      now: () => 1_000_000,
    });

  beforeEach(() => {
    metadata = [];
    federation = [];
    instanceDoc = {
      canonicalRegionName: "us-ashburn-1",
      regionInfo: {
        realmDomainComponent: "oraclecloud.com",
        realmKey: "oc1",
        regionIdentifier: "us-ashburn-1",
        regionKey: "IAD",
      },
    };
    answer = { status: 200, body: { token } };
  });

  it("asks the metadata service directly, as Oracle, for the region, the certificate and its keys", async () => {
    await chain().get();
    expect(metadata.map((c) => c.url)).toEqual([
      "http://169.254.169.254/opc/v2/instance/",
      "http://169.254.169.254/opc/v2/identity/cert.pem",
      "http://169.254.169.254/opc/v2/identity/key.pem",
      "http://169.254.169.254/opc/v2/identity/intermediate.pem",
    ]);
    for (const c of metadata) {
      expect(c.init.headers).toEqual({ authorization: "Bearer Oracle" });
    }
    expect(federation.map((c) => c.url)).toEqual([
      "https://auth.us-ashburn-1.oraclecloud.com/v1/x509",
    ]);
  });

  it("exchanges the certificate for a token bound to a key made here, signed by the instance's key", async () => {
    const c = await chain().get();
    const call = federation[0];
    const body = JSON.parse(String(call.init.body));
    const bare = (p: string) => p.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
    expect(body).toEqual({
      certificate: bare(LEAF_CERT),
      publicKey: bare(session.publicKey.export({ type: "spki", format: "pem" }).toString()),
      intermediateCertificates: [bare(INTERMEDIATE_CERT)],
      fingerprintAlgorithm: "SHA256",
    });
    const headers = call.init.headers as Record<string, string>;
    const sha = createHash("sha256")
      .update(new X509Certificate(LEAF_CERT).raw)
      .digest("hex")
      .match(/../g)!
      .join(":");
    expect(headers.authorization).toContain(`keyId="${TENANCY}/fed-x509-sha256/${sha}"`);
    expect(headers.authorization).toContain(
      'headers="date (request-target) host content-length content-type x-content-sha256"',
    );
    expect(
      verify(
        headers.authorization,
        headers,
        "POST",
        call.url,
        new X509Certificate(LEAF_CERT).publicKey,
        String(call.init.body),
      ),
    ).toBe(true);
    // The token, and the session key it was issued for.
    expect(c.key.keyId).toBe(`ST$${token}`);
    expect(ociKeyFingerprint(c.key.privateKey)).toBe(ociKeyFingerprint(session.publicKey));
    expect(c.identity).toBe(`instance principal ${INSTANCE}`);
    expect(c.expiresAt).toBe(3_000_000_000);
  });

  it("OCI_FEDERATION_ENDPOINT and OCI_METADATA_BASE_URL move them; anything else is refused", async () => {
    await chain({
      OCI_FEDERATION_ENDPOINT: "https://auth.example.test",
      OCI_METADATA_BASE_URL: "http://imds.example.test/opc/v2/",
    }).get();
    expect(metadata[0].url).toBe("http://imds.example.test/opc/v2/identity/cert.pem");
    expect(federation[0].url).toBe("https://auth.example.test/v1/x509");
    await expect(
      chain({ OCI_FEDERATION_ENDPOINT: "https://auth.example.test/v1" }).get(),
    ).rejects.toThrow("OCI_FEDERATION_ENDPOINT must be an origin only");
    await expect(
      chain({ OCI_METADATA_BASE_URL: "https://user:pw@imds/opc/v2" }).get(),
    ).rejects.toThrow("OCI_METADATA_BASE_URL must be an http URL");
  });

  it("finds the identity service in the instance's own realm, not only the commercial one", async () => {
    instanceDoc = {
      regionInfo: {
        realmDomainComponent: "oraclegovcloud.com",
        realmKey: "oc2",
        regionIdentifier: "us-langley-1",
        regionKey: "LFI",
      },
    };
    await chain().get();
    expect(federation[0].url).toBe("https://auth.us-langley-1.oraclegovcloud.com/v1/x509");
  });

  it("without a region and realm from the metadata, says which variable to set", async () => {
    instanceDoc = { canonicalRegionName: "us-ashburn-1" };
    await expect(chain().get()).rejects.toThrow(
      /no usable region and realm \(regionInfo\); set OCI_FEDERATION_ENDPOINT/,
    );
    expect(federation).toEqual([]);
  });

  it("a certificate that names no tenancy is not an instance's", async () => {
    const swapped = metadataFetch;
    const fetchIntermediateAsLeaf: typeof metadataFetch = async (url, init) =>
      url.endsWith("/identity/cert.pem")
        ? new Response(INTERMEDIATE_CERT, { status: 200 })
        : swapped(url, init);
    await expect(
      createOciCredentialChain({
        env: {},
        metadataFetch: fetchIntermediateAsLeaf,
        tokenFetch,
        sessionKey: () => session,
      }).get(),
    ).rejects.toThrow("The instance's certificate names no tenancy (opc-tenant:…)");
  });

  it("the identity service's refusal is the error, in its words", async () => {
    answer = {
      status: 401,
      body: { code: "NotAuthenticated", message: "certificate not trusted" },
    };
    await expect(chain().get()).rejects.toThrow(
      "The identity service refused the instance's certificate (401 NotAuthenticated): certificate not trusted",
    );
  });

  it("off OCI, says how to give the app an identity, and never falls through to a config file", async () => {
    const down: typeof metadataFetch = async () => {
      throw new Error("connect ETIMEDOUT 169.254.169.254:80");
    };
    await expect(
      createOciCredentialChain({
        env: { OCI_AUTH: "instance_principal", OCI_CONFIG_FILE: "/etc/oci/config" },
        metadataFetch: down,
        tokenFetch,
        readFile: () => {
          throw new Error("must not read the config file");
        },
      }).get(),
    ).rejects.toThrow(
      /the instance metadata service \(169\.254\.169\.254\) did not answer \(connect ETIMEDOUT 169\.254\.169\.254:80\)\. Run on an OCI instance in a dynamic group/,
    );
  });

  it("concurrent callers share one exchange", async () => {
    const c = chain();
    await Promise.all([c.get(), c.get(), c.get()]);
    expect(federation).toHaveLength(1);
  });
});
