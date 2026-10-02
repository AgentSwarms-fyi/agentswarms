// Credentials must not ride out on an error message.
//
// FOUND FROM THE UI. Stopping the catalog Postgres and loading /lakehouse
// rendered DuckDB's attach failure verbatim, and the ATTACH statement embeds
// the catalog's entire libpq string — so the page showed
// `password=lakehouse-catalog-secret-1` to a signed-in, non-admin user. The
// leak predated the error panel (the same text went out as a toast); the panel
// only made it durable enough to notice.
//
// The catalog password and the S3 secret are deployment infrastructure. Reading
// them off a page is a privilege escalation: the S3 secret is engine-level and,
// as this module's own header notes, "would otherwise let any user read any
// bucket the deployment can".
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const CATALOG = "postgres://lakehouse:sup3r-secret-pw@192.168.1.10:15433/lakehouse_catalog";
const S3_SECRET = "minio-secret-value-1234";

async function subject() {
  const mod = await import("@/utils/lakehouse/core.server");
  return mod.redactLakehouseSecrets;
}

describe("redactLakehouseSecrets", () => {
  beforeEach(() => {
    vi.stubEnv("LAKEHOUSE_CATALOG_URL", CATALOG);
    vi.stubEnv("LAKEHOUSE_DATA_URL", "s3://lakehouse/main");
    vi.stubEnv("LAKEHOUSE_S3_KEY_ID", "etltest");
    vi.stubEnv("LAKEHOUSE_S3_SECRET", S3_SECRET);
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("removes the password from the libpq string DuckDB echoes back", async () => {
    const redact = await subject();
    // The real message, shortened. Note it carries BOTH forms at once.
    const real =
      `IO Error: Failed to attach DuckLake MetaData "__ducklake_metadata_lake" at path ` +
      `"postgres:dbname=lakehouse_catalog host=192.168.1.10 port=15433 user=lakehouse ` +
      `password=sup3r-secret-pw"Unable to connect to Postgres at dbname=lakehouse_catalog ` +
      `host=192.168.1.10 port=15433 user=lakehouse password=sup3r-secret-pw: connection refused`;
    const out = redact(real);

    expect(out).not.toContain("sup3r-secret-pw");
    expect(out).toContain("[redacted]");
    // Everything an operator needs to diagnose it must survive.
    expect(out).toContain("connection refused");
    expect(out).toContain("192.168.1.10");
    expect(out).toContain("user=lakehouse");
  });

  it("removes a password embedded in a connection URL", async () => {
    const redact = await subject();
    const out = redact(`could not connect to ${CATALOG}`);
    expect(out).not.toContain("sup3r-secret-pw");
    expect(out).toContain("192.168.1.10:15433");
  });

  it("removes the S3 secret wherever it appears", async () => {
    const redact = await subject();
    // Not in a password= shape — this is the case pattern-matching alone misses.
    const out = redact(`HTTP 403 signing with key etltest / ${S3_SECRET} failed`);
    expect(out).not.toContain(S3_SECRET);
    expect(out).toContain("etltest"); // the key ID is not a secret, and identifies the config
  });

  it("leaves an innocent message alone", async () => {
    const redact = await subject();
    const msg = "Catalog Error: Table with name revenue_facts does not exist!";
    expect(redact(msg)).toBe(msg);
  });

  it("is applied where the engine error is rethrown", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    // The attach failure is the one that carries the connection string, so the
    // redaction has to sit on that path, not merely exist in the module.
    expect(src).toContain("err.message = redactLakehouseSecrets(err.message)");
  });
});

// A data file the catalog lists that object storage no longer has.
//
// FOUND FROM THE UI, again. Browsing analytics.f1_standings rendered DuckDB's
// raw failure: an HTTP 404 quoting the full S3 URL, including the deployment's
// object-store endpoint. Two problems in one message — it named an internal
// address, and it told a user nothing about what had happened or what to do.
//
// The underlying condition was real: a MinIO volume had been recreated while
// the catalog Postgres survived, so eight live data files were referenced and
// two of them had never existed in the new store. The catalog was the only
// thing still claiming those rows were there.
describe("describeMissingDataFile", () => {
  // The exact text DuckDB produced, endpoint and all.
  const REAL =
    "HTTP Error: HTTP GET error reading " +
    "'http://192.168.1.10:19000/lakehouse/main/analytics/f1_standings/" +
    "ducklake-01a0529f-c607-7895-a5cf-b17d151a00d2.parquet' in region '' " +
    "(HTTP 404 Not Found) NoSuchKey: The specified key does not exist.";

  async function subject() {
    const mod = await import("@/utils/lakehouse/core.server");
    return mod.describeMissingDataFile;
  }

  it("recognises the failure and says what actually happened", async () => {
    const describe_ = await subject();
    const out = describe_(REAL);
    expect(out).toBeTruthy();
    expect(out).toMatch(/missing from object storage/i);
    expect(out).toMatch(/diverged/i);
    // Actionable, not just descriptive.
    expect(out).toMatch(/re-import|drop it/i);
  });

  it("names the file but NOT the endpoint", async () => {
    const describe_ = await subject();
    const out = describe_(REAL)!;
    expect(out).toContain("ducklake-01a0529f-c607-7895-a5cf-b17d151a00d2.parquet");
    // The whole point: the operator's address must not travel to the browser.
    expect(out).not.toContain("192.168.1.10");
    expect(out).not.toContain("19000");
    expect(out).not.toContain("http://");
  });

  it("reassures that the blast radius is one table", async () => {
    const describe_ = await subject();
    expect(describe_(REAL)).toMatch(/Other tables are unaffected/i);
  });

  it("leaves every other error alone", async () => {
    const describe_ = await subject();
    for (const other of [
      "Catalog Error: Table with name orders does not exist!",
      "Conversion Error: Could not convert string 'abc' to INT32",
      "Failed to commit DuckLake transaction",
      "IO Error: Connection refused",
      // A 404 with no parquet in it is somebody else's problem.
      "HTTP Error: HTTP GET error (HTTP 404 Not Found) for the extension registry",
    ]) {
      expect(describe_(other), other).toBeNull();
    }
  });

  it("needs BOTH a 404-ish signal and a parquet, not either alone", async () => {
    const describe_ = await subject();
    // Parquet named, but the failure is a permission problem, not a miss.
    expect(describe_("IO Error: reading 'x/y/a.parquet' failed: 403 Forbidden")).toBeNull();
  });

  it("is wired into the query path, not just exported", async () => {
    // The redaction fix that preceded this one covered engine boot only, so
    // query errors — the ones users actually hit — went out untouched.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");
    expect(src).toContain("describeMissingDataFile((e as Error).message)");
    expect(src).toMatch(/redactLakehouseSecrets\(\s*describeMissingDataFile/);
  });
});
