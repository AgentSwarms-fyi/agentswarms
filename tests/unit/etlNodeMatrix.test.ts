// EVERY node kind, through BOTH emitters, compiled as Python.
//
// The suite already had "compiles every source type" and "compiles every
// transform type". Neither was: the first covered six of eleven source kinds,
// the second seven of fifteen transforms, and both were hand-written lists
// that a new node kind joins only if somebody remembers. A list that claims
// "every" and is not checked against the type is a claim nobody is keeping.
//
// The tables here are `Record<Kind, …>` keyed on the discriminant of the
// config unions, so adding a kind to `EtlSourceConfig`, `EtlTransformConfig`
// or `EtlTargetConfig` STOPS TYPE-CHECKING until it has an entry. This test
// cannot fall behind the product by omission — only by someone deleting a row.
//
// What each row proves is modest and worth stating plainly: the emitter
// produces a program and CPython compiles it. That is not "the node does the
// right thing to the data" — the live runs in docs/UI_TEST_RESULTS.md are for
// that — but it is the floor below which nothing else can be true, and it is
// the floor a hand-maintained list kept falling through.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileGraph,
  type EtlGraph,
  type EtlNode,
  type EtlSourceConfig,
  type EtlTargetConfig,
  type EtlTransformConfig,
} from "@/utils/etl/codegen";
import { compileSparkGraph, sparkRefusal } from "@/utils/etl/sparkCodegen";

type SourceKind = EtlSourceConfig["type"];
type TransformKind = EtlTransformConfig["type"];
type TargetKind = EtlTargetConfig["type"];

const PY = (() => {
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["-c", "pass"], { stdio: "ignore" });
      return c;
    } catch {
      /* try the next one */
    }
  }
  return null;
})();

function compilesAsPython(code: string, what: string): void {
  if (!PY) return;
  const dir = mkdtempSync(join(tmpdir(), "etl-matrix-"));
  try {
    const file = join(dir, "gen.py");
    writeFileSync(file, code, "utf8");
    try {
      execFileSync(
        PY,
        ["-c", `compile(open(${JSON.stringify(file)}, encoding='utf8').read(), 'gen.py', 'exec')`],
        { stdio: "pipe" },
      );
    } catch (e) {
      const err = e as { stderr?: Buffer };
      throw new Error(`${what} did not compile as Python:\n${err.stderr?.toString() ?? String(e)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mk = (id: string, kind: EtlNode["kind"], config: unknown, label?: string): EtlNode =>
  ({ id, kind, label: label ?? id, config }) as EtlNode;

/** The lakehouse target every graph below can end in. */
const SINK: EtlTargetConfig = {
  type: "lakehouse",
  schema: "analytics",
  table: "sink",
  write_mode: "append",
};

/** The lakehouse source every transform and target below can start from. */
const FEED: EtlSourceConfig = {
  type: "lakehouse",
  schema: "analytics",
  mode: "table",
  table: "revenue_facts",
};

// ── Every source kind ───────────────────────────────────────────────────────
const SOURCES: Record<SourceKind, EtlSourceConfig> = {
  object_storage: {
    type: "object_storage",
    catalog_source_id: "s1",
    path: "raw/orders/*.csv",
    format: "csv",
  },
  database: {
    type: "database",
    connection_id: "c1",
    provider: "postgres",
    mode: "table",
    table: "public.orders",
  },
  http_api: { type: "http_api", url: "https://example.test/orders", records_path: "data.items" },
  ingest: { type: "ingest" },
  python: { type: "python", code: "return [{}]" },
  platform_dataset: { type: "platform_dataset", table_id: "t1", table_name: "uploaded orders" },
  lakehouse: { type: "lakehouse", schema: "analytics", mode: "table", table: "revenue_facts" },
  catalog_asset: {
    type: "catalog_asset",
    asset_id: "a1",
    source_id: "s1",
    fqn: "analytics.revenue_facts",
    source_name: "Lakehouse",
    resolved: { type: "lakehouse", schema: "analytics", mode: "table", table: "revenue_facts" },
  } as EtlSourceConfig,
  kafka: {
    type: "kafka",
    brokers: "broker:9092",
    topic: "orders",
    format: "json",
    start: "earliest",
    max_messages: 500,
    idle_ms: 2000,
    security: "plaintext",
    sasl_mechanism: "PLAIN",
    username_secret: "",
    password_secret: "",
  },
  kinesis: {
    type: "kinesis",
    stream: "orders",
    region: "eu-west-1",
    format: "json",
    start: "trim_horizon",
    max_messages: 500,
    idle_ms: 2000,
    access_key_secret: "AWS_KEY",
    secret_key_secret: "AWS_SECRET",
    endpoint: "",
  },
  pubsub: {
    type: "pubsub",
    project: "demo",
    subscription: "orders-sub",
    format: "json",
    max_messages: 500,
    idle_ms: 2000,
    credentials_secret: "GCP_SA",
  },
};

// ── Every transform kind ────────────────────────────────────────────────────
/** `inputs: 2` marks the transforms that need a second upstream node. */
const TRANSFORMS: Record<TransformKind, { config: EtlTransformConfig; inputs?: 2 }> = {
  filter: { config: { type: "filter", expr: "net_usd > 0" } },
  select: { config: { type: "select", columns: ["order_id", "net_usd"] } },
  rename: { config: { type: "rename", mapping: { net_usd: "revenue" } } },
  derive: { config: { type: "derive", column: "doubled", expr: "net_usd * 2" } },
  dedupe: { config: { type: "dedupe", columns: ["order_id"] } },
  limit: { config: { type: "limit", n: 100 } },
  sort: { config: { type: "sort", by: ["net_usd"], descending: true } },
  aggregate: {
    config: {
      type: "aggregate",
      group_by: ["region"],
      aggs: [{ column: "net_usd", fn: "sum", as: "revenue" }],
    },
  },
  fill_nulls: { config: { type: "fill_nulls", value: "0", columns: ["net_usd"] } },
  drop_nulls: { config: { type: "drop_nulls", columns: ["order_id"] } },
  join: {
    config: {
      type: "join",
      how: "inner",
      left_on: ["order_id"],
      right_on: ["order_id"],
    } as EtlTransformConfig,
    inputs: 2,
  },
  union: { config: { type: "union" }, inputs: 2 },
  sql: { config: { type: "sql", query: "SELECT region, count(*) AS n FROM t GROUP BY region" } },
  python: { config: { type: "python", code: "return df" } },
  quality_gate: {
    config: {
      type: "quality_gate",
      rules: [{ check: "not_null", column: "order_id", severity: "warn" }],
    },
  },
};

// ── Every target kind ───────────────────────────────────────────────────────
const TARGETS: Record<TargetKind, EtlTargetConfig> = {
  saas: {
    type: "saas",
    connection_id: "c1",
    vendor: "hubspot",
    object: "contacts",
    id_column: "email",
    batch_size: 100,
  },
  object_storage: {
    type: "object_storage",
    catalog_source_id: "s1",
    dataset: "medallion",
    table: "orders",
    format: "parquet",
    write_mode: "append",
  },
  database: {
    type: "database",
    connection_id: "c1",
    provider: "postgres",
    dataset: "public",
    table: "orders",
    write_mode: "append",
  },
  lakehouse: { type: "lakehouse", schema: "analytics", table: "orders", write_mode: "append" },
  http_api: {
    type: "http_api",
    url: "https://example.test/ingest",
    method: "POST",
    batch_size: 200,
  },
};

/** One source → optional transform → one target, wired linearly. */
function graphWith(opts: {
  source?: EtlSourceConfig;
  transform?: { config: EtlTransformConfig; inputs?: 2 };
  target?: EtlTargetConfig;
}): EtlGraph {
  const src = mk("n1", "source", opts.source ?? FEED, "src");
  const tgt = mk("n9", "target", opts.target ?? SINK, "out");
  if (!opts.transform) {
    return { nodes: [src, tgt], edges: [{ id: "e1", from: "n1", to: "n9" }] };
  }
  const mid = mk("n5", "transform", opts.transform.config, "step");
  const nodes: EtlNode[] = [src, mid, tgt];
  const edges = [
    { id: "e1", from: "n1", to: "n5" },
    { id: "e2", from: "n5", to: "n9" },
  ];
  if (opts.transform.inputs === 2) {
    // A join or a union needs a second feed; a second lakehouse read is the
    // one that needs nothing else configured.
    nodes.splice(1, 0, mk("n2", "source", FEED, "src2"));
    edges.push({ id: "e3", from: "n2", to: "n5" });
  }
  return { nodes, edges };
}

describe("every source kind compiles, on both engines", () => {
  for (const [kind, config] of Object.entries(SOURCES) as [SourceKind, EtlSourceConfig][]) {
    it(kind, () => {
      const g = graphWith({ source: config });
      compilesAsPython(compileGraph(g), `source "${kind}" (pandas)`);
      // Spark reads natively what it can and falls back to the driver for the
      // rest, so every source kind must produce a program there too.
      expect(sparkRefusal(g), `spark refused source "${kind}"`).toBeNull();
      compilesAsPython(compileSparkGraph(g), `source "${kind}" (spark)`);
    });
  }
});

describe("every transform kind compiles, on both engines", () => {
  for (const [kind, spec] of Object.entries(TRANSFORMS) as [
    TransformKind,
    { config: EtlTransformConfig; inputs?: 2 },
  ][]) {
    it(kind, () => {
      const g = graphWith({ transform: spec });
      compilesAsPython(compileGraph(g), `transform "${kind}" (pandas)`);
      expect(sparkRefusal(g), `spark refused transform "${kind}"`).toBeNull();
      compilesAsPython(compileSparkGraph(g), `transform "${kind}" (spark)`);
    });
  }
});

describe("every target kind compiles, on both engines", () => {
  for (const [kind, config] of Object.entries(TARGETS) as [TargetKind, EtlTargetConfig][]) {
    it(kind, () => {
      const g = graphWith({ target: config });
      compilesAsPython(compileGraph(g), `target "${kind}" (pandas)`);
      expect(sparkRefusal(g), `spark refused target "${kind}"`).toBeNull();
      compilesAsPython(compileSparkGraph(g), `target "${kind}" (spark)`);
    });
  }
});

describe("every write mode and table format a target offers", () => {
  const MODES = ["replace", "append", "merge"] as const;
  const FORMATS = ["none", "delta", "iceberg"] as const;

  for (const mode of MODES) {
    for (const table_format of FORMATS) {
      it(`object storage · ${mode} · ${table_format}`, () => {
        const g = graphWith({
          target: {
            ...(TARGETS.object_storage as Record<string, unknown>),
            write_mode: mode,
            table_format,
            primary_key: mode === "merge" ? ["order_id"] : undefined,
          } as EtlTargetConfig,
        });
        compilesAsPython(compileGraph(g), `object storage ${mode}/${table_format} (pandas)`);
        // Spark's two documented gaps — Iceberg, and merge without Delta —
        // are refusals in words, not silent failures on a cluster. Asserted
        // here so a future Spark Iceberg writer has to update this row.
        const refusal = sparkRefusal(g);
        if (table_format === "iceberg" || (mode === "merge" && table_format !== "delta")) {
          expect(refusal, `spark should refuse ${mode}/${table_format}`).toBeTruthy();
        } else {
          expect(refusal, `spark refused ${mode}/${table_format}`).toBeNull();
          compilesAsPython(compileSparkGraph(g), `object storage ${mode}/${table_format} (spark)`);
        }
      });
    }
  }

  for (const mode of MODES) {
    it(`lakehouse · ${mode}`, () => {
      const g = graphWith({
        target: {
          type: "lakehouse",
          schema: "analytics",
          table: "orders",
          write_mode: mode,
          primary_key: mode === "merge" ? ["order_id"] : undefined,
        } as EtlTargetConfig,
      });
      compilesAsPython(compileGraph(g), `lakehouse ${mode} (pandas)`);
      expect(sparkRefusal(g)).toBeNull();
      compilesAsPython(compileSparkGraph(g), `lakehouse ${mode} (spark)`);
    });
  }
});

describe("every file format a source and a target offer", () => {
  const READ = ["csv", "tsv", "json", "jsonl", "parquet", "xlsx"] as const;
  const WRITE = ["parquet", "csv", "jsonl"] as const;

  for (const format of READ) {
    it(`reads ${format}`, () => {
      const g = graphWith({
        source: {
          type: "object_storage",
          catalog_source_id: "s1",
          path: `raw/x.${format}`,
          format,
        },
      });
      compilesAsPython(compileGraph(g), `read ${format} (pandas)`);
      compilesAsPython(compileSparkGraph(g), `read ${format} (spark)`);
    });
  }

  for (const format of WRITE) {
    it(`writes ${format}`, () => {
      const g = graphWith({
        target: {
          ...(TARGETS.object_storage as Record<string, unknown>),
          format,
        } as EtlTargetConfig,
      });
      compilesAsPython(compileGraph(g), `write ${format} (pandas)`);
      compilesAsPython(compileSparkGraph(g), `write ${format} (spark)`);
    });
  }
});
