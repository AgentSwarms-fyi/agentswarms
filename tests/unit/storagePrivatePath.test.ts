// Object storage over private paths (private connectivity, Phase 3, R422).
//
// A bucket may be reached over the internet, a cloud private endpoint (an S3
// interface endpoint, GCS Private Service Connect, Azure Private Link) or a VPN.
// Public stays the default. What this pins:
//
//   - which names are the clouds' own storage names, the only ones that may
//     resolve privately under BLOCK_PRIVATE_NETWORK_FETCH (the VA-14
//     residual): not the whole cloud domain, since an EC2 instance's public
//     DNS name resolves to its private address inside a VPC;
//   - the per-source "require a private network path" rule, checked before any
//     request, with the proxy not counting (object-store calls go direct);
//   - the exemption decided per redirect hop, so a cloud name cannot hand the
//     request on to an internal host;
//   - that every reader of a store checks the rule.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: Record<string, string[]> = {};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const a = answers[host];
    if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

const { isCloudStorageHost, PRIVATE_PATH_HINT } = await import("@/utils/catalog/storageNetwork");
const { assertStoragePath } = await import("@/utils/catalog/objectStore.server");
const { safeFetch } = await import("@/utils/ssrfGuard.server");
const { assertEndpointAllowed } = await import("@/utils/catalog/objectStoreRead.server");

const realFetch = globalThis.fetch;
beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BLOCK_PRIVATE_NETWORK_FETCH;
  delete process.env.HTTPS_PROXY;
});

describe("the clouds' own storage names", () => {
  it("covers S3, its interface endpoints, GCS and its PSC names, and Azure accounts", () => {
    for (const h of [
      "s3.amazonaws.com",
      "s3.us-east-1.amazonaws.com",
      "lake.s3.eu-west-1.amazonaws.com",
      "s3-us-west-2.amazonaws.com",
      "s3.dualstack.us-east-1.amazonaws.com",
      "s3-fips.us-east-1.amazonaws.com",
      "vpce-0abc123-d4e5f6.s3.us-east-1.vpce.amazonaws.com",
      "lake.vpce-0abc123-d4e5f6.s3.us-east-1.vpce.amazonaws.com",
      "storage.googleapis.com",
      "lake.storage.googleapis.com",
      "storage-myendpoint.p.googleapis.com",
      "acct123.blob.core.windows.net",
      "acct123.privatelink.blob.core.windows.net",
      "acct123.dfs.core.windows.net",
      "https://s3.us-east-1.amazonaws.com/lake/key",
    ]) {
      expect(isCloudStorageHost(h), h).toBe(true);
    }
  });

  it("not the rest of the cloud: an EC2 name, metadata, other services, look-alikes", () => {
    for (const h of [
      "ec2-10-0-0-5.compute-1.amazonaws.com", // inside a VPC: a private address
      "ip-10-0-0-5.ec2.internal",
      "sts.amazonaws.com",
      "s3-control.us-east-1.amazonaws.com",
      "aiplatform.googleapis.com",
      "metadata.google.internal",
      "management.azure.com",
      "acct123.vault.azure.net",
      // A database over Private Link is an internal service, not storage.
      "myserver.database.windows.net",
      "login.windows.net",
      "s3.us-east-1.amazonaws.com.evil.test",
      "minio.corp.internal",
      "10.0.0.5",
    ]) {
      expect(isCloudStorageHost(h), h).toBe(false);
    }
  });

  it("each provider says how it is reached privately", () => {
    expect(PRIVATE_PATH_HINT.aws).toMatch(/vpce-[a-z0-9-]+\.s3\.us-east-1\.vpce\.amazonaws\.com/);
    expect(PRIVATE_PATH_HINT.gcs).toMatch(/storage-myendpoint\.p\.googleapis\.com/);
    expect(PRIVATE_PATH_HINT.azure).toMatch(/blob\.core\.windows\.net/);
  });
});

const minio = (over: Record<string, unknown> = {}) => ({
  provider: "minio" as const,
  endpoint: "http://store.corp.test:9000",
  region: "us-east-1",
  bucket: "lake",
  access_key_id: "k",
  secret_access_key: "s",
  ...over,
});

describe("require a private network path", () => {
  it("is off by default: nothing is even looked up", async () => {
    await expect(assertStoragePath(minio())).resolves.toBeUndefined();
  });

  it("passes a store that resolves only to private addresses", async () => {
    answers["store.corp.test"] = ["10.0.4.7"];
    await expect(assertStoragePath(minio({ require_private: true }))).resolves.toBeUndefined();
  });

  it("refuses one reached at a public address, or not resolved at all, and says why", async () => {
    const seen: string[] = [];
    answers["store.corp.test"] = ["10.0.4.7", "52.95.110.1"];
    await expect(
      assertStoragePath(minio({ require_private: true }), (d) => seen.push(d)),
    ).rejects.toThrow(/private network path/);
    expect(seen[0]).toMatch(/52\.95\.110\.1/);
    // Its advice is the store's: object-store calls never use the proxy, so
    // the model providers' "send it through the proxy" would mislead.
    expect(seen[0]).toMatch(/Endpoint URL/);
    expect(seen[0]).not.toMatch(/proxy/);
    await expect(
      assertStoragePath(minio({ require_private: true, endpoint: "http://nowhere.test" })),
    ).rejects.toThrow(/private network path|does not resolve/);
  });

  it("checks the host the requests go to: AWS's own name, a virtual-hosted bucket", async () => {
    answers["lake.s3.us-east-1.amazonaws.com"] = ["10.1.2.3"];
    await expect(
      assertStoragePath({
        ...minio({ provider: "aws", endpoint: undefined }),
        require_private: true,
      }),
    ).resolves.toBeUndefined();
    answers["lake.s3.us-east-1.amazonaws.com"] = ["52.216.1.1"];
    await expect(
      assertStoragePath({
        ...minio({ provider: "aws", endpoint: undefined }),
        require_private: true,
      }),
    ).rejects.toThrow(/52\.216\.1\.1/);
  });

  it("the proxy is no way round it: object-store requests do not use it", async () => {
    process.env.HTTPS_PROXY = "http://proxy.corp.test:3128";
    answers["store.corp.test"] = ["52.95.110.1"];
    await expect(
      assertStoragePath(minio({ require_private: true, endpoint: "https://store.corp.test" })),
    ).rejects.toThrow(/private network path/);
  });
});

describe("BLOCK_PRIVATE_NETWORK_FETCH and a cloud name resolving privately (the VA-14 residual)", () => {
  const ok = () => new Response("ok", { status: 200 });

  it("allows the cloud's own storage name, refuses any other private host", async () => {
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    answers["lake.s3.us-east-1.amazonaws.com"] = ["10.1.2.3"];
    answers["minio.corp.test"] = ["10.1.2.4"];
    globalThis.fetch = vi.fn(async () => ok()) as unknown as typeof fetch;
    const allow = { allowPrivateHost: isCloudStorageHost };
    await expect(
      safeFetch("https://lake.s3.us-east-1.amazonaws.com/k", allow),
    ).resolves.toBeInstanceOf(Response);
    await expect(safeFetch("https://minio.corp.test/k", allow)).rejects.toThrow();
  });

  it("decides it per hop: a redirect from the cloud name to an internal host is refused", async () => {
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    answers["lake.s3.us-east-1.amazonaws.com"] = ["10.1.2.3"];
    answers["admin.corp.test"] = ["10.9.9.9"];
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (u: URL | string) => {
      calls.push(String(u));
      return new Response(null, { status: 302, headers: { location: "https://admin.corp.test/" } });
    }) as unknown as typeof fetch;
    await expect(
      safeFetch("https://lake.s3.us-east-1.amazonaws.com/k", {
        allowPrivateHost: isCloudStorageHost,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("DuckDB's own reads follow the same rule", async () => {
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    answers["storage-myendpoint.p.googleapis.com"] = ["10.1.2.3"];
    answers["minio.corp.test"] = ["10.1.2.4"];
    await expect(
      assertEndpointAllowed("https://storage-myendpoint.p.googleapis.com"),
    ).resolves.toBeUndefined();
    await expect(assertEndpointAllowed("https://minio.corp.test")).rejects.toThrow();
  });
});

// ── Every reader checks the rule ─────────────────────────────────────────────
const rd = (p: string) => readFileSync(p, "utf8");

describe("every reader of a store checks it", () => {
  it("the signed S3 and Azure requests, before anything is sent", () => {
    const s3 = rd("src/utils/catalog/objectStore.server.ts");
    const get = s3.slice(s3.indexOf("async function s3Get"), s3.indexOf("function xmlUnescape"));
    expect(get.indexOf("await assertStoragePath(cfg);")).toBeGreaterThan(-1);
    expect(get.indexOf("await assertStoragePath(cfg);")).toBeLessThan(get.indexOf("safeFetch("));
    expect(get).toContain("allowPrivateHost: isCloudStorageHost");
    const az = rd("src/utils/catalog/azureBlob.server.ts");
    const azGet = az.slice(
      az.indexOf("async function azureGet"),
      az.indexOf("export async function azureListObjects"),
    );
    expect(azGet.indexOf("await assertStoragePath(cfg);")).toBeLessThan(
      azGet.indexOf("safeFetch("),
    );
    expect(azGet).toContain("allowPrivateHost: isCloudStorageHost");
  });

  it("DuckDB reads, ORC reads, lake mounts and an ETL run's start", () => {
    expect(rd("src/utils/catalog/objectStoreRead.server.ts")).toMatch(
      /await assertEndpointAllowed\(cfg\.endpoint\);\s*await assertStoragePath\(cfg\);/,
    );
    expect(rd("src/utils/catalog/orcIsolated.server.ts")).toMatch(
      /await assertEndpointAllowed\(cfg\.endpoint\);\s*await assertStoragePath\(cfg\);/,
    );
    expect(rd("src/utils/lakehouse/core.server.ts")).toMatch(
      /loadStorageConfig\(mount\.user_id, src\);[\s\S]{0,400}await assertStoragePath\(cfg\);/,
    );
    expect(rd("src/utils/lakehouse.functions.ts")).toMatch(
      /loadStorageConfig\(userId, src\);[\s\S]{0,200}await assertStoragePath\(cfg\);/,
    );
    expect(rd("src/utils/etl/service.server.ts")).toMatch(
      /loadStorageConfig\(pipeline\.user_id, src, \{ into: "sandbox" \}\);[\s\S]{0,400}await assertStoragePath\(cfg\);/,
    );
  });

  it("adding a source audits a refusal and returns the path it was reached by", () => {
    const fns = rd("src/utils/catalog.functions.ts");
    expect(fns).toContain('action: "storage.private_path.refused"');
    expect(fns).toMatch(
      /await assertStoragePath\(live,[\s\S]{0,400}await testObjectStore\(live\);\s*path = await storagePath\(live\);/,
    );
    expect(fns).toContain("require_private: z.boolean().optional()");
    const wizard = rd("src/components/catalog/AddSourceWizard.tsx");
    expect(wizard).toContain("require_private: requirePrivate || undefined");
    expect(wizard).toContain("Reached {reachedVia}.");
  });
});
