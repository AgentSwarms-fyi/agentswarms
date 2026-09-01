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
