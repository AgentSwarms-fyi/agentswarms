// ML platform, milestone 7: the data wrangler reaches the lakehouse. A prep
// flow can link lakehouse tables in place, compile to one governed query,
// and write its result back as a lakehouse table the ML wizard trains on.
// What is pinned here is the pure model (a lakehouse binding compiles to the
// right physical name and never masquerades as a warehouse fold), the
// server's one chokepoint (the statement guard, never a raw connection), the
// output contract (a materialized view in a schema the caller owns), the
// scheduled refresh, and the docs that promise all of it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildPrepSql,
  emptyPrepConfig,
  parsePrepConfig,
  prepBindingRef,
  prepHasRemoteSources,
  prepLakehouseBinding,
  prepWarehouseBinding,
  type PrepFlowConfig,
} from "@/lib/dataPrepCore";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const cols = [
  { name: "order_id", type: "integer" as const },
  { name: "region", type: "text" as const },
  { name: "net_usd", type: "decimal" as const },
];

function lakeFlow(): PrepFlowConfig {
  return {
    ...emptyPrepConfig(),
    base: "revenue_facts",
    columns: cols.map((c) => ({
      key: `revenue_facts.${c.name}`,
      table: "revenue_facts",
      column: c.name,
      include: true,
      outputName: c.name,
      type: c.type,
    })),
    steps: [
      {
        id: "f1",
        kind: "filter",
        combine: "AND",
        conditions: [{ id: "c1", column: "region", op: "=", value: "EMEA" }],
      } as never,
    ],
    sources: { revenue_facts: { kind: "lakehouse", schema: "analytics", table: "revenue_facts" } },
  };
}

describe("the pure model", () => {
  it("recognises an all-lakehouse flow and refuses a mixed one", () => {
    const cfg = lakeFlow();
    expect(prepLakehouseBinding(cfg)).toEqual({
      tables: { revenue_facts: { schema: "analytics", table: "revenue_facts" } },
    });
    expect(prepHasRemoteSources(cfg)).toBe(true);
    // A lakehouse table is never a warehouse fold.
    expect(prepWarehouseBinding(cfg)).toBeNull();
    const mixed: PrepFlowConfig = {
      ...cfg,
      joins: [{ table: "regions", type: "left", leftKey: "region", rightKey: "name" } as never],
    };
    expect(prepLakehouseBinding(mixed)).toBeNull();
    expect(prepHasRemoteSources(mixed)).toBe(true);
    const local: PrepFlowConfig = { ...cfg, sources: undefined };
    expect(prepLakehouseBinding(local)).toBeNull();
    expect(prepHasRemoteSources(local)).toBe(false);
  });

  it("compiles the lakehouse table to its quoted physical name, aliased for the steps", () => {
    const cfg = lakeFlow();
    const lake = prepLakehouseBinding(cfg)!;
    const sql = buildPrepSql(cfg, {
      dialect: "duckdb",
      physicalTable: (name) => {
        const t = lake.tables[name];
        return t ? `"${t.schema}"."${t.table}"` : `"${name}"`;
      },
    });
    expect(sql).toContain('"analytics"."revenue_facts" AS "revenue_facts"');
    expect(sql).toContain("'EMEA'");
    expect(prepBindingRef({ kind: "lakehouse", schema: "analytics", table: "revenue_facts" })).toBe(
      '"analytics"."revenue_facts"',
    );
    expect(
      prepBindingRef({
        kind: "warehouse",
        connectionId: "c",
        connectionName: "w",
        ref: "public.x",
      }),
    ).toBe("public.x");
  });

  it("round-trips the binding and the output target through the parser", () => {
    const cfg = lakeFlow();
    cfg.output = { kind: "lakehouse", schema: "analytics", table: "revenue_emea" };
    const back = parsePrepConfig(JSON.parse(JSON.stringify(cfg)));
    expect(back.sources).toEqual(cfg.sources);
    expect(back.output).toEqual(cfg.output);
    // Garbage in the output slot is dropped, not trusted.
    const junk = parsePrepConfig({ ...JSON.parse(JSON.stringify(cfg)), output: { kind: "s3" } });
    expect(junk.output).toBeUndefined();
  });
});

describe("the server", () => {
  const prep = rd("src/utils/bi/prep.server.ts");
  const fns = rd("src/utils/dataPrep.functions.ts");
  const refresh = rd("src/utils/bi/refresh.server.ts");

  it("runs an all-lakehouse flow through the statement guard, before any fold or local engine", () => {
    const branch = prep.indexOf("const lake = prepLakehouseBinding(cfg);");
    const fold = prep.indexOf(
      "const folded = await tryFoldToWarehouse(userId, cfg, opts.rowLimit);",
    );
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(fold);
    expect(prep).toContain(
      'await runLakehouseStatement(userId, sql, { rowCap: cap + 1, auditVia: "prep" })',
    );
    expect(prep).toContain('engine: "lakehouse",');
    expect(prep).toContain("export const LAKEHOUSE_PREP_ROW_CAP = 100_000;");
    // Never the raw engine connection for a user's flow.
    expect(prep).not.toContain("lakehouseConnection(");
  });

  it("buffers a lakehouse table in a mixed flow through the same guard, bounded", () => {
    expect(prep).toContain(
      'needed.has(name) && b.kind === "lakehouse" ? [[name, b] as const] : []',
    );
    expect(prep).toContain("if (res.rows.length > cap) truncated.push(name);");
    expect(prep).toContain(
      'needed.has(name) && b.kind === "warehouse" ? [[name, b] as const] : []',
    );
  });

  it("materialises a lakehouse output as a materialized view in a schema the caller owns", () => {
    expect(fns).toContain("export const prepRunToLakehouse");
    expect(fns).toContain('{ schema: data.schema, table: data.table, sql, schedule: "manual" },');
    expect(fns).toContain(
      "Saving to the lakehouse needs every source table to be a linked lakehouse table",
    );
    const matviews = rd("src/utils/lakehouse/matviews.server.ts");
    expect(matviews).toContain("export async function saveMatviewForUser(");
    expect(matviews).toContain("A materialized view can only be written into a schema you own");
    expect(matviews).toContain('throw new Error("Data-lake mounts are read-only");');
    // The workbench's own save goes through the same function.
    expect(rd("src/utils/lakehouse.functions.ts")).toContain(
      'return saveMatviewForUser(userId, data, "save");',
    );
  });

  it("refreshes a lakehouse-output flow by rebuilding its view as the owner", () => {
    expect(refresh).toContain('if (cfg.output?.kind === "lakehouse") {');
    expect(refresh).toContain('.eq("user_id", flow.user_id)');
    expect(refresh).toContain('refreshMaterializedView(view as never, "prep_refresh")');
  });

  it("lists lakehouse tables for prep and ML from one place", () => {
    const tables = rd("src/utils/lakehouse/tables.server.ts");
    expect(tables).toContain("export async function listLakehouseTablesForUser(");
    expect(tables).toContain("writable: s.user_id === userId && !s.lake_source_id,");
    expect(rd("src/utils/ml.functions.ts")).toContain(
      "const r = await listLakehouseTablesForUser(userId);",
    );
    expect(fns).toContain("export const prepLakehouseTables");
  });
});

describe("the tab and the docs", () => {
  it("links lakehouse tables, previews them on the server, and offers the lakehouse output", () => {
    const tab = rd("src/components/bi/DataPrepTab.tsx");
    expect(tab).toContain("function linkLakehouse(");
    expect(tab).toContain('[name]: { kind: "lakehouse", schema: t.schema, table: t.table },');
    expect(tab).toContain("if (prepHasRemoteSources(effective) && token) {");
    expect(tab).toContain('<option value="lakehouse">lakehouse table</option>');
    expect(tab).toContain('output: { kind: "lakehouse", schema: outputSchema, table: out },');
    expect(tab).toContain("Runs on the lakehouse");
  });

  it("describe the round trip on the prep page, the BI guide and the ML guide", () => {
    expect(rd("src/routes/docs.data-prep.tsx")).toContain('<H2 id="lakehouse">');
    expect(rd("docs/BUSINESS_INTELLIGENCE.md")).toContain("- **Lakehouse tables in and out**");
    expect(rd("docs/ML.md")).toContain("## Prepare a training set");
    expect(rd("src/routes/docs.ml.tsx")).toContain('<H2 id="prepare">');
  });
});
