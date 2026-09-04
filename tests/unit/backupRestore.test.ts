// Backup & restore: the pure core, and the doc claims that used to be wrong.
//
// The deployment docs said Postgres was "the single stateful component" and
// the in-app page said "Supabase holds all durable state". A self-hosted
// install has four unrecoverable things (application DB, lakehouse catalog,
// lake Parquet, .env secrets); an operator who believed the old sentence and
// backed up one of them would restore a lakehouse with no data. These tests
// pin the core's judgements and keep both doc sets honest.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseEnvFile,
  parseS3Url,
  lakeS3Config,
  parsePostgresUrl,
  secretsManifest,
  UNRECOVERABLE_SECRETS,
  signS3,
  s3Target,
  resolveCatalogRunner,
  withDatabase,
  checkCatalogDump,
} from "../../scripts/lib/backup-core.mjs";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("backup core: environment", () => {
  it("parses .env quoting and ignores comments", () => {
    const env = parseEnvFile(`# comment\nA=1\nB="two words"\nC='x=y'\n\nJUNK\n`);
    expect(env).toEqual({ A: "1", B: "two words", C: "x=y" });
  });

  it("derives the lake S3 config from the app's own LAKEHOUSE_* variables", () => {
    const cfg = lakeS3Config({
      LAKEHOUSE_DATA_URL: "s3://lakehouse/main/",
      LAKEHOUSE_S3_ENDPOINT: "http://minio:9000",
      LAKEHOUSE_S3_KEY_ID: "k",
      LAKEHOUSE_S3_SECRET: "s",
      LAKEHOUSE_S3_USE_SSL: "false",
      LAKEHOUSE_S3_URL_STYLE: "path",
    });
    expect(cfg).toMatchObject({
      bucket: "lakehouse",
      prefix: "main",
      pathStyle: true,
      useSsl: false,
      region: "us-east-1",
    });
    expect(s3Target(cfg!)).toEqual({
      origin: "http://minio:9000",
      host: "minio:9000",
      basePath: "/lakehouse",
    });
  });

  it("returns null when the lake is not configured, so backup skips instead of failing", () => {
    expect(lakeS3Config({})).toBeNull();
    expect(lakeS3Config({ LAKEHOUSE_DATA_URL: "s3://b/p" })).toBeNull();
    expect(parseS3Url("gs://nope")).toBeNull();
    expect(parseS3Url("s3://bucket")).toEqual({ bucket: "bucket", prefix: "" });
  });

  it("splits the catalog URL for pg_dump", () => {
    expect(parsePostgresUrl("postgresql://lake:p%40ss@catalog:5433/lakehouse_catalog")).toEqual({
      host: "catalog",
      port: "5433",
      user: "lake",
      password: "p@ss",
      database: "lakehouse_catalog",
    });
    expect(parsePostgresUrl(undefined)).toBeNull();
  });
});

describe("backup core: secrets are named, never copied", () => {
  it("lists the two keys whose loss makes a restore useless", () => {
    const names = UNRECOVERABLE_SECRETS.map(([n]) => n);
    expect(names).toContain("PROVIDER_CREDS_SECRET");
    expect(names).toContain("PROVENANCE_SIGNING_SECRET");
  });

  it("manifest entries carry name/why/set only -- no values", () => {
    const m = secretsManifest({ PROVIDER_CREDS_SECRET: "hunter2", LAKEHOUSE_S3_KEY_ID: "" });
    for (const row of m) expect(Object.keys(row).sort()).toEqual(["name", "set", "why"]);
    expect(m.find((r) => r.name === "PROVIDER_CREDS_SECRET")?.set).toBe(true);
    expect(m.find((r) => r.name === "LAKEHOUSE_S3_KEY_ID")?.set).toBe(false);
    expect(JSON.stringify(m)).not.toContain("hunter2");
  });
});

describe("backup core: a dump must be a DuckLake catalog", () => {
  const toc = (tables: string[]) =>
    [
      "; Archive created",
      ...tables.map((n, i) => `${i + 1}; 1259 ${16400 + i} TABLE public ${n} lakehouse`),
    ].join("\n");

  it("accepts a TOC that has ducklake_snapshot and counts its objects", () => {
    expect(
      checkCatalogDump(toc(["ducklake_snapshot", "ducklake_table", "ducklake_data_file"]), "x"),
    ).toEqual({
      objects: 3,
    });
  });

  it("refuses an empty or foreign Postgres -- the wrong-target failure exits non-zero", () => {
    expect(() => checkCatalogDump("", "host/db via docker exec twin")).toThrow(
      /0 objects and no ducklake_snapshot/,
    );
    expect(() => checkCatalogDump(toc(["users", "orders"]), "x")).toThrow(
      /not the catalog the app uses/,
    );
  });
});

describe("backup core: which Postgres is the catalog", () => {
  // The bug this guards: an idle compose twin of the real catalog container
  // got dumped (0 tables, exit 0) because "the service is running" was taken
  // as "this is the catalog". The URL's host decides, in a fixed order.
  const probes = (containers: string[], aliases: string[]) => ({
    containerExists: (n: string) => containers.includes(n),
    composeAliases: () => aliases,
  });

  it("a container named after the host wins, even when the compose service is up", () => {
    const r = resolveCatalogRunner(
      "agentswarms-lakehouse-catalog",
      probes(
        ["agentswarms-lakehouse-catalog"],
        ["lakehouse-catalog", "agentswarms-lakehouse-catalog"],
      ),
    );
    expect(r.kind).toBe("container");
    expect(r.prefix).toEqual(["exec", "-i", "agentswarms-lakehouse-catalog"]);
  });

  it("the compose service is used only when the host is one of its aliases", () => {
    expect(
      resolveCatalogRunner(
        "lakehouse-catalog",
        probes([], ["lakehouse-catalog", "proj-lakehouse-catalog-1"]),
      ).kind,
    ).toBe("compose");
    expect(resolveCatalogRunner("db.internal", probes([], ["lakehouse-catalog"])).kind).toBe(
      "local",
    );
  });

  it("falls back to local client binaries for an external Postgres", () => {
    const r = resolveCatalogRunner("pg.example.com", probes([], []));
    expect(r).toMatchObject({ kind: "local", bin: null, prefix: [] });
  });

  it("swaps only the database in the catalog URL", () => {
    expect(withDatabase("postgres://u:p@h:5432/lakehouse_catalog", "lakehouse_catalog_drill")).toBe(
      "postgres://u:p@h:5432/lakehouse_catalog_drill",
    );
  });
});

describe("backup core: SigV4", () => {
  const cfg = {
    bucket: "lakehouse",
    prefix: "main",
    endpoint: "http://minio:9000",
    region: "us-east-1",
    pathStyle: true,
    useSsl: false,
    keyId: "AKID",
    secret: "SECRET",
  };

  it("canonicalises path-style keys and sorts query + signed headers", () => {
    const s = signS3({
      method: "GET",
      cfg,
      key: "main/t1/data (1).parquet",
      query: { prefix: "main/", "list-type": "2" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      amzDate: "20260904T120000Z",
    });
    expect(s.canonicalUri).toBe("/lakehouse/main/t1/data%20%281%29.parquet");
    expect(s.canonicalQuery).toBe("list-type=2&prefix=main%2F");
    expect(s.authorization).toContain("Credential=AKID/20260904/us-east-1/s3/aws4_request");
    expect(s.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(s.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("is deterministic and changes with the secret", () => {
    const req = {
      method: "GET",
      cfg,
      key: "",
      query: {},
      payloadHash: "abc",
      amzDate: "20260904T120000Z",
    };
    expect(signS3(req).authorization).toBe(signS3(req).authorization);
    expect(signS3({ ...req, cfg: { ...cfg, secret: "OTHER" } }).authorization).not.toBe(
      signS3(req).authorization,
    );
  });
});

describe("backup & restore: scripts and docs agree", () => {
  const pkg = JSON.parse(rd("package.json"));
  const deployment = rd("docs/DEPLOYMENT.md");
  const inApp = rd("src/routes/docs.self-hosting.tsx");
  const backup = rd("scripts/backup.mjs");
  const restore = rd("scripts/restore.mjs");

  it("npm run backup / restore exist and point at the scripts", () => {
    expect(pkg.scripts.backup).toBe("node scripts/backup.mjs");
    expect(pkg.scripts.restore).toBe("node scripts/restore.mjs");
  });

  it("neither doc set still claims a single stateful component", () => {
    expect(deployment).not.toContain("single stateful component");
    expect(inApp).not.toContain("Supabase holds all durable state");
  });

  it("both doc sets name all four stateful things and the drill", () => {
    for (const doc of [deployment, inApp]) {
      expect(doc).toContain("npm run backup");
      expect(doc).toContain("lakehouse catalog");
      expect(doc).toContain("Parquet");
      expect(doc).toContain("PROVIDER_CREDS_SECRET");
      expect(doc).toContain("PROVENANCE_SIGNING_SECRET");
      expect(doc).toContain("--drill");
    }
  });

  it("restore refuses to run without --yes and never deletes outside its own drill prefix", () => {
    expect(restore).toContain("if (!drill && !yes)");
    expect(restore).toContain("process.exit(2)");
    // s3Delete is only reached inside the drill cleanup.
    const deletes = restore.split("s3Delete(").length - 1;
    expect(deletes).toBe(1);
    expect(restore).toContain("if (drill) {\n        for (const u of uploaded) await s3Delete(");
  });

  it("backup runs every catalog dump through checkCatalogDump", () => {
    expect(backup).toContain("checkCatalogDump(");
  });

  it("backup never prompts: without a database credential it skips and says how", () => {
    expect(backup).toContain("this script never prompts and never hangs");
    expect(backup).toContain("no database credential");
    expect(backup).toContain("SECRETS-REQUIRED.txt");
    expect(backup).not.toMatch(/readline|prompt\(/);
  });
});
