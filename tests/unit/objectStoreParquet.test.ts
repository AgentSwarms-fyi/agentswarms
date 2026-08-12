// Reading Parquet out of an S3-compatible bucket, against a real one.
//
// The Data Catalog could already LIST a Parquet object — name, size,
// last-modified — but `inferColumns` returns [] for parquet/orc/avro because
// it parses a head-of-file text sample, and Parquet's schema lives in the
// FOOTER. So every Parquet asset was cataloged as a filename with a size and
// no columns, and nothing could query it.
//
// These tests run against MinIO, which is the only way to prove SigV4 signing,
// path-style addressing, a custom endpoint and DuckDB's httpfs all line up.
// A fake would prove that the fake agrees with itself.
//
//   docker run -d --name as-minio-test -p 9010:9000 \
//     -e MINIO_ROOT_USER=probeaccesskey -e MINIO_ROOT_PASSWORD=probesecretkey123 \
//     minio/minio server /data
//
// Skipped, loudly, when that is not running — a suite that silently passes
// because its subject was absent is worse than one that fails.
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { beforeAll, describe, expect, it } from "vitest";

import {
  listObjects,
  fileFormat,
  type ObjectStoreConfig,
} from "@/utils/catalog/objectStore.server";
import { crawlObjectStorage, duckTypeToCatalogType } from "@/utils/catalog/crawler.server";
import { objectSqlName } from "@/lib/objectSqlName";
import { sqlNameFor } from "@/utils/catalog/objectStoreQuery.server";
import {
  assertEndpointAllowed,
  countObjectRows,
  describeObject,
  duckReadableFormat,
  readObjectRows,
  avroUnavailableReason,
  needsIsolation,
} from "@/utils/catalog/objectStoreRead.server";

const CFG: ObjectStoreConfig = {
  provider: "minio",
  endpoint: "http://127.0.0.1:9010",
  region: "us-east-1",
  bucket: "catalog-test",
  path_style: true,
  access_key_id: "probeaccesskey",
  secret_access_key: "probesecretkey123",
};

// Probed at MODULE scope, not in beforeAll, so vitest can SKIP rather than
// silently pass. Mutation testing stopped MinIO and the whole suite still
// went green — fifteen tests reporting success with no bucket to test
// against. Skipped shows as skipped; passed is a lie.
const live = await (async () => {
  try {
    const r = await fetch(`${CFG.endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
})();

if (!live) {
  console.warn(
    "\n[objectStoreParquet] MinIO is not on 127.0.0.1:9010 — these tests are SKIPPED, " +
      "not passed. They are the only proof the Parquet path works end to end.\n",
  );
}

// ── seeding, with the same SigV4 the reader relies on ───────────────────────
const sha256 = (d: Parameters<typeof createHash>[0] extends never ? never : string | Buffer) =>
  createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

function signedHeaders(method: string, path: string, body: string | Buffer) {
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(CFG.endpoint!).host;
  const payloadHash = sha256(body);
  const canonical = [
    method,
    path,
    "",
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    "host;x-amz-content-sha256;x-amz-date",
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${CFG.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key = hmac(`AWS4${CFG.secret_access_key}`, dateStamp);
  for (const p of [CFG.region, "s3", "aws4_request"]) key = hmac(key, p);
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${CFG.access_key_id}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}

async function put(path: string, body: string | Buffer) {
  const res = await fetch(`${CFG.endpoint}${path}`, {
    method: "PUT",
    headers: signedHeaders("PUT", path, body),
    body: body as BodyInit,
  });
  if (!res.ok && res.status !== 409) throw new Error(`PUT ${path} -> ${res.status}`);
}

beforeAll(async () => {
  if (!live) return;
  await put(`/${CFG.bucket}`, "");

  // Types that matter: integer, string with a NULL, double, date.
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const dir = mkdtempSync(`${tmpdir()}/pq-seed-`).split("\\").join("/");
  const file = `${dir}/orders.parquet`;
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  await (
    await conn.run(
      `COPY (SELECT * FROM (VALUES
         (1,'EMEA',100.50,DATE '2026-01-15'),
         (2,'AMER',250.25,DATE '2026-02-20'),
         (3,'APAC',75.00,DATE '2026-03-10'),
         (4,NULL,410.75,DATE '2026-04-05'),
         (5,'EMEA',33.10,DATE '2026-05-30')
       ) AS t(order_id, region, amount, order_date))
       TO '${file}' (FORMAT PARQUET)`,
    )
  ).getRowObjects();
  await put(`/${CFG.bucket}/data/orders.parquet`, readFileSync(file));
  await put(`/${CFG.bucket}/data/regions.csv`, "region,manager\nEMEA,Ada\nAMER,Grace\nAPAC,Alan\n");
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

const withMinio = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it.skipIf(!live)(name, fn, timeout);

describe("the crawler can see a Parquet object at all", () => {
  withMinio("lists it, with its size and format", async () => {
    const objects = await listObjects(CFG);
    const pq = objects.find((o) => o.key === "data/orders.parquet");
    expect(pq, "the Parquet object was not listed").toBeTruthy();
    expect(pq!.size).toBeGreaterThan(0);
    expect(fileFormat(pq!.key)).toBe("parquet");
  });

  withMinio("recognises which formats DuckDB can open", async () => {
    expect(duckReadableFormat("parquet")).toBe("parquet");
    expect(duckReadableFormat("csv")).toBe("csv");
    expect(duckReadableFormat("ndjson")).toBe("ndjson");
    // ORC arrived with the community extension — see the ORC/Avro block below
    // for why it is readable but isolated, and why Avro is not readable at all.
    expect(duckReadableFormat("orc")).toBe("orc");
    expect(duckReadableFormat("avro")).toBeNull();
    expect(duckReadableFormat(null)).toBeNull();
  });
});

describe("schema comes from the footer, which is the whole point", () => {
  withMinio("returns the real column names and types", async () => {
    const cols = await describeObject(CFG, "data/orders.parquet", "parquet");
    expect(cols.map((c) => c.name)).toEqual(["order_id", "region", "amount", "order_date"]);
    // Types, not just names. A catalog that says every column is a string is
    // barely better than one with no columns.
    const byName = Object.fromEntries(cols.map((c) => [c.name, c.type]));
    expect(byName.order_id).toMatch(/INT/i);
    expect(byName.region).toMatch(/VARCHAR/i);
    expect(byName.amount).toMatch(/DECIMAL|DOUBLE/i);
    expect(byName.order_date).toMatch(/DATE/i);
  });

  withMinio("counts rows from metadata without scanning", async () => {
    expect(await countObjectRows(CFG, "data/orders.parquet", "parquet")).toBe(5);
  });

  withMinio("does the same for CSV, which has no footer", async () => {
    const cols = await describeObject(CFG, "data/regions.csv", "csv");
    expect(cols.map((c) => c.name)).toEqual(["region", "manager"]);
    expect(await countObjectRows(CFG, "data/regions.csv", "csv")).toBe(3);
  });
});

describe("a real crawl produces a Parquet asset with columns", () => {
  // The whole point, at the level the product actually works at. Before this,
  // crawlObjectStorage returned the Parquet object with `columns: []`.
  withMinio("gives the Parquet asset its real schema", async () => {
    const { assets } = await crawlObjectStorage(CFG);
    const pq = assets.find((a) => a.fqn.includes("orders.parquet"));
    expect(pq, "the Parquet asset is missing from the crawl").toBeTruthy();
    expect(pq!.columns.length, "the Parquet asset was cataloged with no columns").toBe(4);
    expect(pq!.columns.map((c) => c.name)).toEqual(["order_id", "region", "amount", "order_date"]);
  });

  withMinio("maps DuckDB types into the catalog's own vocabulary", async () => {
    // Not DECIMAL(18,2): the catalog stores number/string/date/boolean, which
    // is what CSV inference produces and what every consumer expects. Leaking
    // raw SQL types in would put values in the catalog nothing else can make.
    const { assets } = await crawlObjectStorage(CFG);
    const pq = assets.find((a) => a.fqn.includes("orders.parquet"))!;
    const byName = Object.fromEntries(pq.columns.map((c) => [c.name, c.type]));
    expect(byName).toEqual({
      order_id: "number",
      region: "string",
      amount: "number",
      order_date: "date",
    });
  });

  withMinio("records the row count from the footer", async () => {
    const { assets } = await crawlObjectStorage(CFG);
    const pq = assets.find((a) => a.fqn.includes("orders.parquet"))!;
    expect(pq.row_count).toBe(5);
  });

  withMinio("still infers CSV from a head-of-file SAMPLE, not by describing it", async () => {
    // Guard on the guard, and it needed sharpening. Asserting only the column
    // NAMES passed even with CSV sampling disabled, because DuckDB can also
    // describe a CSV — the same answer by a different route. Mutation testing
    // caught that. Profile statistics are the discriminator: they come from
    // reading actual values, and the describe path cannot produce them.
    const { assets } = await crawlObjectStorage(CFG);
    const csv = assets.find((a) => a.fqn.includes("regions.csv"));
    expect(csv, "the CSV asset disappeared").toBeTruthy();
    expect(csv!.columns.map((c) => c.name)).toEqual(["region", "manager"]);
    const region = csv!.columns.find((c) => c.name === "region")!;
    expect(region.sample, "no sample value — CSV went through the describe path").toBeTruthy();
    expect(region.distinct_count, "no profile stats — CSV was not sampled").toBe(3);
  });

  it("maps every DuckDB type family it can meet", () => {
    for (const t of ["INTEGER", "BIGINT", "DECIMAL(18,2)", "DOUBLE", "HUGEINT", "FLOAT"]) {
      expect(duckTypeToCatalogType(t), t).toBe("number");
    }
    for (const t of ["DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "TIME"]) {
      expect(duckTypeToCatalogType(t), t).toBe("date");
    }
    expect(duckTypeToCatalogType("BOOLEAN")).toBe("boolean");
    // Containers and INTERVAL are the ones that trip a naive substring match:
    // "STRUCT(a INTEGER)" contains INT, "INTERVAL" contains INT. Both were
    // cataloged as numbers until this test was written.
    for (const t of [
      "VARCHAR",
      "BLOB",
      "UUID",
      "STRUCT(a INTEGER)",
      "INTEGER[]",
      "LIST(BIGINT)",
      "MAP(VARCHAR, INTEGER)",
      "INTERVAL",
    ]) {
      expect(duckTypeToCatalogType(t), t).toBe("string");
    }
  });
});

describe("rows come back with their values and types intact", () => {
  withMinio("reads every row", async () => {
    const res = await readObjectRows(CFG, "data/orders.parquet", "parquet");
    expect(res.rows).toHaveLength(5);
    expect(res.capped).toBe(false);
    expect(Number(res.rows[0].order_id)).toBe(1);
    expect(res.rows[0].region).toBe("EMEA");
  });

  withMinio("returns a DATE as a readable date, not a DuckDB internal", async () => {
    // FOUND BY LOOKING AT THE SCREEN. Every type assertion passed while the
    // results grid rendered order_date as {"days":20468} — the raw DuckDB DATE
    // object, because this reader returned getRowObjects() values untouched
    // instead of putting them through the same converter the local and browser
    // engines use.
    const res = await readObjectRows(CFG, "data/orders.parquet", "parquet");
    const first = res.rows.find((r) => Number(r.order_id) === 1)!;
    expect(typeof first.order_date, `got ${JSON.stringify(first.order_date)}`).not.toBe("object");
    expect(String(first.order_date)).toContain("2026-01-15");
  });

  withMinio("preserves NULL as NULL, not as an empty string", async () => {
    const res = await readObjectRows(CFG, "data/orders.parquet", "parquet");
    const row4 = res.rows.find((r) => Number(r.order_id) === 4)!;
    expect(row4.region).toBeNull();
  });

  withMinio("keeps numbers numeric, so SUM is arithmetic not concatenation", async () => {
    const res = await readObjectRows(CFG, "data/orders.parquet", "parquet");
    const total = res.rows.reduce((s, r) => s + Number(r.amount), 0);
    expect(total).toBeCloseTo(869.6, 2);
  });

  withMinio("reports truncation instead of presenting a prefix as the whole", async () => {
    // The failure mode this codebase keeps finding: a capped read that looks
    // complete. `capped` is observed by fetching one row past the cap.
    const res = await readObjectRows(CFG, "data/orders.parquet", "parquet", 2);
    expect(res.rows).toHaveLength(2);
    expect(res.capped, "a truncated read reported itself as complete").toBe(true);
  });

  withMinio("does not claim truncation when the object exactly fills the cap", async () => {
    // Guard on the guard: `rows.length >= cap` would be wrong here, and this
    // is the boundary where the two spellings disagree.
    const res = await readObjectRows(CFG, "data/orders.parquet", "parquet", 5);
    expect(res.rows).toHaveLength(5);
    expect(res.capped).toBe(false);
  });
});

describe("the endpoint is checked before DuckDB is pointed at it", () => {
  // httpfs makes its own HTTP calls and never goes through safeFetch, so none
  // of the redirect/DNS revalidation in ssrfGuard applies. This is the only
  // chance to refuse.
  it("refuses cloud instance metadata outright", () => {
    expect(() => assertEndpointAllowed("http://169.254.169.254")).toThrow(/never allowed/i);
    expect(() => assertEndpointAllowed("http://[fd00:ec2::254]")).toThrow(/never allowed/i);
  });

  it("refuses a non-http scheme", () => {
    expect(() => assertEndpointAllowed("file:///etc")).toThrow(/http or https/i);
    expect(() => assertEndpointAllowed("not a url")).toThrow(/valid URL/i);
  });

  it("allows an ordinary private address by default, because self-hosted MinIO is one", () => {
    // The counterpart that keeps the check from being "refuse everything".
    expect(() => assertEndpointAllowed("http://127.0.0.1:9010")).not.toThrow();
    expect(() => assertEndpointAllowed("https://s3.eu-west-1.amazonaws.com")).not.toThrow();
    expect(() => assertEndpointAllowed(undefined)).not.toThrow();
  });

  withMinio("and the readers actually call it, not just export it", async () => {
    // Mutation testing removed assertEndpointAllowed from configure() and
    // every test above still passed — they called the checker directly and
    // never proved the read path consults it. These do.
    const evil = { ...CFG, endpoint: "http://169.254.169.254" };
    await expect(describeObject(evil, "data/orders.parquet", "parquet")).rejects.toThrow(
      /never allowed/i,
    );
    await expect(readObjectRows(evil, "data/orders.parquet", "parquet")).rejects.toThrow(
      /never allowed/i,
    );
    // countObjectRows swallows errors by design (a row count is a nicety), so
    // its contract is "returns null", not "throws".
    expect(await countObjectRows(evil, "data/orders.parquet", "parquet")).toBeNull();
  });

  it("refuses private addresses when the operator has switched that on", () => {
    const prev = process.env.BLOCK_PRIVATE_NETWORK_FETCH;
    process.env.BLOCK_PRIVATE_NETWORK_FETCH = "true";
    try {
      expect(() => assertEndpointAllowed("http://127.0.0.1:9010")).toThrow(/BLOCK_PRIVATE/);
    } finally {
      if (prev === undefined) delete process.env.BLOCK_PRIVATE_NETWORK_FETCH;
      else process.env.BLOCK_PRIVATE_NETWORK_FETCH = prev;
    }
  });
});

describe("the SQL name a bucket file gets", () => {
  // The Catalog seeds `SELECT * FROM orders LIMIT 10` in the BROWSER and the
  // server resolves `orders` back to `data/orders.parquet` when the query
  // runs. Two copies of that rule would drift and the symptom would be a
  // seeded query answering "does not reference any file" — a dead button.
  it("is the basename without its extension", () => {
    expect(objectSqlName("data/orders.parquet")).toBe("orders");
    expect(objectSqlName("orders.parquet")).toBe("orders");
    expect(objectSqlName("a/b/c/sales_2026.csv")).toBe("sales_2026");
  });

  it("uses the folder for a partitioned group", () => {
    // A crawled folder of same-format files has a fqn like `sales/*.parquet`.
    expect(objectSqlName("warehouse/sales/*.parquet")).toBe("sales");
  });

  it("survives characters that are not valid in an identifier", () => {
    expect(objectSqlName("raw/2026-01 orders (final).parquet")).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("the server's resolver agrees with it when there is no clash", () => {
    expect(sqlNameFor("data/orders.parquet", new Set())).toBe(objectSqlName("data/orders.parquet"));
  });

  it("disambiguates two files with the same basename", () => {
    // Two `orders.parquet` in different folders is ordinary. Pointing both at
    // one of them would answer the wrong question, silently.
    const taken = new Set<string>();
    const a = sqlNameFor("eu/orders.parquet", taken);
    taken.add(a);
    const b = sqlNameFor("us/orders.parquet", taken);
    taken.add(b);
    expect(a).toBe("orders");
    expect(b).not.toBe(a);
    expect(b).toMatch(/us/);
  });
});

describe("ORC and Avro", () => {
  // Neither has a built-in DuckDB reader, and they fail in opposite ways.
  //
  // ORC has a community extension that works — until it does not. Measured on
  // files published by the Apache ORC project itself:
  //
  //   demo-11-none.orc       flat, 9 cols   DESCRIBE ok, rows ok
  //   TestOrcFile.test1.orc  nested STRUCT  DESCRIBE ok, rows -> PANIC
  //
  // That panic is a Rust abort inside the extension's Arrow bridge, in a
  // function that cannot unwind, so it kills the whole process. Reachable by
  // putting such a file in a bucket the crawler reads — a denial of service.
  // ORC therefore only ever runs in a child process.
  //
  // Avro's extension has no build published since DuckDB v1.1.3; checked
  // against the community repository for v1.5.5 on windows_amd64,
  // linux_amd64, linux_arm64 and osx_arm64 — all 404, while ORC returns 200
  // from the same host. So the format is recognised and cataloged, and the
  // reason it cannot be read is stated rather than implied.

  it("recognises ORC as readable and Avro as not", () => {
    expect(duckReadableFormat("orc")).toBe("orc");
    expect(duckReadableFormat("avro"), "Avro has no reader — do not claim one").toBeNull();
  });

  it("isolates ORC and nothing else", () => {
    // Parquet and CSV are built-in and stable; a process spawn each would be a
    // real cost paid against a risk that does not exist there.
    expect(needsIsolation("orc")).toBe(true);
    for (const f of ["parquet", "csv", "ndjson"] as const) {
      expect(needsIsolation(f), f).toBe(false);
    }
  });

  it("says WHY Avro cannot be read, not merely that it cannot", () => {
    const why = avroUnavailableReason();
    expect(why).toMatch(/community extension/i);
    expect(why).toMatch(/v1\.1\.3/);
    expect(why, "should tell the user what to do about it").toMatch(/parquet/i);
  });

  withMinio("describes a flat ORC file with real columns and types", async () => {
    const cols = await describeObject(CFG, "data/flat.orc", "orc");
    expect(cols.length).toBe(9);
    expect(cols.map((c) => c.name)).toContain("_col0");
    expect(cols.some((c) => /INT|BIGINT/i.test(c.type))).toBe(true);
  });

  withMinio("reads rows from a flat ORC file", async () => {
    const res = await readObjectRows(CFG, "data/flat.orc", "orc", 5);
    expect(res.rows).toHaveLength(5);
    expect(res.capped, "5 of ~1.9M rows is a truncated read").toBe(true);
  });

  withMinio("describes a NESTED ORC file — DESCRIBE survives what reading does not", async () => {
    const cols = await describeObject(CFG, "data/nested.orc", "orc");
    expect(cols.map((c) => c.name)).toContain("boolean1");
    expect(
      cols.some((c) => /STRUCT|LIST|MAP/i.test(c.type)),
      "no nested column found",
    ).toBe(true);
  });

  withMinio(
    "survives the file that aborts the ORC reader",
    async () => {
      // THE TEST THAT MATTERS. Without the child process this call takes the
      // whole vitest worker with it and the run reports a crash, not a failure.
      // Reaching the next line at all is the assertion.
      await expect(readObjectRows(CFG, "data/nested.orc", "orc", 10)).rejects.toThrow();
      // And the process is still here to say so.
      expect(1 + 1).toBe(2);
    },
    90_000,
  );

  withMinio(
    "blames the reader, not the file",
    async () => {
      // "Could not read this file" would send someone looking for corruption in
      // a file the Apache ORC project publishes as a conformance test.
      const err = await readObjectRows(CFG, "data/nested.orc", "orc", 10).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/ORC reader crashed|nested types are not supported/i);
    },
    90_000,
  );

  withMinio(
    "crawls a bucket holding all of them without dying",
    async () => {
      // The crawl is where an unreadable file is most dangerous: it runs
      // unattended and touches every object in the bucket.
      const { assets } = await crawlObjectStorage(CFG);
      const byName = Object.fromEntries(assets.map((a) => [a.fqn, a]));

      // Same-format files in one folder become a single DATASET asset —
      // existing grouping behaviour, so the two ORC files land as `data/*.orc`
      // rather than separately. Asserting what the product actually produces.
      const orc = byName["data/*.orc"];
      expect(orc, `no ORC dataset; got ${Object.keys(byName).join(", ")}`).toBeTruthy();
      expect(orc.file_count).toBe(2);
      expect(orc.columns.length, "the ORC group was cataloged with no schema").toBe(9);
      expect(orc.row_count ?? 0).toBeGreaterThan(1_000_000);

      // Avro appears with NO columns rather than not appearing at all. A file
      // the platform cannot open is still a file the operator owns, and a
      // catalog that hides it is lying by omission.
      expect(byName["data/events.avro"], "the Avro file vanished from the catalog").toBeTruthy();
      expect(byName["data/events.avro"].columns).toHaveLength(0);

      // The formats that already worked still do.
      expect(byName["data/orders.parquet"].columns.length).toBe(4);
      expect(byName["data/regions.csv"].columns.length).toBe(2);
    },
    180_000,
  );
});

describe("the ORC download has a ceiling and leaves nothing behind", () => {
  // read_orc cannot stream from object storage — measured, it opens local
  // paths only — so the whole object is downloaded. That makes two things
  // load-bearing that Parquet never needs: a size limit, and cleanup.
  const orcTmpDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith("as-orc-")).length;

  withMinio("refuses a file bigger than the limit instead of pulling it", async () => {
    // flat.orc is ~5 MB. With the ceiling at 1 KB the read must be refused
    // BEFORE the bytes are fetched, and say so in a way that names the fix.
    const prev = process.env.ORC_MAX_DOWNLOAD_BYTES;
    process.env.ORC_MAX_DOWNLOAD_BYTES = "1024";
    try {
      const err = await readObjectRows(CFG, "data/flat.orc", "orc", 5).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/larger than|MB ORC limit/i);
      expect((err as Error).message, "should name the knob").toMatch(/ORC_MAX_DOWNLOAD_BYTES/);
    } finally {
      if (prev === undefined) delete process.env.ORC_MAX_DOWNLOAD_BYTES;
      else process.env.ORC_MAX_DOWNLOAD_BYTES = prev;
    }
  });

  withMinio("still reads the same file once the limit allows it", async () => {
    // Guard on the guard: without this, a ceiling of zero would pass the test
    // above and break the feature.
    const res = await readObjectRows(CFG, "data/flat.orc", "orc", 3);
    expect(res.rows).toHaveLength(3);
  });

  withMinio(
    "deletes the temporary copy, including when the reader crashes",
    async () => {
      const before = orcTmpDirs();
      await readObjectRows(CFG, "data/flat.orc", "orc", 3);
      expect(orcTmpDirs(), "a successful read leaked its download").toBe(before);
      // The crash path runs through the same finally, and is the one most likely
      // to skip cleanup — the child dies rather than returning.
      await readObjectRows(CFG, "data/nested.orc", "orc", 3).catch(() => {});
      expect(orcTmpDirs(), "a crashed read leaked its download").toBe(before);
    },
    120_000,
  );
});

describe("a folder of files is one asset, and the formats differ there too", () => {
  // The crawler groups same-format files in a folder into ONE asset with a
  // glob fqn (`data/*.orc`). Found from the UI: that asset had no "Query data"
  // button, because the button's gate allowed table/view/file and the crawler
  // calls a group a `dataset`. Partitioned Parquet — the common shape for real
  // data — was hidden by the same line.
  const CATALOG = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");

  it("the button is offered for a grouped dataset, not only single files", () => {
    expect(CATALOG).toMatch(/a\.asset_type === "dataset"/);
  });

  it("but never for a grouped ORC folder", () => {
    // Verified: read_parquet and read_csv_auto both expand `s3://…/*.ext`.
    // ORC is read by downloading one object, so a glob cannot work — and a
    // button that always errors is worse than no button.
    expect(CATALOG).toMatch(/a\.asset_type === "dataset" && a\.format === "orc"/);
  });

  withMinio("and the server refuses an ORC glob by name, not with a 404", async () => {
    // Defence for anyone calling the API directly rather than clicking.
    const err = await readObjectRows(CFG, "data/*.orc", "orc", 5).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/folder of ORC files|cannot expand/i);
    expect((err as Error).message, "should say what to do instead").toMatch(/Parquet/);
  });

  withMinio("while a Parquet glob is read normally", async () => {
    // Guard on the guard: the ORC refusal must not have blocked the case that
    // works. `data/*.parquet` matches the one Parquet file in the bucket.
    const res = await readObjectRows(CFG, "data/*.parquet", "parquet", 10);
    expect(res.rows).toHaveLength(5);
  });
});
