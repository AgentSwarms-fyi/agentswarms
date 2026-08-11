// The server's local SQL engine must not be able to read the server's files.
//
// FOUND BY MEASUREMENT while adding Parquet support. The read-only guard
// (sqlSafety) rejects INSERT/UPDATE/DROP/ATTACH and stacked statements. Every
// one of DuckDB's file-reading table functions is an ordinary SELECT and sails
// straight past it. Against this exact build, with the settings the engine
// used to run with:
//
//   SELECT content FROM read_text('…/.env')  -> "PROVIDER_CREDS_SECRET=hunter2…"
//   SELECT * FROM read_csv('…/.env')         -> the same file, as rows
//   SELECT file FROM glob('…/*')             -> a directory listing
//
// Reachable from the scheduled BI widget refresh (widget SQL is user-written),
// prep flows, the semantic runner, and the agent's `sql_query` tool — which
// runs SQL a LANGUAGE MODEL wrote. A prompt injection that gets a model to
// emit read_text is an arbitrary file read on the host.
//
// These tests call runLocalSqlDuckDB itself. Reproducing the settings here and
// asserting against the copy would prove only that the copy is safe.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fwd = (p: string) => p.split("\\").join("/");

let dir: string;
let cache: string;
let secret: string;
let mirror: string;
let runLocalSqlDuckDB: typeof import("@/utils/data/duckdb.server").runLocalSqlDuckDB;

beforeAll(async () => {
  dir = fwd(mkdtempSync(join(tmpdir(), "sandbox-test-")));
  cache = `${dir}/cache`;
  mkdirSync(cache, { recursive: true });
  secret = `${dir}/pretend.env`;
  mirror = `${cache}/mirror.parquet`;
  writeFileSync(secret, "PROVIDER_CREDS_SECRET=hunter2\nSUPABASE_SERVICE_ROLE_KEY=abc.def\n");

  // The engine reads this at instance creation, so it must be set before the
  // module is imported — the instance is created once per process.
  process.env.PARQUET_CACHE_DIR = cache;
  const mod = await import("@/utils/data/duckdb.server");
  runLocalSqlDuckDB = mod.runLocalSqlDuckDB;

  // A real Parquet file inside the cache, written through the engine itself,
  // so the "legitimate read still works" case is not a fixture of its own.
  await mod.writeTableToParquet(
    {
      name: "seed",
      columns: [
        { name: "id", type: "number" },
        { name: "label", type: "string" },
      ],
      rows: [
        { id: 1, label: "a" },
        { id: 2, label: "b" },
      ],
    },
    mirror,
  );
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run and report only whether it succeeded — the message differs by platform. */
async function attempt(sql: string): Promise<{ ok: boolean; err?: string }> {
  try {
    await runLocalSqlDuckDB(sql, []);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

describe("the local engine cannot read the server's filesystem", () => {
  it("refuses read_text on a file outside the cache", async () => {
    const r = await attempt(`SELECT content FROM read_text('${secret}')`);
    expect(r.ok, "read_text returned a file it should not have").toBe(false);
    expect(r.err).toMatch(/permission|not allowed|cannot access/i);
  });

  it("refuses read_csv on the same file", async () => {
    // The one that matters most: .env parses as CSV perfectly well.
    const r = await attempt(`SELECT * FROM read_csv('${secret}', header=false)`);
    expect(r.ok).toBe(false);
  });

  it("refuses glob, so the filesystem cannot even be enumerated", async () => {
    const r = await attempt(`SELECT file FROM glob('${dir}/*')`);
    expect(r.ok).toBe(false);
  });

  it("refuses to escape the cache with ..", async () => {
    // An allow-list that can be walked out of is not an allow-list.
    const r = await attempt(`SELECT content FROM read_text('${cache}/../pretend.env')`);
    expect(r.ok).toBe(false);
  });

  it("refuses outbound HTTP, closing SSRF through the SQL engine", async () => {
    // enable_external_access covers the network as well as the disk, so
    // read_csv('http://169.254.169.254/…') cannot reach cloud metadata.
    const r = await attempt(
      "SELECT * FROM read_csv('http://169.254.169.254/latest/meta-data/iam/security-credentials/')",
    );
    expect(r.ok).toBe(false);
  });

  it("refuses to write anywhere, including the cache", async () => {
    // COPY is caught by the read-only guard before the sandbox is reached;
    // both layers are meant to stop it and this pins that at least one does.
    const r = await attempt(`COPY (SELECT 1) TO '${dir}/out.parquet' (FORMAT PARQUET)`);
    expect(r.ok).toBe(false);
  });
});

describe("and still does everything it is supposed to", () => {
  it("reads the Parquet mirror, which lives inside the allowed directory", async () => {
    // The guard on the guard. A blanket ban would pass every test above and
    // cost a 250x slowdown by disabling the mirror — so this asserts the
    // sandbox is narrow, not merely closed.
    const res = await runLocalSqlDuckDB(`SELECT id, label FROM read_parquet('${mirror}')`, []);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ id: 1, label: "a" });
  });

  it("runs ordinary SQL over registered tables", async () => {
    const res = await runLocalSqlDuckDB("SELECT sum(v) AS total FROM t", [
      {
        name: "t",
        columns: [{ name: "v", type: "number" }],
        rows: [{ v: 2 }, { v: 3 }, { v: 4 }],
      },
    ]);
    expect(Number(res.rows[0].total)).toBe(9);
  });

  it("runs window functions, which is why DuckDB is here at all", async () => {
    const res = await runLocalSqlDuckDB(
      "SELECT v, sum(v) OVER (ORDER BY v ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM t ORDER BY v",
      [
        {
          name: "t",
          columns: [{ name: "v", type: "number" }],
          rows: [{ v: 1 }, { v: 2 }, { v: 3 }],
        },
      ],
    );
    expect(res.rows.map((r) => Number(r.running))).toEqual([1, 3, 6]);
  });

  it("keeps enforcing the read-only guard as well", async () => {
    // Two independent controls. The sandbox is not a reason to relax the one
    // that was already there.
    await expect(runLocalSqlDuckDB("DROP TABLE t", [])).rejects.toThrow(/read-only/i);
    await expect(runLocalSqlDuckDB("SELECT 1; SELECT 2", [])).rejects.toThrow(/single SQL/i);
  });
});

describe("the sandbox is applied in the only order that works", () => {
  // Structural, not behavioural, and deliberately so: the instance is created
  // once per process, so a setup FAILURE cannot be provoked from the public
  // API after the engine has already started. Mutation testing found this gap
  // — wrapping configureSandbox in `.catch(() => {})` left every behavioural
  // test above passing while the engine would silently run unsandboxed.
  const SRC = readFileSync("src/utils/data/duckdb.server.ts", "utf8");
  const setup = SRC.slice(SRC.indexOf("async function configureSandbox"));

  it("refuses to start when the sandbox cannot be applied", () => {
    expect(SRC).toMatch(/await configureSandbox\(instance\);/);
    expect(SRC, "a sandbox failure is being swallowed").not.toMatch(
      /configureSandbox\([^)]*\)\s*\.catch/,
    );
  });

  it("locks the configuration LAST", () => {
    // lock_configuration freezes every other option. Applied early it would
    // refuse allowed_directories and enable_external_access, leaving the
    // engine open while looking configured.
    const dirs = setup.indexOf("allowed_directories");
    const ext = setup.indexOf("enable_external_access");
    const lock = setup.indexOf("lock_configuration");
    expect(dirs).toBeGreaterThan(-1);
    expect(ext).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(dirs, "allowed_directories must precede the lock").toBeLessThan(lock);
    expect(ext, "enable_external_access must precede the lock").toBeLessThan(lock);
  });

  it("sets the resource caps before locking, or they would be refused", () => {
    const mem = setup.indexOf("memory_limit");
    const threads = setup.indexOf("threads=");
    const lock = setup.indexOf("lock_configuration");
    expect(mem).toBeLessThan(lock);
    expect(threads).toBeLessThan(lock);
    // And they must no longer be issued per query, where the lock rejects them.
    const perQuery = SRC.slice(SRC.indexOf("export async function runLocalSqlDuckDB"));
    expect(perQuery, "a per-query SET would now throw").not.toMatch(/SET memory_limit/);
  });

  it("allows exactly the mirror cache, from the same definition the mirror uses", () => {
    // Two definitions of "the cache" would mean allowing a directory the
    // mirror does not use, or refusing the one it does.
    expect(setup).toContain("cacheDir()");
    const PARQUET = readFileSync("src/utils/data/parquet.server.ts", "utf8");
    expect(PARQUET).toMatch(/export function cacheDir\(\)/);
  });
});
