// R387 (VA-2026-10-25-14, data side). The object-store, Iceberg, connector and
// GitLab paths checked only the hostname AS TYPED: a public-looking name that
// resolves to the cloud metadata address passed, plain fetch followed any
// redirect, and the lakehouse's Iceberg catalogs — whose URLs DuckDB calls
// itself — were not checked at all. Bucket, region and storage-account names
// went into hostnames unvalidated, so `x.attacker.test#` could re-aim a signed
// request.
//
// Each path below now resolves the name (and, where we make the request,
// re-checks every redirect hop) under the policy it already had: object-store
// reads keep honouring BLOCK_PRIVATE_NETWORK_FETCH, while Iceberg, warehouse
// connectors and GitLab keep allowing private addresses, because a self-hosted
// catalog, warehouse or GitLab on the deployment's network is normal.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host.endsWith("metadata.attacker.test")) return [{ address: "169.254.169.254", family: 4 }];
    if (host === "catalog.internal.test") return [{ address: "10.0.0.7", family: 4 }];
    return [{ address: "93.184.216.34", family: 4 }];
  },
}));
// iceberg.server imports the admin client at module load; nothing here uses it.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { azureOrigin } from "@/utils/catalog/azureBlob.server";
import { assertStorageNames, listObjects } from "@/utils/catalog/objectStore.server";
import { assertEndpointAllowed } from "@/utils/catalog/objectStoreRead.server";
import { connectorFetch } from "@/utils/http/connectorFetch.server";
import { assertIcebergUrlsAllowed } from "@/utils/lakehouse/iceberg.server";

let calls: string[] = [];
let respond: (url: string) => Response = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

const S3 = {
  provider: "minio" as const,
  region: "us-east-1",
  bucket: "lake",
  access_key_id: "AKIDEXAMPLE",
  secret_access_key: "secret-example",
};

describe("object store: the endpoint DuckDB is handed is resolved first", () => {
  it("refuses a public-looking name that resolves to the metadata address", async () => {
    await expect(assertEndpointAllowed("http://metadata.attacker.test:9000")).rejects.toThrow(
      /link-local|metadata/i,
    );
  });

  it("still allows a private MinIO by default", async () => {
    await expect(
      assertEndpointAllowed("http://catalog.internal.test:9000"),
    ).resolves.toBeUndefined();
  });
});

describe("object store: the signed listing request", () => {
  it("is refused before it is sent when the endpoint resolves to metadata", async () => {
    await expect(
      listObjects({ ...S3, endpoint: "http://metadata.attacker.test:9000" }),
    ).rejects.toThrow(/link-local|metadata/i);
    expect(calls).toEqual([]);
  });

  it("does not follow a redirect into the metadata address", async () => {
    respond = (url) =>
      url.includes("minio.example")
        ? new Response(null, { status: 307, headers: { location: "http://169.254.169.254/" } })
        : new Response("<ListBucketResult/>", { status: 200 });
    await expect(listObjects({ ...S3, endpoint: "https://minio.example" })).rejects.toThrow(
      /link-local|metadata/i,
    );
    expect(calls.every((u) => u.includes("minio.example"))).toBe(true);
  });

  it("refuses a region that would re-aim the AWS host, before any request", async () => {
    await expect(
      listObjects({ ...S3, provider: "aws", region: "metadata.attacker.test#" }),
    ).rejects.toThrow(/not a region name/);
    expect(calls).toEqual([]);
  });
});

describe("names that become hostnames", () => {
  it("accepts real bucket, region and account names", () => {
    expect(() =>
      assertStorageNames({
        ...S3,
        provider: "aws",
        region: "eu-west-3",
        bucket: "my.bucket_name-1",
      }),
    ).not.toThrow();
    expect(() =>
      assertStorageNames({ ...S3, provider: "azure", access_key_id: "devstoreaccount1" }),
    ).not.toThrow();
    // With an endpoint the host comes from its URL; the region is only signed.
    expect(() =>
      assertStorageNames({ ...S3, endpoint: "http://minio:9000", region: "my-region" }),
    ).not.toThrow();
  });

  it("refuses names carrying URL syntax", () => {
    for (const bad of [
      { bucket: "lake#x" },
      { bucket: "metadata.attacker.test/" },
      { bucket: "x@169.254.169.254" },
      { provider: "aws" as const, region: "metadata.attacker.test#" },
      { provider: "azure" as const, access_key_id: "metadata.attacker.test#" },
    ]) {
      expect(() => assertStorageNames({ ...S3, ...bad }), JSON.stringify(bad)).toThrow(
        /not a valid|not a region name/,
      );
    }
  });

  it("azureOrigin refuses an account that would re-aim the host", () => {
    expect(() => azureOrigin({ access_key_id: "metadata.attacker.test#" })).toThrow(
      /not a valid storage account/,
    );
    expect(azureOrigin({ access_key_id: "devstoreaccount1" })).toBe(
      "https://devstoreaccount1.blob.core.windows.net",
    );
  });
});

describe("Iceberg catalogs the lakehouse attaches", () => {
  const ICE = {
    name: "c",
    endpoint: "http://catalog.internal.test:8181",
    warehouse: "w",
    auth_type: "none",
    token_secret: "",
    client_id_secret: "",
    client_secret_secret: "",
    oauth2_server_uri: "",
  } as unknown as Parameters<typeof assertIcebergUrlsAllowed>[0];

  it("allows a self-hosted catalog on a private address", async () => {
    vi.stubEnv("BLOCK_PRIVATE_NETWORK_FETCH", "true");
    await expect(assertIcebergUrlsAllowed(ICE)).resolves.toBeUndefined();
  });

  it("refuses an endpoint whose name resolves to metadata", async () => {
    await expect(
      assertIcebergUrlsAllowed({ ...ICE, endpoint: "http://metadata.attacker.test/api/catalog" }),
    ).rejects.toThrow(/endpoint.*(link-local|metadata)/i);
  });

  it("refuses an OAuth2 token URL at the metadata address", async () => {
    await expect(
      assertIcebergUrlsAllowed({ ...ICE, oauth2_server_uri: "http://169.254.169.254/token" }),
    ).rejects.toThrow(/OAuth2 server URI/);
  });

  it("is checked on every attach, not only on save", () => {
    const src = readFileSync("src/utils/lakehouse/iceberg.server.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function attachIcebergCatalog("));
    expect(fn.indexOf("await assertIcebergUrlsAllowed(cfg);")).toBeGreaterThan(-1);
    expect(fn.indexOf("await assertIcebergUrlsAllowed(cfg);")).toBeLessThan(fn.indexOf("c.run("));
  });
});

describe("warehouse and SaaS connectors (connectorFetch)", () => {
  it("refuses a name that resolves to metadata, without sending", async () => {
    await expect(
      connectorFetch("https://acct.metadata.attacker.test/api", {}, { retries: 0 }),
    ).rejects.toThrow(/link-local|metadata/i);
    expect(calls).toEqual([]);
  });

  it("refuses a redirect into metadata, and does not retry the refusal", async () => {
    respond = () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    await expect(
      connectorFetch("https://warehouse.example/api", {}, { retries: 2, sleepFn: async () => {} }),
    ).rejects.toThrow(/link-local|metadata/i);
    expect(calls).toEqual(["https://warehouse.example/api"]);
  });

  it("still reaches a self-hosted warehouse on a private address", async () => {
    vi.stubEnv("BLOCK_PRIVATE_NETWORK_FETCH", "true");
    const res = await connectorFetch("http://catalog.internal.test:8123/", {}, { retries: 0 });
    expect(res.status).toBe(200);
  });
});

describe("no data-side call site fetches a user's URL raw", () => {
  it("object store and Azure reads go through the guard", () => {
    for (const f of [
      "src/utils/catalog/objectStore.server.ts",
      "src/utils/catalog/azureBlob.server.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toMatch(/return safeFetch\(/);
      expect(src, `${f} still has a raw fetch`).not.toMatch(/(?<![A-Za-z])fetch\(/);
    }
  });

  it("the catalog crawler's Iceberg reads go through the guard", () => {
    const src = readFileSync("src/utils/catalog/crawler.server.ts").toString("latin1");
    expect(src).toMatch(/res = await safeFetch\(`\$\{base\}\$\{path\}`/);
  });

  it("every GitLab call goes through gitlabFetch", () => {
    const src = readFileSync("src/utils/git/exporter.server.ts", "utf8");
    expect(src).not.toMatch(/await fetch\(\s*`\$\{base\}\/api\/v4/);
    expect((src.match(/await gitlabFetch\(/g) ?? []).length).toBe(3);
  });

  it("the DuckDB readers await the endpoint check and validate names", () => {
    const read = readFileSync("src/utils/catalog/objectStoreRead.server.ts", "utf8");
    expect(read).toMatch(
      /await assertEndpointAllowed\(cfg\.endpoint\);\s*assertStorageNames\(cfg\);/,
    );
    const orc = readFileSync("src/utils/catalog/orcIsolated.server.ts", "utf8");
    expect(orc).toMatch(/await assertEndpointAllowed\(cfg\.endpoint\);/);
  });
});
