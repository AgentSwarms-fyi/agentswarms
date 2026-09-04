// Azure Blob / ADLS Gen2 as a catalog source and a lake mount.
//
// Every other object store the platform reads speaks S3, so one SigV4 client
// covered six providers. Azure does not, and every Azure enterprise keeps its
// lake there. This is the second client, and because there is no Azure account
// to run it against here, the tests pin the parts that fail silently in
// production: the SharedKey canonicalisation (one header out of order is a
// 403 with no hint), the credential-form detection, the connection string the
// DuckDB extension is handed, and every place the rest of the platform used
// to assume "object store" meant "s3://".
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AZURE_API_VERSION,
  azureConnectionString,
  azureOrigin,
  azureSharedKeySignature,
  azureStringToSign,
  isSasToken,
  parseBlobList,
} from "@/utils/catalog/azureBlob.server";

const OBJECT_STORE = readFileSync("src/utils/catalog/objectStore.server.ts", "utf8");
const OBJECT_READ = readFileSync("src/utils/catalog/objectStoreRead.server.ts", "utf8");
const CORE = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
const MOUNT = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
const WIZARD = readFileSync("src/components/catalog/AddSourceWizard.tsx", "utf8");
const FNS = readFileSync("src/utils/catalog.functions.ts", "utf8");

const KEY = Buffer.from("secret-account-key-for-tests").toString("base64");
const cfg = (secret: string, endpoint?: string) =>
  ({
    provider: "azure" as const,
    region: "",
    bucket: "lake",
    prefix: "raw/",
    access_key_id: "acct",
    secret_access_key: secret,
    ...(endpoint ? { endpoint } : {}),
  }) as never;

describe("credential form is detected, not configured", () => {
  it("tells a SAS token from an account key", () => {
    expect(isSasToken("sv=2021-08-06&ss=b&sig=abc%3D")).toBe(true);
    expect(isSasToken("?sv=2021&sig=x")).toBe(true);
    expect(isSasToken(KEY)).toBe(false);
  });

  it("hands DuckDB the connection string form each credential needs", () => {
    expect(azureConnectionString(cfg(KEY))).toBe(
      `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${KEY};EndpointSuffix=core.windows.net`,
    );
    expect(azureConnectionString(cfg("?sv=1&sig=zz"))).toBe(
      "BlobEndpoint=https://acct.blob.core.windows.net;SharedAccessSignature=sv=1&sig=zz",
    );
    // An override endpoint (Azurite, a sovereign cloud) is honoured for both.
    expect(azureConnectionString(cfg(KEY, "http://127.0.0.1:10000"))).toContain(
      "BlobEndpoint=http://127.0.0.1:10000",
    );
  });

  it("derives the public endpoint from the account name", () => {
    expect(azureOrigin({ access_key_id: "acct" })).toBe("https://acct.blob.core.windows.net");
    expect(
      azureOrigin({ access_key_id: "acct", endpoint: "https://acct.blob.core.usgovcloudapi.net/" }),
    ).toBe("https://acct.blob.core.usgovcloudapi.net");
    expect(() => azureOrigin({ access_key_id: "a", endpoint: "ftp://x" })).toThrow(/http\(s\)/);
  });
});

describe("SharedKey canonicalisation", () => {
  const base = {
    method: "get",
    account: "acct",
    resourcePath: "/lake",
    query: { comp: "list", restype: "container", MaxResults: "1" },
    headers: {
      "X-MS-Version": AZURE_API_VERSION,
      "x-ms-date": "Thu, 04 Sep 2026 10:00:00 GMT",
      Accept: "*/*",
    },
  };

  it("builds the documented string: verb, twelve headers, x-ms block, resource", () => {
    const s = azureStringToSign(base);
    const lines = s.split("\n");
    expect(lines[0]).toBe("GET");
    // The Blob service signs ELEVEN standard headers, Range last (index 11).
    // All empty for a GET without a range. (A first draft of this test counted
    // twelve; the implementation was right and the test was wrong.)
    expect(lines.slice(1, 12)).toEqual(["", "", "", "", "", "", "", "", "", "", ""]);
    // x-ms headers lowercased, sorted, one per line; non x-ms headers absent.
    expect(lines[12]).toBe("x-ms-date:Thu, 04 Sep 2026 10:00:00 GMT");
    expect(lines[13]).toBe(`x-ms-version:${AZURE_API_VERSION}`);
    expect(s).not.toContain("accept");
    // Resource: /account/container then query params lowercased and sorted.
    expect(lines.slice(14)).toEqual([
      "/acct/lake",
      "comp:list",
      "maxresults:1",
      "restype:container",
    ]);
  });

  it("signs the Range header into its fixed slot", () => {
    const s = azureStringToSign({
      ...base,
      resourcePath: "/lake/raw/a.parquet",
      query: {},
      range: "bytes=0-9",
    });
    expect(s.split("\n")[11]).toBe("bytes=0-9");
    expect(s.endsWith("/acct/lake/raw/a.parquet")).toBe(true);
  });

  it("is deterministic and key-dependent", () => {
    const s = azureStringToSign(base);
    expect(azureSharedKeySignature(s, KEY)).toBe(azureSharedKeySignature(s, KEY));
    expect(azureSharedKeySignature(s, KEY)).not.toBe(
      azureSharedKeySignature(s, Buffer.from("other").toString("base64")),
    );
    expect(azureSharedKeySignature(s, KEY)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("List Blobs parsing", () => {
  it("reads blobs, sizes and dates, skips directory markers, and pages", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <EnumerationResults ServiceEndpoint="https://acct.blob.core.windows.net/" ContainerName="lake">
        <Blobs>
          <Blob><Name>raw/</Name><Properties><Content-Length>0</Content-Length></Properties></Blob>
          <Blob><Name>raw/a.parquet</Name><Properties><Last-Modified>Thu, 04 Sep 2026 10:00:00 GMT</Last-Modified><Content-Length>1234</Content-Length></Properties></Blob>
          <Blob><Name>raw/b &amp; c.csv</Name><Properties><Content-Length>5</Content-Length></Properties></Blob>
        </Blobs>
        <NextMarker>2!abc</NextMarker>
      </EnumerationResults>`;
    const { blobs, nextMarker } = parseBlobList(xml);
    expect(blobs).toEqual([
      { key: "raw/a.parquet", size: 1234, last_modified: "Thu, 04 Sep 2026 10:00:00 GMT" },
      { key: "raw/b & c.csv", size: 5, last_modified: "" },
    ]);
    expect(nextMarker).toBe("2!abc");
    expect(
      parseBlobList("<EnumerationResults><NextMarker/></EnumerationResults>").nextMarker,
    ).toBeNull();
  });
});

describe("nothing downstream still assumes s3://", () => {
  it("the crawler client dispatches to Azure for all three operations", () => {
    expect(OBJECT_STORE).toMatch(/provider: [^;]*"azure"/);
    for (const op of ["azureListObjects", "azureTestObjectStore", "azureSampleObject"]) {
      expect(OBJECT_STORE, op).toContain(`${op}(`);
    }
  });

  it("DuckDB reads use the azure extension and az:// for an Azure source", () => {
    expect(OBJECT_READ).toContain("TYPE azure");
    expect(OBJECT_READ).toMatch(/az:\/\//);
    expect(CORE).toContain("INSTALL azure");
    expect(CORE).toContain("LOAD azure");
    expect(CORE).toContain("TYPE azure");
    // Mount globs and secret scopes pick the scheme from the provider rather
    // than hard-coding s3://.
    expect(MOUNT).toContain('cfg.provider === "azure" ? "az" : "s3"');
    expect(MOUNT).not.toMatch(/`s3:\/\/\$\{cfg\.bucket\}/);
    expect(CORE).toMatch(/az:\/\//);
  });

  it("the wizard and the API accept the provider", () => {
    expect(WIZARD).toMatch(/azure: \{/);
    expect(FNS).toMatch(/z\.enum\(\[[^\]]*"azure"/);
  });
});
