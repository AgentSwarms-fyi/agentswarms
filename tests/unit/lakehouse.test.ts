// Lakehouse: the statement governor (classification + refusals), the catalog
// URL translation, and wiring pins on the lines a refactor would silently
// break — the postgres: attach prefix chief among them, because DuckLake
// treats its absence as "make me a single-writer FILE catalog", the exact
// opposite of the multi-replica design (found live, pinned forever).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  catalogUrlToLibpq,
  classifyStatement,
  isWriteConflict,
  stripSqlComments,
} from "@/utils/lakehouse/core.server";
import { nextMatviewRunAt } from "@/utils/lakehouse/matviews.server";
import { bindFilterPlaceholders, securedSubquery } from "@/utils/lakehouse/policies.server";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("classifyStatement", () => {
  it("classifies the read family as select", () => {
    for (const sql of [
      "SELECT 1",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "FROM analytics.orders SELECT *",
      "DESCRIBE analytics.orders",
      "SUMMARIZE analytics.orders",
      "SHOW TABLES",
    ]) {
      expect(classifyStatement(sql).kind).toBe("select");
    }
  });

  it("extracts the write target schema and requires qualification", () => {
    expect(classifyStatement("INSERT INTO sales.orders VALUES (1)")).toMatchObject({
      kind: "dml",
      writeSchemas: ["sales"],
    });
    expect(classifyStatement('UPDATE "Sales".orders SET x = 1')).toMatchObject({
      writeSchemas: ["Sales"],
    });
    expect(classifyStatement("CREATE TABLE a.t (x INT)").kind).toBe("ddl");
    expect(classifyStatement("DROP TABLE IF EXISTS a.t").writeSchemas).toEqual(["a"]);
    expect(classifyStatement("MERGE INTO a.t USING b ON 1=1").kind).toBe("dml");
    expect(() => classifyStatement("DELETE FROM orders")).toThrow(/schema-qualified/);
    expect(() => classifyStatement("CREATE TABLE t (x INT)")).toThrow(/schema-qualified/);
  });

  it("refuses everything outside the allowed surface", () => {
    for (const sql of [
      "ATTACH 'x.db' AS y",
      "SET threads = 1",
      "PRAGMA database_list",
      "INSTALL httpfs",
      "COPY a.t TO 'out.csv'",
      "EXPORT DATABASE 'd'",
      "CALL pragma_version()",
      "CREATE SCHEMA hax",
      "DROP SCHEMA a",
      "BEGIN TRANSACTION",
    ]) {
      expect(() => classifyStatement(sql)).toThrow(/not available/);
    }
  });

  it("one statement per request; comments don't smuggle a second one", () => {
    expect(() => classifyStatement("SELECT 1; SELECT 2")).toThrow(/One statement/);
    expect(classifyStatement("SELECT 1; -- trailing comment\n").kind).toBe("select");
    expect(stripSqlComments("SELECT 1 /* ; DROP TABLE a.t */")).not.toContain("DROP");
  });
});

describe("catalogUrlToLibpq", () => {
  it("translates url parts into libpq keywords", () => {
    expect(catalogUrlToLibpq("postgres://u:p%40ss@db.example.com:5433/cat?sslmode=require")).toBe(
      "dbname=cat host=db.example.com port=5433 user=u password=p@ss sslmode=require",
    );
  });
});

describe("lakehouse as a warehouse provider", () => {
  it("is registered in the provider list, labels and wire-family map", () => {
    const types = read("src/utils/warehouse/types.ts");
    expect(types).toContain('"lakehouse",');
    expect(types).toContain('lakehouse: "AgentSwarms Lakehouse (built-in)"');
    expect(types).toContain('lakehouse: "own"');
  });

  it("the DB provider CHECK and the app agree on lakehouse", () => {
    const sql = read("supabase/migrations/20260841000000_lakehouse_provider.sql");
    expect(sql).toContain("'lakehouse'");
    expect(sql).toContain("data_warehouse_connections_provider_check");
  });

  it("the driver routes lakehouse through the governed chokepoint, as the owner", () => {
    const drivers = read("src/utils/warehouse/drivers.server.ts");
    // Query, table listing and the connection test all branch to the engine.
    expect(drivers).toContain('config.provider === "lakehouse"');
    expect(drivers).toContain("runLakehouseStatement(config.user_id");
    expect(drivers).toContain('auditVia: "warehouse-connection"');
    // Owner is REQUIRED — a connection without one is a bug, not a fallback.
    expect(drivers.split("missing its owner").length).toBeGreaterThanOrEqual(2);
  });

  it("save stamps the owner and needs no credentials", () => {
    const fns = read("src/utils/warehouse.functions.ts");
    expect(fns).toContain('z.object({ provider: z.literal("lakehouse") })');
    expect(fns).toContain('{ provider: "lakehouse", user_id: userId }');
  });

  it("agents reach it through warehouse_query, running as the connection owner", () => {
    const registry = read("src/utils/tools/registry.server.ts");
    // The agent tool resolves via the shared loader (owner config) and runs
    // through executeWarehouseQuery — no lakehouse-specific agent code.
    expect(registry).toContain("loadWarehouseConnectionForUser");
    expect(registry).toContain("executeWarehouseQuery(conn.config");
    // The driver returns internal {columns, data:[][]}, reshaped to objects at
    // the public boundary — the standard warehouse result contract.
    const drivers = read("src/utils/warehouse/drivers.server.ts");
    expect(drivers).toContain("data: res.rows,");
  });

  it("the catalog crawls it via the same warehouse path with real row counts", () => {
    const crawler = read("src/utils/catalog/crawler.server.ts");
    expect(crawler).toContain('config.provider === "lakehouse"');
    // Counts come from the engine, access-scoped to the owner's grants.
    expect(crawler).toContain("accessibleSchemas(config.user_id)");
  });
});

describe("data-lake mounts", () => {
  it("mount views are server-authored — user SQL never names a path", () => {
    const fns = read("src/utils/lakehouse.functions.ts");
    // The reader call lives inside a CREATE VIEW the server writes...
    expect(fns).toContain("CREATE OR REPLACE VIEW");
    expect(fns).toContain("read_parquet");
    expect(fns).toContain("read_csv_auto");
    // ...while the query governor still refuses table functions in user SQL.
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("is not available here — query lakehouse tables");
  });

  it("each mount's credential is SCOPED to its own bucket and prefix", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    const fn = core.slice(core.indexOf("export async function ensureLakeSecrets"));
    // Two credential types now (S3-family and Azure), and BOTH must carry a
    // SCOPE built from the container/bucket and the prefix -- a secret without
    // one would let a mount read a sibling mount's files under the same cloud.
    expect(fn).toContain("SCOPE ${sq(`az://${cfg.bucket}${cleanPrefix}`)}");
    expect(fn).toContain("SCOPE ${sq(`s3://${cfg.bucket}${cleanPrefix}`)}");
    expect(fn).toContain("cfg.prefix");
    // Every CREATE SECRET path scopes: no branch may build `parts` without it.
    const branches = fn.split("parts = [").slice(1);
    expect(branches.length).toBeGreaterThanOrEqual(2);
    for (const b of branches) expect(b.slice(0, 600)).toContain("SCOPE ${sq(");
    // One secret per mount, named by its id — never one shared credential.
    expect(fn).toContain('lake_mount_${mount.id.replace(/-/g, "")}');
  });

  it("writes into a lake mount are refused, reads are not", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    const i = core.indexOf('if (classified.kind !== "select")');
    const guard = core.slice(i, i + 700);
    expect(guard).toContain("row?.lake_source_id");
    expect(guard).toContain("read-only data-lake mount");
  });

  it("the mount column cascades with its storage source", () => {
    const sql = read("supabase/migrations/20260842000000_lakehouse_lake_mounts.sql");
    expect(sql).toContain("REFERENCES public.catalog_sources(id) ON DELETE CASCADE");
  });
});

describe("lakehouse maintenance", () => {
  it("runs the four steps in the only safe order", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    const fn = core.slice(core.indexOf("export async function runLakehouseMaintenance"));
    const order = ["flush_inlined", "merge_files", "expire_snapshots", "cleanup_files"];
    let last = -1;
    for (const step of order) {
      const at = fn.indexOf(`"${step}"`);
      expect(at, `${step} missing`).toBeGreaterThan(last);
      last = at;
    }
    // Snapshots are expired only past a retention window, never immediately.
    expect(fn).toContain("SNAPSHOT_RETENTION_DAYS");
  });

  it("one failing step never blocks the others, and never the sweep", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    const fn = core.slice(core.indexOf("export async function runLakehouseMaintenance"));
    expect(fn).toContain("steps.push({ step, ok: false");
    const refresh = read("src/utils/bi/refresh.server.ts");
    expect(refresh).toContain("runLakehouseMaintenance");
    expect(refresh).toContain('console.warn("[lakehouse] maintenance pass failed:');
  });
});

describe("lakehouse wiring", () => {
  it("the attach carries the postgres: prefix — a file catalog is the bug, not a mode", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("'ducklake:postgres:${catalogUrlToLibpq");
  });

  it("compression is zstd and the engine refuses to boot half-configured", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("'parquet_compression', 'zstd'");
    expect(core).toContain("enginePromise = null");
  });

  it("every statement lands in history AND the audit trail", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain('from("lakehouse_query_history")');
    expect(core).toContain("action: `lakehouse.${classified.kind}`");
    // Refusals record too — the error path calls the same recorder.
    expect(core).toContain('record("error", null, message)');
  });

  it("selects are checked via DuckDB's own parser, not regex", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("json_serialize_sql");
    expect(core).toContain('node.type === "BASE_TABLE"');
    // Pure generators pass; file/table functions are refused.
    expect(core).toContain('new Set(["range", "generate_series", "unnest"])');
  });

  it("the migration is owner-read-only with the grant type registered", () => {
    const sql = read("supabase/migrations/20260840000000_lakehouse.sql");
    expect(sql).toContain("ALTER TABLE public.lakehouse_schemas ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("'lakehouse_schema'");
    expect(sql).toContain("has_resource_access('lakehouse_schema', id, auth.uid())");
    expect(sql).not.toMatch(/lakehouse_schemas FOR (ALL|INSERT|UPDATE|DELETE)/);
  });

  it("import honours the platform's dataset access rule (owner, sample, or grant)", () => {
    const fns = read("src/utils/lakehouse.functions.ts");
    expect(fns).toContain("!table.is_sample && table.user_id !== userId");
    expect(fns).toContain('rtype: "data_table"');
  });

  it("the page is reachable from the sidebar under Data & BI", () => {
    const nav = read("src/lib/appNav.ts");
    expect(nav).toContain('url: "/lakehouse"');
    const etlIdx = nav.indexOf('url: "/etl"');
    expect(nav.indexOf('url: "/lakehouse"')).toBeGreaterThan(etlIdx);
  });

  it("NL2SQL builds its schema context through the same access check as queries", () => {
    const gen = read("src/routes/api/lakehouse.generate.ts");
    expect(gen).toContain("accessibleSchemas(user.id)");
    expect(gen).toContain("lakehouse.nl2sql");
    // Draft only — nothing executes in the generate route.
    expect(gen).not.toContain("runLakehouseStatement");
  });
});

describe("performance surfaces", () => {
  it("bounds memory AND gives the engine somewhere to spill", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    // All three must be set together. A memory limit with no temp directory
    // is worse than no limit at all: DuckDB fails the query rather than
    // spilling, so a big GROUP BY becomes an error instead of a slow answer.
    expect(core).toContain("SET memory_limit=");
    expect(core).toContain("SET temp_directory=");
    expect(core).toContain("SET max_temp_directory_size=");
    // The memory limit now arrives from the resolver (Admin -> Developer
    // runtime, then the env var), so the engine no longer reads the variable
    // itself; the spill ceiling is still a deploy-time knob.
    expect(core).toContain("resources.lakehouseMemoryLimit");
    expect(core).toContain("LAKEHOUSE_SPILL_LIMIT");
    expect(read("src/utils/notebookRuntime/config.server.ts")).toContain("LAKEHOUSE_MEMORY_LIMIT");
    // Windows backslashes are not legal inside a DuckDB path literal.
    expect(core).toMatch(/temp_directory=\$\{sq\(spillDir\.replace\(/);
  });

  it("keys the result cache on the catalog snapshot so writes invalidate it", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    // The snapshot id in the key is the whole invalidation strategy: a commit
    // bumps it, which makes every older key unreachable. Swapping this for a
    // TTL would serve stale rows after a write.
    expect(core).toContain("function cacheKey(userId: string, sql: string, snapshot: string)");
    expect(core).toContain("currentSnapshotId");
    expect(core).toContain("lake.snapshots()");
  });

  it("checks access BEFORE consulting the cache", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    const check = core.indexOf("assertSchemasAllowed(schemas, allowed)");
    const lookup = core.indexOf("const hit = cacheGet(key)");
    expect(check).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);
    // Reversing these would serve cached rows to a user whose grant was
    // revoked — the cache would become an access-control bypass.
    expect(lookup).toBeGreaterThan(check);
  });

  it("only caches reads, and never an unbounded result", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain('if (classified.kind === "select")');
    expect(core).toContain("if (result.rows.length > CACHE_MAX_ROWS) return;");
    expect(core).toContain("CACHE_MAX_ENTRIES");
    // Callers that must not see a cached answer can opt out.
    expect(core).toContain("opts?.useCache !== false");
  });

  it("records cache hits in history and in the audit detail", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("cached: extra?.cached ?? false");
    expect(core).toContain("cached: extra?.cached ? true : undefined");
    const sql = read("supabase/migrations/20260843000000_lakehouse_perf.sql");
    expect(sql).toContain("cached boolean NOT NULL DEFAULT false");
  });

  it("reads partitioning from DuckLake's metadata rather than app bookkeeping", () => {
    const fns = read("src/utils/lakehouse.functions.ts");
    // A user can ALTER TABLE from the SQL editor, so anything we recorded
    // ourselves would drift. Only the catalog is authoritative.
    expect(fns).toContain("ducklake_partition_info");
    expect(fns).toContain("ducklake_partition_column");
    expect(fns).toContain("ORDER BY pc.partition_key_index");
    expect(fns).toContain("end_snapshot IS NULL");
  });

  it("partitioning refuses lake mounts and is capped and audited", () => {
    const fns = read("src/utils/lakehouse.functions.ts");
    expect(fns).toContain("SET PARTITIONED BY");
    expect(fns).toContain("RESET PARTITIONED BY");
    expect(fns).toContain("schemaRow.lake_source_id");
    // A high-cardinality key would write one file per row; four is already
    // generous for a Parquet layout.
    expect(fns).toContain("z.array(z.string().regex(TABLE_NAME)).max(4)");
    expect(fns).toContain('action: "lakehouse.partitioning"');
  });

  it("profiling runs the same access check and refuses writes", () => {
    const fns = read("src/utils/lakehouse.functions.ts");
    // EXPLAIN ANALYZE EXECUTES the statement, so profiling a DELETE would
    // delete. Reads only, and through the same schema gate as a query.
    expect(fns).toContain('if (classified.kind !== "select")');
    expect(fns).toContain(
      "assertSchemasAllowed(await selectReferencedSchemas(c, data.sql), allowed)",
    );
    expect(fns).toContain("EXPLAIN ANALYZE ${clean}");
    expect(fns).toContain('action: "lakehouse.profile"');
    // Profiling must be turned back off or the connection keeps emitting it.
    expect(fns).toContain("SET enable_profiling=false");
  });

  it("the UI exposes all four surfaces", () => {
    const page = read("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain("Explain");
    expect(page).toContain("Query profile");
    expect(page).toContain("rows scanned");
    expect(page).toContain("partitioned by");
    expect(page).toContain("PartitionDialog");
    // The cached badge is how a user knows a 3 ms answer is not a broken one.
    expect(page).toContain("result.cached &&");
  });
});

describe("write-conflict retry", () => {
  it("recognises the engine's real conflict text and nothing else", () => {
    // Captured from two independent engines racing on the same row.
    expect(
      isWriteConflict(
        "TransactionContext Error: Failed to commit: Failed to commit DuckLake transaction.",
      ),
    ).toBe(true);
    expect(isWriteConflict("Transaction conflict detected")).toBe(true);
    // Retrying any of these would just fail again, slower.
    for (const other of [
      'Catalog Error: Table with name "orders" does not exist!',
      'Parser Error: syntax error at or near "SELCT"',
      'No access to schema "finance"',
      "Out of Memory Error: could not allocate block",
    ]) {
      expect(isWriteConflict(other)).toBe(false);
    }
  });

  it("retries writes only, on a fresh connection, with bounded backoff", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    // A SELECT never commits, so it can never lose a commit race.
    expect(core).toContain('classified.kind !== "select" && isWriteConflict(message)');
    // Retrying on the snapshot that just lost would lose again — the loop must
    // reopen the connection so the next attempt reads the catalog as it is now.
    expect(core).toContain("c = await lakehouseConnection();");
    expect(core).toContain("c.closeSync();\n        c = null;");
    expect(core).toContain("function retryDelayMs");
    expect(core).toContain("WRITE_RETRIES");
  });

  it("replaces engine jargon with something a user can act on", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("Another write reached this table first");
    // The promise the message makes must match the engine's actual behaviour:
    // a losing commit applies nothing (verified live with a 500-row insert
    // bundled into the losing transaction).
    expect(core).toContain("nothing was applied");
  });

  it("records retries so contention is visible before it becomes failure", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("retries: extra?.retries ?? 0");
    expect(core).toContain("retries: extra?.retries || undefined");
    const sql = read("supabase/migrations/20260844000000_lakehouse_retries.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0");
  });

  it("exposes DuckLake's own commit-retry knobs", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("SET ducklake_max_retry_count=");
    expect(core).toContain("SET ducklake_retry_wait_ms=");
    expect(core).toContain("LAKEHOUSE_COMMIT_RETRIES");
  });
});

describe("row and column security", () => {
  const policy = {
    id: "p1",
    schema_name: "analytics",
    table_name: "orders",
    row_filter: "owner_email = @me",
    masked_columns: ["salary"],
    mask_style: "null" as const,
  };
  const columns = [
    { name: "id", type: "INTEGER" },
    { name: "owner_email", type: "VARCHAR" },
    { name: "salary", type: "DECIMAL(10,2)" },
  ];
  const reader = { id: "00000000-0000-0000-0000-000000000009", email: "reader@example.com" };

  it("binds the reader's identity into the filter as escaped literals", () => {
    expect(bindFilterPlaceholders("owner_email = @me", reader)).toBe(
      "owner_email = 'reader@example.com'",
    );
    expect(bindFilterPlaceholders("uid = @user_id", reader)).toContain(
      "'00000000-0000-0000-0000-000000000009'",
    );
    // An apostrophe in an address must not end the literal and start SQL.
    expect(bindFilterPlaceholders("e = @me", { id: "x", email: "o'brien@example.com" })).toBe(
      "e = 'o''brien@example.com'",
    );
    // A reader with no email gets an empty string, which matches nothing —
    // never a filter that silently disappears.
    expect(bindFilterPlaceholders("e = @me", { id: "x", email: null })).toBe("e = ''");
  });

  it("masks by type: NULL always works, hash only where it is meaningful", () => {
    const sql = securedSubquery(columns, policy, reader);
    // DECIMAL cannot hold a hash, so it is blanked with its own type kept —
    // an untyped NULL would change the column's type for the reader.
    expect(sql).toContain('CAST(NULL AS DECIMAL(10,2)) AS "salary"');
    expect(sql).toContain("WHERE (owner_email = 'reader@example.com')");
    expect(sql).toContain('"id"');

    const hashed = securedSubquery(
      [{ name: "email", type: "VARCHAR" }],
      { ...policy, masked_columns: ["email"], mask_style: "hash" },
      reader,
    );
    // Text stays joinable and groupable while unreadable.
    expect(hashed).toContain('md5("email") AS "email"');

    // Hash is meaningless on a number, so it falls back to a typed NULL.
    const numeric = securedSubquery(
      [{ name: "amount", type: "DECIMAL(10,2)" }],
      { ...policy, masked_columns: ["amount"], mask_style: "hash" },
      reader,
    );
    expect(numeric).toContain('CAST(NULL AS DECIMAL(10,2)) AS "amount"');
  });

  it("emits no WHERE clause when the policy only masks columns", () => {
    const sql = securedSubquery(columns, { ...policy, row_filter: null }, reader);
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("CAST(NULL AS DECIMAL(10,2))");
  });

  it("rewrites the AST, not the SQL text", () => {
    const pol = read("src/utils/lakehouse/policies.server.ts");
    // Text rewriting loses to comments, casing, aliases and CTEs; the parser
    // does not. Verified live against six evasion shapes.
    expect(pol).toContain("json_serialize_sql");
    expect(pol).toContain("json_deserialize_sql");
    expect(pol).toContain('rec.type === "BASE_TABLE"');
    // Synthesised nodes carry UINT64_MAX locations that JSON.parse rounds into
    // a value the deserialiser rejects — without this the rewrite dies.
    expect(pol).toContain("clampQueryLocations");
  });

  it("refuses rather than degrades when a policy cannot be applied", () => {
    const pol = read("src/utils/lakehouse/policies.server.ts");
    // The dangerous failure mode is running the query unfiltered.
    expect(pol).toContain("refusing to run unfiltered");
    expect(pol).toContain("could not be enforced — refused");
  });

  it("never filters the owner, and never leaks the rule to a reader", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("allowed.filter((sch) => sch.user_id !== userId)");
    const fns = read("src/utils/lakehouse.functions.ts");
    // getLakehousePolicy returns null unless the caller owns the schema.
    expect(fns).toContain("if (!schemaRow || schemaRow.user_id !== userId) return null;");
    expect(fns).toContain("Only the schema owner can set a security policy");
  });

  it("makes a policed table read-only for everyone but its owner", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    // A partial reader who could write would be able to destroy rows the
    // policy hides from them, without ever seeing what they hit.
    expect(core).toContain("is read-only for you");
    expect(core).toContain("classified.writeTables");
  });

  it("keys the cache on the applied policy", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    // Otherwise editing a policy could serve a pre-policy result.
    expect(core).toContain('cacheKey(userId, `${policyTables.join(",")}|${effectiveSql}`');
  });

  it("validates a filter against the real table before storing it", () => {
    const fns = read("src/utils/lakehouse.functions.ts");
    // A filter that fails to parse would otherwise be discovered by blocking
    // every reader at once.
    expect(fns).toContain("That row filter is not valid on this table");
    expect(fns).toContain("LIMIT 0");
    expect(fns).toContain('action: "lakehouse.policy"');
  });

  it("the policy table is owner-only at the database level too", () => {
    const sql = read("supabase/migrations/20260845000000_lakehouse_policies.sql");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("USING (user_id = auth.uid())");
    expect(sql).toContain("UNIQUE (user_id, schema_name, table_name)");
    expect(sql).toContain("mask_style IN ('null', 'hash')");
  });

  it("exposes security in the table UI", () => {
    const page = read("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain("PolicyDialog");
    expect(page).toContain("secured");
    expect(page).toContain("Rows they can see");
    expect(page).toContain("Columns they can&apos;t read");
  });
});

describe("materialized views", () => {
  it("schedules forward, and never schedules a manual view", () => {
    const from = new Date("2026-03-01T10:00:00.000Z");
    expect(nextMatviewRunAt("manual", from)).toBeNull();
    expect(nextMatviewRunAt("hourly", from)).toBe("2026-03-01T11:00:00.000Z");
    expect(nextMatviewRunAt("daily", from)).toBe("2026-03-02T10:00:00.000Z");
    expect(nextMatviewRunAt("weekly", from)).toBe("2026-03-08T10:00:00.000Z");
  });

  it("refreshes in one commit, so readers never see a half-built table", () => {
    const mv = read("src/utils/lakehouse/matviews.server.ts");
    // Anything staged — DROP then CREATE, or INSERT in batches — would expose
    // an empty or partial table to anyone querying during the rebuild.
    expect(mv).toContain("CREATE OR REPLACE TABLE");
    expect(mv).not.toContain("DROP TABLE");
    expect(mv).not.toContain("DELETE FROM");
  });

  it("re-checks the definition at every refresh, not only when it was saved", () => {
    const mv = read("src/utils/lakehouse/matviews.server.ts");
    // A grant revoked since the view was written must stop the schedule, and a
    // definition edited into a write must never execute as one.
    expect(mv).toContain('if (classified.kind !== "select")');
    expect(mv).toContain("A materialized view must be defined by a SELECT");
    expect(mv).toContain(
      "assertSchemasAllowed(await selectReferencedSchemas(c, view.sql), allowed)",
    );
  });

  it("runs as the view's owner, never as whoever triggered the sweep", () => {
    const mv = read("src/utils/lakehouse/matviews.server.ts");
    // A schedule has no session behind it; the author's grants are the only
    // defensible authority.
    expect(mv).toContain("accessibleSchemas(view.user_id)");
    expect(mv).toContain("userId: view.user_id");
  });

  it("claims each due view so replicas cannot double-refresh", () => {
    const mv = read("src/utils/lakehouse/matviews.server.ts");
    // Same compare-and-set the ETL scheduler uses: advancing the clock IS the
    // claim, so only the sweep that still sees the old value wins.
    expect(mv).toContain('claim.is("next_run_at", null)');
    expect(mv).toContain('claim.eq("next_run_at", row.next_run_at)');
    expect(mv).toContain("if (!won?.length) continue;");
  });

  it("keeps the previous data when a refresh fails", () => {
    const mv = read("src/utils/lakehouse/matviews.server.ts");
    // Stale data a user can see and diagnose beats an empty table.
    expect(mv).toContain('last_status: "error"');
    expect(mv).toContain("last_error: message.slice(0, 2000)");
    // The failure path must not touch the table itself.
    const failure = mv.slice(mv.indexOf("} catch (e) {"));
    expect(failure).not.toContain("c.run(");
  });

  it("rides the shared scheduler sweep", () => {
    const sweep = read("src/utils/bi/refresh.server.ts");
    expect(sweep).toContain("processDueMaterializedViews(force)");
    expect(sweep).toContain("matview_refreshes");
  });

  it("leaves the table behind when the view definition is removed", () => {
    const fns = read("src/utils/lakehouse.functions.ts");
    // Deleting a user's data because they removed a schedule would be the
    // wrong default; the table is an ordinary table they can drop themselves.
    expect(fns).toContain("table_kept: true");
    expect(fns).toContain("Only its owner can remove this view");
  });

  it("is owner-only to write and grant-readable to see", () => {
    const sql = read("supabase/migrations/20260846000000_lakehouse_matviews.sql");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("USING (user_id = auth.uid())");
    expect(sql).toContain("has_resource_access('lakehouse_schema', s.id, auth.uid())");
    expect(sql).toContain("UNIQUE (schema_name, table_name)");
  });

  it("is reachable from the query editor and the table view", () => {
    const page = read("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain("SaveMatviewDialog");
    expect(page).toContain("Save as view");
    expect(page).toContain("Rebuild");
    expect(page).toContain("rebuilt ${matview.schedule}");
  });
});

describe("parquet metadata cache", () => {
  it("caches file metadata on the shared engine, with an escape hatch", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("SET parquet_metadata_cache=true");
    expect(core).toContain('process.env.LAKEHOUSE_METADATA_CACHE !== "false"');
  });

  it("does not enable the siblings that measured worse", () => {
    const core = read("src/utils/lakehouse/core.server.ts");
    // Both were benchmarked: http metadata caching was slower and less
    // consistent, prefetching bought nothing. Turning them on "because they
    // sound like caching" would cost time and, for HTTP metadata, risk
    // staleness on lake mounts.
    expect(core).not.toContain("SET enable_http_metadata_cache=true");
    expect(core).not.toContain("SET prefetch_all_parquet_files=true");
  });
});
