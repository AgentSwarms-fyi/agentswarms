// Sharing lakehouse tables outside the platform: the Delta Sharing wire
// shapes, the presigned URL (against AWS's published example), the fold of
// a share's rule into a table's policy, and the wiring that keeps a
// recipient from ever receiving the lakehouse's own files.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DeltaSharingError,
  fileAction,
  generateShareToken,
  hashShareToken,
  looksLikeShareToken,
  metaDataAction,
  ndjson,
  parseSharePath,
  readQueryBody,
  shareProfile,
  shareSlug,
  shareTokenPrefix,
  sparkSchemaString,
  sparkTypeOf,
} from "@/lib/deltaSharing";
import { presignS3Get, s3Location } from "@/utils/lakehouse/presign.server";
import { foldSharePolicy } from "@/utils/lakehouse/shares.server";

const rd = (p: string) => readFileSync(p, "utf8");

describe("the path grammar", () => {
  it("reads every shape the protocol defines", () => {
    expect(parseSharePath("/api/delta-sharing/shares")).toEqual({});
    expect(parseSharePath("/api/delta-sharing/shares/finance")).toEqual({ share: "finance" });
    expect(parseSharePath("/api/delta-sharing/shares/finance/schemas")).toEqual({
      share: "finance",
      op: "schemas",
    });
    expect(parseSharePath("/api/delta-sharing/shares/finance/all-tables")).toEqual({
      share: "finance",
      op: "all-tables",
    });
    expect(parseSharePath("/api/delta-sharing/shares/finance/schemas/analytics/tables")).toEqual({
      share: "finance",
      schema: "analytics",
      op: "tables",
    });
    expect(
      parseSharePath("/api/delta-sharing/shares/finance/schemas/analytics/tables/orders/query/"),
    ).toEqual({ share: "finance", schema: "analytics", table: "orders", op: "query" });
    expect(
      parseSharePath("/api/delta-sharing/shares/f%20x/schemas/a/tables/t/metadata"),
    ).toMatchObject({ share: "f x", op: "metadata" });
    expect(parseSharePath("/api/delta-sharing/nope")).toEqual({});
  });

  it("names a share the way URLs and the database want", () => {
    expect(shareSlug("  Finance Q3 / EMEA ")).toBe("finance-q3-emea");
    expect(shareSlug("x".repeat(80)).length).toBe(63);
  });
});

describe("schema translation and actions", () => {
  it("maps DuckDB types to the Spark names clients expect, decimals with precision", () => {
    expect(sparkTypeOf("BIGINT")).toBe("long");
    expect(sparkTypeOf("INTEGER")).toBe("integer");
    expect(sparkTypeOf("DOUBLE")).toBe("double");
    expect(sparkTypeOf("VARCHAR")).toBe("string");
    expect(sparkTypeOf("DECIMAL(18,2)")).toBe("decimal(18,2)");
    expect(sparkTypeOf("TIMESTAMP WITH TIME ZONE")).toBe("timestamp");
    expect(sparkTypeOf("STRUCT(a INTEGER)")).toBe("string");
    const s = JSON.parse(sparkSchemaString([{ name: "id", type: "INTEGER" }]));
    expect(s).toEqual({
      type: "struct",
      fields: [{ name: "id", type: "integer", nullable: true, metadata: {} }],
    });
  });

  it("writes NDJSON actions in the protocol's shapes", () => {
    const meta = metaDataAction({
      id: "t1",
      name: "orders",
      columns: [{ name: "id", type: "INTEGER" }],
      numFiles: 1,
      size: 10,
    });
    expect(meta.metaData.format).toEqual({ provider: "parquet" });
    expect(meta.metaData.partitionColumns).toEqual([]);
    const file = fileAction({
      url: "https://x/y",
      id: "f1",
      size: 10,
      numRecords: 3,
      expirationTimestamp: 5,
    });
    expect(JSON.parse(file.file.stats)).toEqual({ numRecords: 3 });
    const text = ndjson([{ protocol: { minReaderVersion: 1 } }, meta, file]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    expect(readQueryBody({ limitHint: 10.7, predicateHints: ["a > 1", 2], version: 3 })).toEqual({
      limitHint: 10,
      predicateHints: ["a > 1"],
      version: 3,
    });
    expect(readQueryBody(null)).toEqual({ limitHint: null, predicateHints: [], version: null });
  });

  it("tokens are prefixed, hashed and stubbed; the profile is what a client loads", async () => {
    const t = generateShareToken();
    expect(t.startsWith("dss_")).toBe(true);
    expect(looksLikeShareToken(t)).toBe(true);
    expect(looksLikeShareToken("scim_" + "a".repeat(32))).toBe(false);
    expect(await hashShareToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(shareTokenPrefix(t)).toBe(t.slice(0, 10));
    expect(shareProfile("https://x/api/delta-sharing", t, "2030-01-01T00:00:00Z")).toEqual({
      shareCredentialsVersion: 1,
      endpoint: "https://x/api/delta-sharing",
      bearerToken: t,
      expirationTime: "2030-01-01T00:00:00Z",
    });
    const e = new DeltaSharingError(404, "RESOURCE_DOES_NOT_EXIST", "no");
    expect(e.status).toBe(404);
  });
});

describe("presigned URLs", () => {
  it("matches AWS's published SigV4 query-string example byte for byte", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignS3Get({
      target: {
        region: "us-east-1",
        useSsl: true,
        urlStyle: "vhost",
        bucket: "examplebucket",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        endpoint: "s3.amazonaws.com",
      },
      key: "test.txt",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs MinIO path-style URLs for the public host, not the in-network one", () => {
    const target = {
      region: "us-east-1",
      useSsl: false,
      urlStyle: "path" as const,
      bucket: "lakehouse",
      accessKeyId: "k",
      secretAccessKey: "s",
      endpoint: "minio:9000",
      publicEndpoint: "data.example.com:9000",
    };
    expect(s3Location(target, "app")).toEqual({
      origin: "http://minio:9000",
      host: "minio:9000",
      basePath: "/lakehouse",
    });
    const url = presignS3Get({ target, key: "shares/a b/part-0.parquet", expiresSeconds: 60 });
    expect(
      url.startsWith("http://data.example.com:9000/lakehouse/shares/a%20b/part-0.parquet?"),
    ).toBe(true);
    expect(url).toContain("X-Amz-Expires=60");
  });
});

describe("folding a share's rule into the table's policy", () => {
  it("ANDs filters, unions masks, and lets blank beat scramble", () => {
    const p = foldSharePolicy({
      base: {
        id: "p",
        schema_name: "s",
        table_name: "t",
        row_filter: "region = 'east'",
        masked_columns: ["email"],
        mask_style: "hash",
      },
      share: { row_filter: "amount > 10", masked_columns: ["phone", "email"], mask_style: "null" },
    });
    expect(p?.row_filter).toBe("(region = 'east') AND (amount > 10)");
    expect(p?.masked_columns).toEqual(["email", "phone"]);
    expect(p?.mask_style).toBe("null");
  });

  it("is the share's rule alone when the table has none, and null when neither has one", () => {
    expect(
      foldSharePolicy({
        base: null,
        share: { row_filter: null, masked_columns: ["a"], mask_style: "hash" },
      }),
    ).toMatchObject({ row_filter: null, masked_columns: ["a"], mask_style: "hash" });
    expect(
      foldSharePolicy({
        base: null,
        share: { row_filter: null, masked_columns: [], mask_style: "null" },
      }),
    ).toBeNull();
  });
});

describe("the wiring", () => {
  const server = rd("src/utils/lakehouse/shares.server.ts");

  it("a recipient never gets the lakehouse's own files: every file served is a materialised snapshot", () => {
    // The raw data files carry deleted rows and no policy; the snapshot is
    // written from a governed SELECT with DuckLake's deletes already applied.
    expect(server).toContain("COPY (");
    expect(server).toContain("applyTablePolicies(");
    // The file listing is read only to fingerprint the table; the query path
    // presigns what the snapshot recorded, never what the listing returned.
    const query = server.slice(server.indexOf("export async function queryShareTable"));
    expect(query).toContain("ensureShareSnapshot(");
    expect(query).toContain("snap.files.map(");
    expect(query).toContain("presignS3Get(");
    expect(query).not.toContain("ducklake_list_files");
    expect(query).not.toContain("data_file");
  });

  it("the share prefix sits beside the lake's data path, never inside it", () => {
    // DuckLake's orphan-file cleanup deletes what it does not track under the
    // data path; a snapshot written there would be deleted from under a reader.
    expect(server).toContain("shares");
    expect(server).toMatch(/SHARE_DATA_URL/);
    expect(server).not.toMatch(/dataUrl\}\/shares/);
  });

  it("every route authenticates first, and tokens are looked up by hash with denials rate limited", () => {
    const routes = [
      "src/routes/api/delta-sharing.shares.ts",
      "src/routes/api/delta-sharing.shares.$share.ts",
      "src/routes/api/delta-sharing.shares.$share.schemas.ts",
      "src/routes/api/delta-sharing.shares.$share.all-tables.ts",
      "src/routes/api/delta-sharing.shares.$share.schemas.$schema.tables.ts",
      "src/routes/api/delta-sharing.shares.$share.schemas.$schema.tables.$table.version.ts",
      "src/routes/api/delta-sharing.shares.$share.schemas.$schema.tables.$table.metadata.ts",
      "src/routes/api/delta-sharing.shares.$share.schemas.$schema.tables.$table.query.ts",
    ];
    for (const path of routes) {
      const src = rd(path);
      const handlers = src.match(/(GET|POST|HEAD): async/g) ?? [];
      const auths = src.match(/await authenticateShare\(request\)/g) ?? [];
      expect(auths.length, path).toBe(handlers.length);
      expect(src).not.toContain("supabaseAdmin");
    }
    expect(server).toContain('.eq("token_hash", hash)');
    expect(server).toContain('rateLimitedGlobal("share", limit)');
    expect(server).toContain("expires_at");
  });

  it("owners manage shares through server functions that check schema ownership and audit", () => {
    const fn = rd("src/utils/lakehouse/shares.functions.ts");
    for (const name of [
      "listLakehouseShares",
      "createLakehouseShare",
      "deleteLakehouseShare",
      "addLakehouseShareTable",
      "removeLakehouseShareTable",
      "createLakehouseShareToken",
      "revokeLakehouseShareToken",
    ]) {
      expect(fn).toContain(`export const ${name}`);
    }
    expect(fn).toContain("assertOwnsSchema(");
    expect(fn).toContain('action: "lakehouse.share.token_create"');
    expect(fn).toContain("token_hash: await hashShareToken(token)");
    expect(rd("src/routes/_authenticated/lakehouse.tsx")).toContain("<SharesDialog");
    expect(rd("docs/LAKEHOUSE.md")).toContain("Delta Sharing");
    expect(rd("README.md")).toContain("Delta Sharing");
  });
});
