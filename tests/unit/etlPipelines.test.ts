// ETL pipelines: the DAG compiler, the schedule arithmetic, the secret
// scrubbing, and source pins on wiring a refactor would silently drop.
//
// The compiler tests go one step further than shape checks: every generated
// script is fed to the local Python's compile() when one is available, because
// "looks like Python" and "parses as Python" diverge exactly at the quoting
// and indentation edges the injection tests probe.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compilePreview,
  previewRequirementsFor,
  analyzeGraph,
  compileGraph,
  codeTemplate,
  dbFamily,
  envKey,
  pyIdent,
  pyStr,
  requirementsFor,
  starterGraph,
  type EtlGraph,
  type EtlNode,
} from "@/utils/etl/codegen";
import {
  cdcSlotName,
  etlAlertPolicy,
  etlPrelude,
  nativeDestCreds,
  scrubSecrets,
  sqlalchemyUrlFor,
} from "@/utils/etl/service.server";
import { nextEtlRunAt } from "@/utils/etl/schedule.server";
import type { WarehouseConfig } from "@/utils/warehouse/types";

// ── Python syntax oracle (skips silently when no interpreter exists) ────────

function pythonBin(): string | null {
  for (const bin of ["python", "python3", "py"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}
const PY = pythonBin();

function assertParsesAsPython(code: string): void {
  if (!PY) return;
  const dir = mkdtempSync(join(tmpdir(), "etl-codegen-"));
  try {
    const file = join(dir, "gen.py");
    writeFileSync(file, code, "utf8");
    execFileSync(
      PY,
      ["-c", `compile(open(${JSON.stringify(file)}, encoding='utf8').read(), 'gen.py', 'exec')`],
      { stdio: "pipe" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Graph fixtures ──────────────────────────────────────────────────────────

const node = (id: string, kind: EtlNode["kind"], config: Record<string, unknown>): EtlNode => ({
  id,
  kind,
  config: config as EtlNode["config"],
});

const API_SRC = node("n1", "source", {
  type: "http_api",
  url: "https://api.example.com/items",
  records_path: "data.items",
});
const STORE_TGT = node("n9", "target", {
  type: "object_storage",
  dataset: "etl",
  table: "items",
  format: "parquet",
  write_mode: "replace",
});

function linear(...transforms: EtlNode[]): EtlGraph {
  const nodes = [API_SRC, ...transforms, STORE_TGT];
  const edges = nodes.slice(0, -1).map((n, i) => ({
    id: `e${i}`,
    from: n.id,
    to: nodes[i + 1].id,
  }));
  return { nodes, edges };
}

describe("compileGraph — DAG shapes", () => {
  it("compiles the starter graph to parseable Python", () => {
    const code = compileGraph(starterGraph());
    expect(code).toContain("def entrypoint(inputs=None):");
    assertParsesAsPython(code);
  });

  it("compiles every source type", () => {
    const sources = [
      { type: "object_storage", path: "raw/*.csv", format: "csv" },
      { type: "object_storage", path: "raw/book.xlsx", format: "xlsx" },
      { type: "database", mode: "table", table: "public.orders", provider: "postgres" },
      { type: "database", mode: "query", query: "SELECT 1", provider: "mysql" },
      { type: "http_api", url: "https://x.test/api" },
      { type: "python", code: "return [{'id': 1}]" },
    ];
    for (const cfg of sources) {
      const g: EtlGraph = {
        nodes: [node("n1", "source", cfg), STORE_TGT],
        edges: [{ id: "e1", from: "n1", to: "n9" }],
      };
      const code = compileGraph(g);
      assertParsesAsPython(code);
    }
  });

  it("compiles every transform type", () => {
    const code = compileGraph(
      linear(
        node("n2", "transform", { type: "filter", expr: "amount > 0" }),
        node("n3", "transform", { type: "select", columns: ["a", "b"] }),
        node("n4", "transform", { type: "rename", mapping: { a: "alpha" } }),
        node("n5", "transform", { type: "derive", column: "total", expr: "a * 2" }),
        node("n6", "transform", {
          type: "aggregate",
          group_by: ["alpha"],
          aggs: [{ column: "total", fn: "sum", as: "sum_total" }],
        }),
        node("n7", "transform", { type: "sort", by: ["sum_total"], descending: true }),
        node("n8", "transform", { type: "limit", n: 50 }),
      ),
    );
    for (const marker of ["query(", "rename(columns", "groupby", "sort_values", "head(50"]) {
      expect(code).toContain(marker);
    }
    assertParsesAsPython(code);
  });

  it("compiles a join of two sources and a union fan-in", () => {
    const g: EtlGraph = {
      nodes: [
        API_SRC,
        node("n2", "source", { type: "http_api", url: "https://y.test/api" }),
        node("n3", "transform", {
          type: "join",
          how: "left",
          left_on: ["id"],
          right_on: ["id"],
          left_node: "n1",
        }),
        STORE_TGT,
      ],
      edges: [
        { id: "e1", from: "n1", to: "n3" },
        { id: "e2", from: "n2", to: "n3" },
        { id: "e3", from: "n3", to: "n9" },
      ],
    };
    const code = compileGraph(g);
    expect(code).toContain(".merge(");
    expect(code).toContain("how='left'");
    assertParsesAsPython(code);
  });

  it("compiles multiple targets, each with its own load block", () => {
    const g: EtlGraph = {
      nodes: [
        API_SRC,
        STORE_TGT,
        node("n8", "target", {
          type: "database",
          provider: "postgres",
          dataset: "public",
          table: "items_copy",
          write_mode: "append",
        }),
      ],
      edges: [
        { id: "e1", from: "n1", to: "n9" },
        { id: "e2", from: "n1", to: "n8" },
      ],
    };
    const code = compileGraph(g);
    expect(code).toContain("filesystem(");
    expect(code).toContain("sqlalchemy_dest(os.environ['ETL_N8_URL'])");
    expect(code).toContain("'targets': _loads");
    assertParsesAsPython(code);
  });

  it("is deterministic — same graph, byte-identical output", () => {
    expect(compileGraph(starterGraph())).toBe(compileGraph(starterGraph()));
  });
});

describe("compileGraph — validation", () => {
  it("rejects a join without exactly two inputs", () => {
    const g: EtlGraph = {
      nodes: [
        API_SRC,
        node("n3", "transform", { type: "join", how: "inner", left_on: ["id"], right_on: ["id"] }),
        STORE_TGT,
      ],
      edges: [
        { id: "e1", from: "n1", to: "n3" },
        { id: "e2", from: "n3", to: "n9" },
      ],
    };
    expect(() => compileGraph(g)).toThrow(/two inputs/);
  });

  it("rejects cycles, disconnected nodes and missing sources/targets", () => {
    expect(() =>
      analyzeGraph({
        nodes: [
          API_SRC,
          node("n2", "transform", { type: "filter", expr: "x" }),
          node("n3", "transform", { type: "filter", expr: "x" }),
          STORE_TGT,
        ],
        edges: [
          { id: "e1", from: "n1", to: "n2" },
          { id: "e2", from: "n2", to: "n3" },
          { id: "e3", from: "n3", to: "n2" },
        ],
      }),
    ).toThrow(/exactly one input|cycle/);
    expect(() => analyzeGraph({ nodes: [API_SRC], edges: [] })).toThrow(/target/);
    expect(() => analyzeGraph({ nodes: [STORE_TGT], edges: [] })).toThrow(/source/);
    expect(() => analyzeGraph({ nodes: [API_SRC, STORE_TGT], edges: [] })).toThrow(
      /not connected|exactly one input/,
    );
  });

  it("refuses unsupported database providers with a message that names the way out", () => {
    const g: EtlGraph = {
      nodes: [
        node("n1", "source", { type: "database", mode: "table", table: "t", provider: "bigquery" }),
        STORE_TGT,
      ],
      edges: [{ id: "e1", from: "n1", to: "n9" }],
    };
    expect(() => compileGraph(g)).toThrow(/not supported.*object storage/i);
  });

  it("refuses merge without primary keys and bad identifiers", () => {
    const bad = {
      ...STORE_TGT,
      config: { ...(STORE_TGT.config as object), write_mode: "merge" },
    } as EtlNode;
    expect(() =>
      compileGraph({
        nodes: [API_SRC, bad],
        edges: [{ id: "e1", from: "n1", to: "n9" }],
      }),
    ).toThrow(/primary key/);
    expect(() => pyIdent("items; drop", "x")).toThrow(/identifier/);
  });
});

describe("compileGraph — injection resistance", () => {
  it("survives hostile strings in every pyStr position", () => {
    const hostile = `x' + __import__('os').system('true') + '`;
    const code = compileGraph(
      linear(
        node("n2", "transform", { type: "filter", expr: hostile }),
        node("n3", "transform", { type: "select", columns: [hostile] }),
        node("n4", "transform", { type: "rename", mapping: { [hostile]: hostile } }),
      ),
    );
    expect(code).not.toContain(`'x' + __import__`);
    expect(code).toContain("\\'");
    assertParsesAsPython(code);
  });

  it("newlines in a user string cannot break out of the literal", () => {
    const code = compileGraph(
      linear(node("n2", "transform", { type: "filter", expr: "a > 0\nimport os" })),
    );
    expect(code).toContain("\\nimport os");
    assertParsesAsPython(code);
  });

  it("pyStr escapes quotes, backslashes and both newline kinds", () => {
    expect(pyStr(`a'b`)).toBe(`'a\\'b'`);
    expect(pyStr(`a\\b`)).toBe(`'a\\\\b'`);
    expect(pyStr("a\r\nb")).toBe(`'a\\r\\nb'`);
  });

  it("the code template parses and carries the contract", () => {
    const t = codeTemplate();
    expect(t).toContain("def entrypoint(inputs=None):");
    expect(t).toContain("ETL_DEST_BUCKET_URL");
    assertParsesAsPython(t);
  });
});

describe("compileGraph — engine-managed incremental", () => {
  it("pushes a cursor filter into database sources and reports the watermark", () => {
    const g: EtlGraph = {
      nodes: [
        node("n1", "source", {
          type: "database",
          mode: "query",
          query: "SELECT * FROM orders",
          provider: "postgres",
          incremental: { cursor_column: "updated_at" },
        }),
        STORE_TGT,
      ],
      edges: [{ id: "e1", from: "n1", to: "n9" }],
    };
    const code = compileGraph(g);
    expect(code).toContain("ETL_N1_CURSOR");
    expect(code).toContain("> :cursor");
    expect(code).toContain("params={'cursor': cursor}");
    expect(code).toContain("_watermarks['n1']");
    expect(code).toContain("'watermarks': _watermarks");
    assertParsesAsPython(code);
  });

  it("filters storage-source rows above the cursor and keeps it on empty reads", () => {
    const g: EtlGraph = {
      nodes: [
        node("n1", "source", {
          type: "object_storage",
          path: "raw/*.csv",
          format: "csv",
          incremental: { cursor_column: "updated_at" },
        }),
        STORE_TGT,
      ],
      edges: [{ id: "e1", from: "n1", to: "n9" }],
    };
    const code = compileGraph(g);
    expect(code).toContain("ETL_N1_CURSOR");
    expect(code).toContain(".astype(str) > cursor");
    // Empty read → no watermark entry → the engine keeps the previous cursor.
    expect(code).toContain("if len(f_n1):");
    assertParsesAsPython(code);
  });

  it("emits no watermark machinery when nothing is incremental", () => {
    const code = compileGraph(starterGraph());
    expect(code).not.toContain("_watermarks");
  });
});

describe("requirementsFor", () => {
  it("collects per-node needs: drivers, formats, engines", () => {
    const g: EtlGraph = {
      nodes: [
        node("n1", "source", { type: "object_storage", path: "a.xlsx", format: "xlsx" }),
        node("n2", "source", { type: "database", mode: "table", table: "t", provider: "mysql" }),
        node("n3", "transform", { type: "join", how: "inner", left_on: ["id"], right_on: ["id"] }),
        node("n4", "transform", { type: "sql", query: "SELECT 1" }),
        node("n5", "target", {
          type: "database",
          provider: "postgres",
          dataset: "public",
          table: "out",
          write_mode: "replace",
        }),
      ],
      edges: [],
    };
    const reqs = requirementsFor(g);
    for (const expected of [
      "openpyxl",
      "s3fs",
      "pymysql",
      "psycopg2-binary",
      "sqlalchemy",
      "ibis-framework[duckdb]",
      "dlt[sqlalchemy]>=1.3",
    ]) {
      expect(reqs).toContain(expected);
    }
  });

  it("always includes a loader", () => {
    expect(requirementsFor(starterGraph())).toContain("dlt[filesystem]");
  });
});

describe("database URL building", () => {
  it("maps the three wire families and encodes credentials", () => {
    const pg = sqlalchemyUrlFor({
      provider: "postgres",
      host: "db.example.com",
      port: "5433",
      database: "app",
      username: "user@corp",
      password: "p@ss:word",
      ssl: "require",
    } as WarehouseConfig);
    expect(pg).toBe(
      "postgresql+psycopg2://user%40corp:p%40ss%3Aword@db.example.com:5433/app?sslmode=require",
    );

    const my = sqlalchemyUrlFor({
      provider: "mariadb",
      host: "m.example.com",
      database: "app",
      username: "u",
      password: "p",
    } as WarehouseConfig);
    expect(my).toBe("mysql+pymysql://u:p@m.example.com:3306/app");

    const ms = sqlalchemyUrlFor({
      provider: "sqlserver",
      host: "s.example.com",
      database: "app",
      username: "u",
      password: "p",
    } as WarehouseConfig);
    expect(ms).toBe("mssql+pymssql://u:p@s.example.com:1433/app");
  });

  it("refuses providers a URL cannot authenticate", () => {
    expect(() => sqlalchemyUrlFor({ provider: "snowflake" } as WarehouseConfig)).toThrow(
      /not supported/,
    );
    expect(dbFamily("bigquery")).toBeNull();
    expect(dbFamily("timescaledb")).toBe("postgres");
  });
});

describe("run environment hygiene", () => {
  it("envKey derives stable per-node stems", () => {
    expect(envKey("n3")).toBe("ETL_N3");
    expect(() => envKey("---")).toThrow();
  });

  it("the prelude fetches env over HTTP and installs requirements — no secrets in code", () => {
    const p = etlPrelude();
    expect(p).toContain("'part': 'etl_env'");
    expect(p).toContain("pip");
    expect(p).toContain("AGENTSWARMS_TOKEN");
    expect(p).not.toMatch(/SECRET_ACCESS_KEY\s*=\s*['"][^'"]/);
    assertParsesAsPython(p + "pass\n");
  });

  it("scrubSecrets removes every occurrence of every value", () => {
    const scrubbed = scrubSecrets("key=abc123 then abc123 again, other=zzzz", ["abc123", "zzzz"]);
    expect(scrubbed).not.toContain("abc123");
    expect(scrubbed).not.toContain("zzzz");
    expect(scrubbed).toContain("***");
  });

  it("scrubSecrets leaves text alone for trivially short values", () => {
    expect(scrubSecrets("a1 everywhere", ["a1"])).toBe("a1 everywhere");
  });
});

describe("nextEtlRunAt", () => {
  it("computes the three intervals and refuses manual", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(nextEtlRunAt("hourly", from)).toBe("2026-01-01T01:00:00.000Z");
    expect(nextEtlRunAt("daily", from)).toBe("2026-01-02T00:00:00.000Z");
    expect(nextEtlRunAt("weekly", from)).toBe("2026-01-08T00:00:00.000Z");
    expect(nextEtlRunAt("manual", from)).toBeNull();
  });
});

// ── Lakehouse nodes ─────────────────────────────────────────────────────────

describe("lakehouse pipeline nodes", () => {
  const g = (over: Record<string, unknown> = {}): EtlGraph => ({
    nodes: [
      node("s", "source", {
        type: "lakehouse",
        schema: "analytics",
        mode: "table",
        table: "orders",
      }),
      node("t", "target", {
        type: "lakehouse",
        schema: "analytics",
        table: "rollup",
        write_mode: "replace",
        ...over,
      }),
    ],
    edges: [{ from: "s", to: "t" }],
  });

  it("attaches the shared catalog from env and makes lake the current catalog", () => {
    const code = compileGraph(g());
    assertParsesAsPython(code);
    expect(code).toContain("ATTACH 'ducklake:postgres:");
    expect(code).toContain('con.execute("USE lake")');
    // No credential literal — everything arrives as env, like every connector.
    expect(code).toContain("os.environ['ETL_LAKEHOUSE_CATALOG']");
    expect(code).not.toMatch(/password=\w+/);
  });

  it("the extension directory dodges the sandbox's read-only HOME and noexec /tmp", () => {
    // Both were real failures: ~/.duckdb is read-only, and a .so downloaded
    // into /tmp cannot be mapped. ~/.local is writable AND executable.
    const code = compileGraph(g());
    expect(code).toContain("'.local', 'duckdb'");
    expect(code).not.toContain("tempfile.mkdtemp(prefix='duckdb-ext");
  });

  it("write modes compile to the right statements", () => {
    expect(compileGraph(g())).toContain("CREATE OR REPLACE TABLE");
    const append = compileGraph(g({ write_mode: "append" }));
    expect(append).toContain("CREATE TABLE IF NOT EXISTS");
    expect(append).toContain("INSERT INTO");
    const merge = compileGraph(g({ write_mode: "merge", primary_key: ["id"] }));
    // Upsert is delete-then-insert inside ONE transaction — a reader never
    // sees the gap.
    expect(merge).toContain("BEGIN TRANSACTION");
    expect(merge).toContain("DELETE FROM");
    expect(merge.indexOf("BEGIN TRANSACTION")).toBeLessThan(merge.indexOf("COMMIT"));
    expect(() => compileGraph(g({ write_mode: "merge" }))).toThrow(/primary key/);
  });

  it("needs duckdb and NOT dlt — a lakehouse pipeline never imports it", () => {
    const reqs = requirementsFor(g());
    expect(reqs).toContain("duckdb>=1.4");
    expect(reqs).not.toContain("dlt");
    expect(compileGraph(g())).not.toContain("import dlt");
  });

  it("schema access is checked server-side, as the pipeline owner", () => {
    const svc = read("src/utils/etl/service.server.ts");
    expect(svc).toContain("accessibleSchemas(pipeline.user_id)");
    expect(svc).toContain("no access to lakehouse schema");
    // The catalog string carries a password — it must be scrubbed from logs.
    expect(svc).toContain("secretValues.push(env.ETL_LAKEHOUSE_CATALOG");
  });

  it("lineage names the lakehouse table it read", () => {
    expect(compileGraph(g())).toContain("'lineage_sources': ['lakehouse:analytics.orders']");
  });
});

// ── Reverse ETL (HTTP targets) ──────────────────────────────────────────────

describe("http api targets", () => {
  const g = (over: Record<string, unknown> = {}): EtlGraph => ({
    nodes: [
      node("s", "source", { type: "python", code: "df = None" }),
      node("t", "target", {
        type: "http_api",
        url: "https://api.example.com/records",
        method: "POST",
        batch_size: 2,
        wrap_key: "records",
        auth_env: "MY_TOKEN",
        ...over,
      }),
    ],
    edges: [{ from: "s", to: "t" }],
  });

  it("batches rows, wraps them and sends the bound bearer", () => {
    const code = compileGraph(g());
    assertParsesAsPython(code);
    expect(code).toContain("range(0, len(_records), 2)");
    expect(code).toContain("_body = {'records': _chunk}");
    expect(code).toContain("os.environ['MY_TOKEN']");
    expect(code).toContain("_resp.raise_for_status()");
    expect(code).toContain("'fqn': 'http:https://api.example.com/records'");
    // No dlt destination machinery for this target.
    expect(code).not.toContain("filesystem(");
  });

  it("an unwrapped target posts the bare array and skips auth without a binding", () => {
    const code = compileGraph(g({ wrap_key: "", auth_env: undefined }));
    assertParsesAsPython(code);
    expect(code).toContain("_body = _chunk");
    expect(code).not.toContain("Authorization");
  });

  it("refuses a target with no URL", () => {
    expect(() => compileGraph(g({ url: "" }))).toThrow(/needs a URL/);
  });
});

// ── Streamed-row sources ────────────────────────────────────────────────────

describe("ingest sources", () => {
  const g: EtlGraph = {
    nodes: [
      node("s", "source", { type: "ingest" }),
      node("t", "target", {
        type: "object_storage",
        dataset: "stream",
        table: "events",
        format: "parquet",
        write_mode: "append",
      }),
    ],
    edges: [{ from: "s", to: "t" }],
  };

  it("drains over the session channel with the engine cursor, cdc-style", () => {
    const code = compileGraph(g);
    assertParsesAsPython(code);
    expect(code).toContain("'part': 'etl_ingest'");
    expect(code).toContain("os.environ.get('ETL_S_CURSOR')");
    // Previews must not consume the backlog.
    expect(code).toContain("os.environ.get('AGENTSWARMS_ETL_PREVIEW') != '1'");
    // The max staged id becomes the watermark for the next run's consume.
    expect(code).toContain("_watermarks['s'] = str(_ingest_last_s)");
  });

  it("the drain deletes at-or-below the cursor only when consuming", () => {
    const svc = read("src/utils/etl/service.server.ts");
    const fn = svc.slice(svc.indexOf("export async function etlIngestFor"));
    expect(fn).toContain('.lte("id", cursor)');
    expect(fn).toContain("opts.consume &&");
    const route = read("src/routes/api/notebook.runtime.source.ts");
    // Preview branch hard-codes consume: false regardless of the request.
    expect(route).toContain("etlIngestFor(stash.pipeline_id, claims.sub, { consume: false })");
  });

  it("the ingest endpoint authenticates like the trigger and caps its inputs", () => {
    const route = read("src/routes/api/etl.ingest.ts");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("rateLimitedGlobal");
    expect(route).toContain("MAX_BACKLOG");
    expect(route).not.toContain("Invalid token");
  });
});

// ── Change data capture ─────────────────────────────────────────────────────

const cdcGraph = (target: Record<string, unknown>, snapshot = true): EtlGraph => ({
  nodes: [
    node("s", "source", {
      type: "database",
      provider: "postgres",
      connection_id: "c1",
      mode: "cdc",
      table: "public.customers",
      initial_snapshot: snapshot,
    }),
    node("t", "target", target),
  ],
  edges: [{ from: "s", to: "t" }],
});

const deltaMergeTarget = {
  type: "object_storage",
  dataset: "mirror",
  table: "customers",
  format: "parquet",
  table_format: "delta",
  write_mode: "merge",
  primary_key: ["id"],
};

describe("change data capture", () => {
  it("peeks the slot, consumes only what the previous run durably loaded", () => {
    const code = compileGraph(cdcGraph(deltaMergeTarget));
    assertParsesAsPython(code);
    // Peek for reading; get (consume) ONLY up to the stored cursor.
    expect(code).toContain("pg_logical_slot_peek_changes");
    expect(code).toContain("pg_logical_slot_get_changes(:s, CAST(:lsn AS pg_lsn)");
    expect(code).toContain("os.environ.get('ETL_S_CURSOR')");
    // The slot name comes from the engine, not the graph.
    expect(code).toContain("os.environ.get('ETL_S_SLOT'");
    // Snapshot happens AFTER slot creation, so no change can fall in the gap.
    const created = code.indexOf("pg_create_logical_replication_slot");
    const snap = code.indexOf("SELECT * FROM public.customers");
    expect(created).toBeGreaterThan(-1);
    expect(snap).toBeGreaterThan(created);
  });

  it("a cdc-fed delta merge applies the log: upsert strategy + hard-delete pass", () => {
    const code = compileGraph(cdcGraph(deltaMergeTarget));
    expect(code).toContain("'strategy': 'upsert'");
    expect(code).toContain("'_cdc_deleted': {'hard_delete': True}");
    // dlt's delta upsert never deletes — the explicit pass after the load does.
    expect(code).toContain(`.delete("_cdc_deleted = true")`);
    expect(code.indexOf("pipe.run")).toBeLessThan(code.indexOf('.delete("_cdc_deleted'));
  });

  it("a plain-file target keeps the raw event log — no delete pass", () => {
    const code = compileGraph(
      cdcGraph({
        type: "object_storage",
        dataset: "log",
        table: "events",
        format: "parquet",
        write_mode: "append",
      }),
    );
    assertParsesAsPython(code);
    expect(code).not.toContain('.delete("_cdc_deleted');
  });

  it("cdc is refused off postgres families and without a table", () => {
    const bad = cdcGraph(deltaMergeTarget);
    (bad.nodes[0].config as { provider?: string }).provider = "mysql";
    expect(() => compileGraph(bad)).toThrow(/PostgreSQL-family/);
    const noTable = cdcGraph(deltaMergeTarget);
    (noTable.nodes[0].config as { table?: string }).table = "";
    expect(() => compileGraph(noTable)).toThrow(/needs a table/);
  });

  it("lineage names the captured table", () => {
    expect(compileGraph(cdcGraph(deltaMergeTarget))).toContain(
      "'lineage_sources': ['cdc:public.customers']",
    );
  });

  it("slot names are pipeline-scoped, sanitized and postgres-legal", () => {
    const slot = cdcSlotName("bdf8b21e-389f-4729-931f-71fd51986703", "Node-1");
    expect(slot).toBe("aswarm_bdf8b21e38_node1");
    expect(slot.length).toBeLessThanOrEqual(63);
    expect(slot).toMatch(/^[a-z0-9_]+$/);
  });
});

// ── Open-table formats ──────────────────────────────────────────────────────

const lakeGraph = (table_format?: string): EtlGraph => ({
  nodes: [
    node("s", "source", { type: "python", code: "df = None" }),
    node("t", "target", {
      type: "object_storage",
      dataset: "lake",
      table: "orders",
      format: "csv",
      ...(table_format ? { table_format } : {}),
      write_mode: "replace",
    }),
  ],
  edges: [{ from: "s", to: "t" }],
});

describe("open-table formats", () => {
  it("delta and iceberg ride the resource and force parquet materialisation", () => {
    for (const tf of ["delta", "iceberg"]) {
      const code = compileGraph(lakeGraph(tf));
      assertParsesAsPython(code);
      expect(code).toContain(`table_format='${tf}',`);
      // The chosen csv file format is overridden — table formats ARE parquet.
      expect(code).toContain("loader_file_format='parquet'");
      expect(code).not.toContain("loader_file_format='csv'");
    }
    const plain = compileGraph(lakeGraph());
    expect(plain).not.toContain("table_format=");
    expect(plain).toContain("loader_file_format='csv'");
  });

  it("lineage fqns follow each format's real on-disk layout", () => {
    expect(compileGraph(lakeGraph("delta"))).toContain("'fqn': 'lake/orders/*.parquet'");
    expect(compileGraph(lakeGraph("iceberg"))).toContain("'fqn': 'lake/orders/data/*.parquet'");
  });

  it("requirements pull the matching dlt extra", () => {
    expect(requirementsFor(lakeGraph("delta"))).toContain("dlt[deltalake]>=1.3");
    expect(requirementsFor(lakeGraph("iceberg"))).toContain("dlt[pyiceberg]>=1.3");
    expect(requirementsFor(lakeGraph())).not.toContain("deltalake");
  });
});

// ── Alert policy ────────────────────────────────────────────────────────────

describe("etlAlertPolicy", () => {
  it("pre-migration rows get failure+recovery on, success off", () => {
    expect(etlAlertPolicy({})).toEqual({
      on_failure: true,
      on_success: false,
      on_recovery: true,
    });
    expect(etlAlertPolicy({ alerts: null })).toEqual({
      on_failure: true,
      on_success: false,
      on_recovery: true,
    });
  });

  it("explicit choices are honored, including switching the defaults off", () => {
    expect(
      etlAlertPolicy({ alerts: { on_failure: false, on_success: true, on_recovery: false } }),
    ).toEqual({ on_failure: false, on_success: true, on_recovery: false });
  });

  it("junk in the column degrades to the defaults, not a crash", () => {
    expect(etlAlertPolicy({ alerts: "yes please" })).toEqual({
      on_failure: true,
      on_success: false,
      on_recovery: true,
    });
  });
});

// ── Platform dataset sources ────────────────────────────────────────────────

describe("platform dataset sources", () => {
  const g: EtlGraph = {
    nodes: [
      node("s", "source", {
        type: "platform_dataset",
        table_id: "11111111-2222-3333-4444-555555555555",
        table_name: "sf_accounts",
      }),
      node("t", "target", {
        type: "object_storage",
        dataset: "out",
        table: "accounts",
        format: "parquet",
        write_mode: "replace",
      }),
    ],
    edges: [{ from: "s", to: "t" }],
  };

  it("fetches rows over the session's own authenticated channel", () => {
    const code = compileGraph(g);
    assertParsesAsPython(code);
    expect(code).toContain("'part': 'etl_dataset'");
    expect(code).toContain("'table_id': '11111111-2222-3333-4444-555555555555'");
    expect(code).toContain("AGENTSWARMS_TOKEN");
    // No credential env of its own — ownership rides the token.
    expect(code).not.toContain("ETL_S_URL");
  });

  it("labels lineage with the dataset name", () => {
    const code = compileGraph(g);
    expect(code).toContain("'lineage_sources': ['platform:sf_accounts']");
  });

  it("needs requests, nothing else source-side", () => {
    const reqs = requirementsFor(g);
    expect(reqs).toContain("requests");
    expect(reqs).not.toContain("s3fs");
    expect(reqs).not.toContain("sqlalchemy");
  });

  it("the dataset part is owner-scoped and served to run and preview sessions", () => {
    const svc = read("src/utils/etl/service.server.ts");
    const fn = svc.slice(svc.indexOf("export async function etlDatasetFor"));
    expect(fn).toContain('.eq("user_id", userId)');
    expect(fn).toContain("ETL_DATASET_MAX_ROWS");
    const route = read("src/routes/api/notebook.runtime.source.ts");
    expect(route.split("etlDatasetFor(").length).toBe(3);
  });
});

// ── Node previews ───────────────────────────────────────────────────────────

describe("compilePreview", () => {
  const g: EtlGraph = {
    nodes: [
      node("a", "source", { type: "python", code: "df = None" }),
      node("b", "source", { type: "python", code: "df = None" }),
      node("f", "transform", { type: "filter", expr: "x > 0" }),
      node("j", "transform", { type: "join", how: "outer", left_on: ["id"], right_on: ["id"] }),
      node("t", "target", {
        type: "object_storage",
        dataset: "out",
        table: "o",
        format: "parquet",
        write_mode: "replace",
      }),
    ],
    edges: [
      { from: "a", to: "f" },
      { from: "f", to: "j" },
      { from: "b", to: "j" },
      { from: "j", to: "t" },
    ],
  };

  it("emits only the selected node's ancestors, sampled, with no loads", () => {
    const code = compilePreview(g, "f");
    assertParsesAsPython(code);
    expect(code).toContain("f_a = _src_a().head(500)");
    // b and j are NOT ancestors of f.
    expect(code).not.toContain("_src_b");
    expect(code).not.toContain("f_j");
    expect(code).not.toContain("dlt");
    expect(code).toContain("'columns':");
    expect(code).toContain(".head(50)");
  });

  it("previewing a target shows the frame it would load", () => {
    const code = compilePreview(g, "t");
    expect(code).toContain("_pv = f_j.head(50)");
    expect(code).toContain("_src_a");
    expect(code).toContain("_src_b");
  });

  it("refuses unknown nodes and validates the full graph first", () => {
    expect(() => compilePreview(g, "nope")).toThrow(/not found/);
    const broken: EtlGraph = {
      nodes: [
        node("a", "source", { type: "python", code: "df = None" }),
        node("j", "transform", { type: "join", how: "inner", left_on: ["i"], right_on: ["i"] }),
        node("t", "target", {
          type: "object_storage",
          dataset: "o",
          table: "t",
          format: "parquet",
          write_mode: "replace",
        }),
      ],
      edges: [
        { from: "a", to: "j" },
        { from: "j", to: "t" },
      ],
    };
    expect(() => compilePreview(broken, "a")).toThrow(/two inputs/);
  });

  it("preview requirements drop the load-side packages", () => {
    const reqs = previewRequirementsFor(g);
    expect(reqs).toContain("pandas");
    expect(reqs).not.toContain("dlt");
  });
});

// ── Native warehouse targets ────────────────────────────────────────────────

const nativeGraph = (provider: string): EtlGraph => ({
  nodes: [
    node("s", "source", { type: "python", code: "df = None" }),
    node("t", "target", {
      type: "database",
      provider,
      connection_id: "c1",
      dataset: "analytics",
      table: "facts",
      write_mode: "replace",
    }),
  ],
  edges: [{ from: "s", to: "t" }],
});

describe("native warehouse targets", () => {
  it("snowflake, bigquery and databricks compile to dlt native destinations", () => {
    for (const prov of ["snowflake", "bigquery", "databricks"]) {
      const code = compileGraph(nativeGraph(prov));
      assertParsesAsPython(code);
      expect(code).toContain(`dest = dlt.destinations.${prov}(credentials=_dc['credentials']`);
      expect(code).toContain("os.environ['ETL_T_DEST_CREDS']");
      expect(code).not.toContain("sqlalchemy_dest(os.environ['ETL_T_URL'])");
    }
  });

  it("native providers stay refused as SOURCES", () => {
    const g: EtlGraph = {
      nodes: [
        node("s", "source", {
          type: "database",
          provider: "snowflake",
          connection_id: "c1",
          mode: "table",
          table: "x",
        }),
        node("t", "target", {
          type: "object_storage",
          dataset: "out",
          table: "o",
          format: "parquet",
          write_mode: "replace",
        }),
      ],
      edges: [{ from: "s", to: "t" }],
    };
    expect(() => compileGraph(g)).toThrow(/not supported as a pipeline source/);
  });

  it("requirements pull the destination extra, not the sqlalchemy driver", () => {
    const reqs = requirementsFor(nativeGraph("bigquery"));
    expect(reqs).toContain("dlt[bigquery]>=1.3");
    expect(reqs).not.toContain("dlt[sqlalchemy]");
    expect(reqs).not.toContain("psycopg2");
  });

  it("nativeDestCreds shapes each provider and lists its secrets", () => {
    const snow = nativeDestCreds({
      provider: "snowflake",
      account: "xy1.eu-west-1",
      token: "pat-token",
      warehouse: "WH",
      database: "DB",
      role: "LOADER",
    } as never);
    expect(snow.credentials).toMatchObject({
      host: "xy1.eu-west-1",
      warehouse: "WH",
      authenticator: "oauth",
      token: "pat-token",
      role: "LOADER",
    });
    expect(snow.secrets).toEqual(["pat-token"]);

    const bq = nativeDestCreds({
      provider: "bigquery",
      project_id: "p",
      service_account_json: JSON.stringify({ type: "service_account", private_key: "PK" }),
      location: "EU",
    } as never);
    expect(bq.credentials).toMatchObject({ type: "service_account" });
    expect(bq.kwargs).toEqual({ location: "EU" });
    expect(bq.secrets).toEqual(["PK"]);

    const dbx = nativeDestCreds({
      provider: "databricks",
      host: "https://dbc-1.cloud.databricks.com",
      warehouse_id: "abc123",
      token: "dapi-x",
      catalog: "main",
    } as never);
    expect(dbx.credentials).toMatchObject({
      server_hostname: "dbc-1.cloud.databricks.com",
      http_path: "/sql/1.0/warehouses/abc123",
      access_token: "dapi-x",
      catalog: "main",
    });
    expect(dbx.secrets).toEqual(["dapi-x"]);

    expect(() => nativeDestCreds({ provider: "redshift" } as never)).toThrow(
      /No native pipeline destination/,
    );
  });
});

// ── Schema drift ────────────────────────────────────────────────────────────

const driftGraph = (policy?: string): EtlGraph => ({
  nodes: [
    node("s", "source", { type: "python", code: "df = None" }),
    node("t", "target", {
      type: "object_storage",
      dataset: "out",
      table: "orders",
      format: "parquet",
      write_mode: "replace",
      ...(policy ? { schema_policy: policy } : {}),
    }),
  ],
  edges: [{ from: "s", to: "t" }],
});

describe("schema drift", () => {
  it("strict targets compare against ETL_<NODE>_SCHEMA before loading and abort on drift", () => {
    const code = compileGraph(driftGraph("strict"));
    assertParsesAsPython(code);
    expect(code).toContain("os.environ.get('ETL_T_SCHEMA')");
    expect(code).toContain("raise RuntimeError('[schema] ' + _msg)");
    // The comparison must run BEFORE dlt writes anything.
    expect(code.indexOf("_prev_raw")).toBeLessThan(code.indexOf("pipe.run"));
  });

  it("warn targets log drift instead of aborting", () => {
    const code = compileGraph(driftGraph("warn"));
    assertParsesAsPython(code);
    expect(code).toContain("print('[schema] WARN ' + _msg)");
    expect(code).not.toContain("raise RuntimeError('[schema]");
  });

  it("every target reports its schema in metrics, policy or not", () => {
    const code = compileGraph(driftGraph());
    assertParsesAsPython(code);
    expect(code).toContain("_schemas['t'] =");
    expect(code).toContain("'schemas': _schemas,");
    // No policy, no comparison: the env read must not be emitted.
    expect(code).not.toContain("ETL_T_SCHEMA");
  });
});

// ── Quality gates ───────────────────────────────────────────────────────────

const gateGraph = (rules: object[]): EtlGraph => ({
  nodes: [
    node("s", "source", { type: "python", code: "df = None" }),
    { id: "g", kind: "transform", label: "orders checks", config: { type: "quality_gate", rules } },
    node("t", "target", {
      type: "object_storage",
      dataset: "out",
      table: "orders",
      format: "parquet",
      write_mode: "replace",
    }),
  ],
  edges: [
    { from: "s", to: "g" },
    { from: "g", to: "t" },
  ],
});

describe("quality gates", () => {
  it("compiles every check kind into valid Python with the quality metric", () => {
    const code = compileGraph(
      gateGraph([
        { check: "not_null", column: "id", severity: "fail" },
        { check: "unique", column: "id", severity: "warn" },
        { check: "range", column: "amount", min: 0, max: 10000, severity: "drop" },
        { check: "regex", column: "sku", pattern: "^[A-Z]{2}-\\d+$", severity: "warn" },
        { check: "allowed_values", column: "status", values: ["paid", "open"], severity: "fail" },
        { check: "row_count_min", min: 10, severity: "fail" },
      ]),
    );
    assertParsesAsPython(code);
    expect(code).toContain("_quality = []");
    expect(code).toContain("def _gate_g(df):");
    expect(code).toContain("'quality': _quality,");
    // fail raises, drop filters, warn only prints.
    expect(code).toContain("raise RuntimeError");
    expect(code).toContain("df = df[~_m2].reset_index(drop=True)");
    expect(code).toContain("[quality] WARN");
  });

  it("half-open ranges compile (min-only and max-only)", () => {
    const code = compileGraph(
      gateGraph([
        { check: "range", column: "a", min: 0, severity: "warn" },
        { check: "range", column: "b", max: 5, severity: "warn" },
      ]),
    );
    assertParsesAsPython(code);
    expect(code).toContain("~(df['a'] >= 0)");
    expect(code).toContain("~(df['b'] <= 5)");
  });

  it("rejects malformed gates at compile time, not at run time", () => {
    expect(() => compileGraph(gateGraph([]))).toThrow(/no rules/);
    expect(() =>
      compileGraph(gateGraph([{ check: "range", column: "a", severity: "fail" }])),
    ).toThrow(/min, a max, or both/);
    expect(() => compileGraph(gateGraph([{ check: "not_null", severity: "fail" }]))).toThrow(
      /needs a column/,
    );
    expect(() =>
      compileGraph(gateGraph([{ check: "exotic", column: "a", severity: "fail" }])),
    ).toThrow(/Unknown quality check/);
  });

  it("hostile column names stay inside string literals", () => {
    const code = compileGraph(
      gateGraph([{ check: "not_null", column: "a']; import os #", severity: "fail" }]),
    );
    assertParsesAsPython(code);
    expect(code).toContain("df['a\\']; import os #'].isna()");
  });
});

// ── Lineage emission ────────────────────────────────────────────────────────

describe("lineage in compiled metrics", () => {
  it("emits per-target fqns in the crawler's vocabulary (jsonl is ndjson)", () => {
    const g: EtlGraph = {
      nodes: [
        node("s", "source", { type: "python", code: "df = None" }),
        {
          id: "t1",
          kind: "target",
          config: {
            type: "object_storage",
            dataset: "finance",
            table: "exceptions",
            format: "jsonl",
          },
        },
        {
          id: "t2",
          kind: "target",
          config: {
            type: "object_storage",
            dataset: "finance",
            table: "orders",
            format: "parquet",
          },
        },
      ],
      edges: [
        { from: "s", to: "t1" },
        { from: "s", to: "t2" },
      ],
    };
    const code = compileGraph(g);
    expect(code).toContain("'fqn': 'finance/exceptions/*.ndjson'");
    expect(code).toContain("'fqn': 'finance/orders/*.parquet'");
  });

  it("labels upstream sources honestly: paths, tables, urls, python", () => {
    const g: EtlGraph = {
      nodes: [
        node("a", "source", { type: "object_storage", path: "raw/orders/*.csv", format: "csv" }),
        node("b", "source", {
          type: "database",
          family: "postgres",
          mode: "table",
          table: "public.users",
        }),
        node("c", "source", { type: "python", code: "df = None" }),
        {
          id: "t",
          kind: "target",
          config: { type: "object_storage", dataset: "out", table: "merged", format: "parquet" },
        },
        node("u", "transform", { type: "union" }),
      ],
      edges: [
        { from: "a", to: "u" },
        { from: "b", to: "u" },
        { from: "c", to: "u" },
        { from: "u", to: "t" },
      ],
    };
    const code = compileGraph(g);
    expect(code).toContain("'lineage_sources': ['raw/orders/*.csv','public.users','python']");
  });
});

// ── Wiring pins ─────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("etl wiring", () => {
  it("the batch result callback finalises ETL runs", () => {
    const src = read("src/routes/api/notebook.runtime.result.ts");
    expect(src).toContain("etl_run_id");
    expect(src).toContain("finalizeEtlRun");
  });

  it("the source route serves the ETL bundle and its env part", () => {
    const src = read("src/routes/api/notebook.runtime.source.ts");
    expect(src).toContain("etl_run_id");
    expect(src).toContain("etlEnvFor");
    expect(src).toContain("etlBundleFor");
  });

  it("startSession threads etl_run_id into the session row", () => {
    const src = read("src/utils/notebookRuntime/service.server.ts");
    expect(src).toContain("etlRunId");
    expect(src).toContain("etl_run_id: opts.etlRunId ?? null");
  });

  it("the cron pass sweeps due pipelines", () => {
    const src = read("src/utils/bi/refresh.server.ts");
    expect(src).toContain("processDueEtlPipelines");
    expect(src).toContain("etl_runs");
  });

  it("the trigger endpoint hashes tokens and rate-limits globally", () => {
    const src = read("src/routes/api/etl.run.ts");
    expect(src).toContain("timingSafeEqual");
    expect(src).toContain("rateLimitedGlobal");
    expect(src).not.toContain("Invalid token");
  });

  it("the ETL page is reachable from the shared navigation map", () => {
    const src = read("src/lib/appNav.ts");
    expect(src).toContain('url: "/etl"');
  });

  it("the page copy names capabilities, not libraries", () => {
    // The user-facing surface describes what pipelines do; implementation
    // libraries stay in the developer docs.
    const src = read("src/routes/_authenticated/etl.tsx");
    expect(src).not.toMatch(/\bdlt\b/);
    expect(src).not.toMatch(/\bibis\b/);
  });

  it("a succeeded run replaces its pipeline's lineage edges wholesale", () => {
    const svc = read("src/utils/etl/service.server.ts");
    // Delete keyed on pipeline_id, NOT on the new target fqns: a renamed
    // target would otherwise strand the old edge forever.
    const del = svc.indexOf('.eq("pipeline_id", pipeline.id)');
    const ins = svc.indexOf('from("catalog_lineage").insert');
    expect(del).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(del);
    expect(svc).toContain('source_system: "etl"');
    // Twin sources with the same label make ONE edge, not duplicates.
    expect(svc).toContain("new Set(");
  });

  it("a crawl refresh only deletes its OWN lineage system's rows", () => {
    const src = read("src/utils/catalog/crawler.server.ts");
    const i = src.indexOf('from("catalog_lineage")\n    .delete()');
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 200)).toContain('eq("source_system", "databricks")');
  });

  it("schema state round-trips through etl_pipeline_state like watermarks", () => {
    const svc = read("src/utils/etl/service.server.ts");
    // Inject on launch...
    expect(svc).toContain('like("node_id", "schema:%")');
    expect(svc).toContain("_SCHEMA`] = value");
    // ...persist after a durable load, keyed apart from cursors.
    expect(svc).toContain("`schema:${nodeId}`");
    expect(svc).toContain("cursor_value: JSON.stringify(value)");
  });

  it("saves snapshot version history and restores move it forward", () => {
    const fns = read("src/utils/etl.functions.ts");
    // Both write paths snapshot...
    expect(fns.split("snapshotEtlVersion(").length).toBeGreaterThanOrEqual(4);
    // ...identical content is skipped, and history is capped.
    expect(fns).toContain("if (same) return;");
    expect(fns).toContain(".range(50, 1000)");
    // A restore writes the old content back AND snapshots it as the newest
    // version — history never rewinds in place.
    const restore = fns.slice(fns.indexOf("restoreEtlVersion"));
    expect(restore).toContain("snapshotEtlVersion(");
    expect(restore).toContain("etl.pipeline.restore_version");
  });

  it("the versions migration is owner-read-only", () => {
    const sql = read("supabase/migrations/20260837000000_etl_versions.sql");
    expect(sql).toContain("ALTER TABLE public.etl_pipeline_versions ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('"Users read own etl versions"');
    expect(sql).not.toMatch(/etl_pipeline_versions FOR (ALL|INSERT|UPDATE|DELETE)/);
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("the source route serves preview bundles from the session stash", () => {
    const src = read("src/routes/api/notebook.runtime.source.ts");
    expect(src).toContain("etlPreviewStashOf");
    expect(src).toContain("etlPreviewEnvFor");
    expect(src).toContain("etlPreviewBundleFor");
  });

  it("preview env resolution skips destinations and drift baselines", () => {
    const svc = read("src/utils/etl/service.server.ts");
    expect(svc).toContain('if (opts?.skipTargets && node.kind === "target") continue;');
    expect(svc).toContain("resolveRunEnv(pipeline, { skipTargets: true })");
  });

  it("run-outcome notifications obey the pipeline's alert policy", () => {
    const svc = read("src/utils/etl/service.server.ts");
    // Failure alert is gated, not unconditional.
    expect(svc).toContain("if (etlAlertPolicy(pipeline).on_failure)");
    // The recovery transition reads the PREVIOUS status before it is stamped
    // over, and recovery outranks the plain success alert.
    const i = svc.indexOf('const wasFailing = pipeline.last_run_status === "failed"');
    const j = svc.indexOf('last_run_status: "succeeded"');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
    expect(svc).toContain("if (alerts.on_recovery && wasFailing)");
    expect(svc).toContain("} else if (alerts.on_success)");
  });

  it("cdc slots are engine-named at launch and dropped with the pipeline", () => {
    const svc = read("src/utils/etl/service.server.ts");
    expect(svc).toContain("cdcSlotName(pipeline.id, node.id)");
    expect(svc).toContain("export async function dropCdcSlots");
    expect(svc).toContain("pg_drop_replication_slot");
    const fns = read("src/utils/etl.functions.ts");
    // The delete handler runs the drop BEFORE the row (and its graph) is gone.
    const drop = fns.indexOf("dropCdcSlots(full)");
    const del = fns.indexOf('from("etl_pipelines").delete()');
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(del);
  });

  it("duplicating a pipeline stages it: manual schedule, fresh token, no history", () => {
    const fns = read("src/utils/etl.functions.ts");
    const dup = fns.slice(fns.indexOf("export const duplicateEtlPipeline"));
    expect(dup).toContain('schedule: "manual"');
    expect(dup).toContain("randomBytes(24)");
    expect(dup).toContain("etl.pipeline.duplicate");
    // The copy must NOT inherit the original's trigger token hash.
    expect(dup).not.toContain("trigger_token_hash: src.trigger_token_hash");
  });

  it("every scheduler decision is an atomic claim — replica-safe behind a LB", () => {
    const sched = read("src/utils/etl/schedule.server.ts");
    // Due pipelines: the clock advance compare-and-sets on the OLD next_run_at.
    expect(sched).toContain('claim.eq("next_run_at", pipeline.next_run_at)');
    expect(sched).toContain("if (!won?.length) continue;");
    const svc = read("src/utils/etl/service.server.ts");
    // Retries: retrying -> queued, one winner.
    expect(svc).toContain('.eq("status", "retrying")\n    .select("id")');
    // Finalisation (either verdict): only a live run can be claimed, once.
    const successClaim = svc.indexOf('.in("status", ["queued", "running", "retrying"])');
    expect(successClaim).toBeGreaterThan(-1);
    expect(
      svc.split('.in("status", ["queued", "running", "retrying"])').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("failures flow through one retry ladder from both failure paths", () => {
    const src = read("src/utils/etl/service.server.ts");
    // Start failures and sandbox failures must converge on failOrRetry, or the
    // Runs tab and audit trail can disagree about what happened.
    expect(src.match(/failOrRetry\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src).toContain("restartEtlAttempt");
    expect(src).toContain("etl.run.retry_scheduled");
  });

  it("the sweep restarts due retry attempts", () => {
    const src = read("src/utils/etl/schedule.server.ts");
    expect(src).toContain('eq("status", "retrying")');
    expect(src).toContain("restartEtlAttempt");
    expect(src).toContain("nextCronOccurrence");
  });

  it("watermarks persist only after a durable load, server-side", () => {
    const src = read("src/utils/etl/service.server.ts");
    expect(src).toContain("etl_pipeline_state");
    // Persistence lives in the SUCCESS branch of finalize, after the run row
    // is marked succeeded — crash-between-the-two re-reads rows, never skips.
    // (The first etl_pipeline_state mention is the cursor READ in
    // resolveRunEnv; the write is the upsert.)
    const upsertAt = src.indexOf('from("etl_pipeline_state").upsert');
    expect(upsertAt).toBeGreaterThan(src.indexOf('status: "succeeded"'));
  });

  it("the batch runner streams partial logs and the route accepts them", () => {
    expect(read("docker/notebook-runtime/batch_runner.py")).toContain('"partial": True');
    const route = read("src/routes/api/notebook.runtime.result.ts");
    expect(route).toContain("body.partial");
    expect(route).toContain("appendPartialLogs");
  });

  it("chained starts come from finalize success and cycles are refused at save", () => {
    const src = read("src/utils/etl/service.server.ts");
    expect(src).toContain('eq("run_after", pipeline.id)');
    const fns = read("src/utils/etl.functions.ts");
    expect(fns).toContain("cannot run after itself");
    expect(fns).toContain("loop back to this pipeline");
    expect(fns).toContain("validateCron");
  });

  it("raw-IP egress entries reach squid as dst, not dstdomain", () => {
    // A LAN MinIO in the admin allow-list silently did nothing before: squid's
    // dstdomain ACL never matches an IP-form URL. Pinned end to end.
    const conf = read("deploy/notebooks/egress/squid.conf");
    expect(conf).toContain('acl allowed_ips dst "/etc/squid/allowed_ips"');
    expect(conf).toContain("http_access allow allowed_ips");
    expect(conf).toContain("acl Safe_ports port 9000");
    const compose = read("docker-compose.yml");
    expect(compose).toContain("allowed_ips:/etc/squid/allowed_ips:ro");
    const apply = read("src/utils/notebookRuntime/egressApply.server.ts");
    expect(apply).toContain("renderEgressIpAllowlist");
  });

  it("the prelude re-adds the user site dir after pip install", () => {
    // ~/.local is an empty tmpfs at container start, so the user site is not
    // on sys.path until someone adds it — without this every install was
    // invisible and the first import failed.
    const src = read("src/utils/etl/service.server.ts");
    expect(src).toContain("_site.addsitedir(_site.getusersitepackages())");
  });

  it("the sweep reaps runs whose sandbox died without calling home", () => {
    const src = read("src/utils/etl/service.server.ts");
    expect(src).toContain("reconcileOrphanedEtlRuns");
    expect(read("src/utils/etl/schedule.server.ts")).toContain("reconcileOrphanedEtlRuns");
  });

  it("the migration enables RLS on both tables and read-only runs", () => {
    const sql = read("supabase/migrations/20260834000000_etl_pipelines.sql");
    expect(sql).toContain("ALTER TABLE public.etl_pipelines ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE public.etl_runs ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('"Users read own etl runs"');
    expect(sql).not.toMatch(/etl_runs FOR ALL/);
  });
});

describe("egress IP renderer", () => {
  it("splits IPs from domains and drops everything else", async () => {
    const { renderEgressIpAllowlist, isEgressIp } = await import("@/utils/notebookRuntime/egress");
    expect(isEgressIp("192.168.1.85")).toBe(true);
    expect(isEgressIp("pypi.org")).toBe(false);
    const body = renderEgressIpAllowlist(["192.168.1.85", "pypi.org", "10.0.0.7"]);
    expect(body).toContain("192.168.1.85");
    expect(body).toContain("10.0.0.7");
    expect(body).not.toContain("pypi.org");
  });
});
