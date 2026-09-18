// Neither AI generator could be pointed at the lakehouse.
//
// Found while verifying BI end to end: "Generate Entire Dashboard" offers a
// local table or a governed semantic model, and the report planner offers
// `ctx.datasets` alone. Neither listed a warehouse — so the two dialogs were
// the only place in BI that could not see the built-in lakehouse the
// dashboards around them were already querying, and a month-end pack could
// not be generated from the warehouse its numbers live in.
//
// It was a gap in the dialogs, not the platform: the manual builder has always
// offered warehouses, `runBiTurn` already takes an `execute` override and a
// `dialect`, and `widgetFromBiTurn` already stores whichever source it is
// handed. This file pins the resolution both dialogs now share.
//
// The part worth testing is not "a warehouse produces warehouse datasets" —
// it is everything that quietly assumes LOCAL: semantic entries and saved
// metrics are keyed to local dataset ids, so carrying them onto a warehouse
// table would hand the planner one table's metric definitions for another
// table's columns and put a confident, wrong number on a dashboard.
import { describe, expect, it } from "vitest";

import {
  LOCAL_SOURCE_KEY,
  generationSource,
  generationSourceOptions,
} from "@/lib/biGenerationSource";
import type { SavedMetric, SemanticEntry } from "@/lib/biAgent";
import type { DatasetMeta } from "@/lib/sqlEngine";
import type { WarehouseConnectionSummary, WarehouseTable } from "@/utils/warehouse/types";

const localDataset: DatasetMeta = {
  id: "ds-1",
  name: "saas_sales",
  columns: [{ name: "amount", type: "number" }],
  row_count: 9994,
  data_loaded_at: null,
  parquet_bytes: null,
  source_filename: null,
  is_sample: false,
  user_id: "u1",
};

const semantics = new Map<string, SemanticEntry>([
  [
    "ds-1",
    {
      id: "sem-1",
      table_id: "ds-1",
      table_description: "local sales",
      business_name: "Sales",
      column_meta: {},
      primary_key: null,
      join_hints: [],
      is_sample: false,
    },
  ],
]);

const metrics: SavedMetric[] = [
  {
    id: "m-1",
    table_id: "ds-1",
    name: "revenue",
    description: null,
    sql_expression: "SUM(amount)",
    example_question: null,
  },
];

const lakehouse: WarehouseConnectionSummary = {
  id: "lh-1",
  provider: "lakehouse",
  name: "AgentSwarms Lakehouse",
  is_active: true,
  last_test_status: "ok",
  last_test_error: null,
  last_tested_at: null,
  created_at: "2026-01-01",
} as WarehouseConnectionSummary;

const lakehouseTables: WarehouseTable[] = [
  {
    schema: "analytics",
    name: "bi_demo_sales",
    columns: [
      { name: "month", type: "DATE" },
      { name: "amount", type: "DOUBLE" },
      { name: "region", type: "VARCHAR" },
    ],
  } as WarehouseTable,
];

const base = {
  datasets: [localDataset],
  semantics,
  metrics,
  warehouses: [lakehouse],
  whTables: { "lh-1": lakehouseTables } as Record<string, WarehouseTable[] | "loading" | "error">,
  userId: "u1",
};

describe("generating from local datasets", () => {
  it("passes the local tables, their semantics and their metrics through", () => {
    const g = generationSource({ ...base, sourceKey: LOCAL_SOURCE_KEY });
    expect(g.datasets).toEqual([localDataset]);
    expect(g.semantics.size).toBe(1);
    expect(g.metrics).toHaveLength(1);
    expect(g.source).toEqual({ kind: "local" });
    expect(g.warehouse).toBeNull();
    // No dialect: the built-in engine is the one the prompts already assume.
    expect(g.dialect).toBeUndefined();
    expect(g.notReady).toBeNull();
  });

  it("says where to get data when there is none", () => {
    const g = generationSource({ ...base, datasets: [], sourceKey: LOCAL_SOURCE_KEY });
    expect(g.notReady).toMatch(/Data & SQL/);
  });
});

describe("generating from the lakehouse", () => {
  const g = () => generationSource({ ...base, sourceKey: "lh-1" });

  it("offers the lakehouse's own tables — the whole point", () => {
    expect(g().datasets.map((d) => d.name)).toEqual(["analytics.bi_demo_sales"]);
    expect(g().notReady).toBeNull();
  });

  it("records where the SQL will run, so refresh goes back there", () => {
    expect(g().source).toEqual({
      kind: "warehouse",
      connection_id: "lh-1",
      connection_name: "AgentSwarms Lakehouse",
      provider: "lakehouse",
    });
    expect(g().warehouse?.id).toBe("lh-1");
  });

  it("names the dialect, because the model is writing SQL for it", () => {
    expect(g().dialect).toBe("AgentSwarms Lakehouse (built-in)");
  });

  it("drops local semantics and metrics rather than applying them here", () => {
    // `revenue = SUM(amount)` was defined on the LOCAL saas_sales. Carrying it
    // onto a lakehouse table that also has an `amount` column would look like
    // a governed number and be an ungoverned guess.
    expect(g().semantics.size).toBe(0);
    expect(g().metrics).toEqual([]);
  });

  it("keeps a warehouse table's column types", () => {
    const cols = g().datasets[0].columns;
    expect(cols.find((c) => c.name === "amount")?.type).toBe("number");
    expect(cols.find((c) => c.name === "month")?.type).toBe("date");
    expect(cols.find((c) => c.name === "region")?.type).toBe("string");
  });
});

describe("what it refuses to start on", () => {
  it("waits for a schema that has not arrived", () => {
    for (const state of ["loading", undefined] as const) {
      const g = generationSource({
        ...base,
        whTables: state ? { "lh-1": state } : {},
        sourceKey: "lh-1",
      });
      expect(g.datasets).toEqual([]);
      expect(g.notReady).toMatch(/Reading the .* schema/);
    }
  });

  it("distinguishes a broken connection from a slow one", () => {
    // Both end in "no tables"; only one is fixed by waiting, so they must not
    // share a message.
    const err = generationSource({ ...base, whTables: { "lh-1": "error" }, sourceKey: "lh-1" });
    expect(err.notReady).toMatch(/test it/);
    expect(err.notReady).not.toMatch(/Reading/);
  });

  it("says so when the warehouse is reachable but empty", () => {
    const g = generationSource({ ...base, whTables: { "lh-1": [] }, sourceKey: "lh-1" });
    expect(g.notReady).toMatch(/no tables/);
  });

  it("never silently falls back to local data when the connection is gone", () => {
    // The dangerous failure: generating a dashboard over the wrong data and
    // looking like it worked.
    const g = generationSource({ ...base, warehouses: [], sourceKey: "lh-1" });
    expect(g.notReady).toMatch(/no longer available/);
    expect(g.datasets).toEqual([]);
  });
});

describe("the picker's options", () => {
  it("lists local first, then every connection by name and kind", () => {
    expect(generationSourceOptions([lakehouse])).toEqual([
      { key: "local", label: "Local & prepared datasets" },
      { key: "lh-1", label: "AgentSwarms Lakehouse — AgentSwarms Lakehouse (built-in)" },
    ]);
  });

  it("is a single entry when nothing is connected, so the dialog can hide it", () => {
    expect(generationSourceOptions([])).toHaveLength(1);
  });
});

describe("the routes that host the generators", () => {
  // Wiring the DIALOG was only half the fix. The report editor is its own
  // route, and it handed the dialog `warehouses: []`, `whTables: {}`, a no-op
  // `ensureSchema` and a `runSql` that threw "A report generates from local
  // datasets" — so the picker had nothing to offer and the feature was
  // impossible there no matter what the dialog did. Every dialog-level test
  // passed while that was true, which is why this one reads the route.
  it("give the report generator a real warehouse context", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/routes/_authenticated/bi_.report.$reportId.tsx", "utf8");
    expect(src).not.toMatch(/warehouses:\s*\[\]/);
    expect(src).not.toMatch(/whTables:\s*\{\}/);
    expect(src).not.toMatch(/ensureSchema:\s*\(\)\s*=>\s*\{\}/);
    expect(src).not.toMatch(/throw new Error\("A report generates from local datasets"\)/);
    // And it must actually reach a warehouse, not just stop throwing.
    expect(src).toContain("runWarehouseQuery(token, source.connection_id, sql)");
    expect(src).toContain("fetchWarehouseSchema(token, connId)");
    expect(src).toContain("listWarehouseConnections");
  });

  it("cap a report block's rows like a widget, not like a preview", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/routes/_authenticated/bi_.report.$reportId.tsx", "utf8");
    // A table somebody checks a row of must not quietly stop at the
    // workbench's 50-row preview cap.
    expect(src).toContain("runQueryUnlimited(sql, widgetRowCap())");
  });
});

describe("both dialogs resolve the source the same way", () => {
  it("and neither hardcodes a local source onto a generated widget", async () => {
    const fs = await import("node:fs");
    for (const f of [
      "src/components/bi/GenerateDashboardDialog.tsx",
      "src/components/bi/GenerateReportDialog.tsx",
    ]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, `${f} should resolve its source`).toContain("generationSource(");
      // The original defect, in one line each.
      expect(src, `${f} must not pin widgets to local`).not.toContain(
        'widgetFromBiTurn(turn, { kind: "local" })',
      );
      expect(src, `${f} should run the SQL where the data is`).toContain(
        "ctx.runSql(gen.source, sql)",
      );
      // The CONDITION, not just the call: mutation-checked, an `if (false)`
      // wrapper left a `toContain("ctx.ensureSchema(...)")` assertion green
      // while the warehouse table list stayed permanently empty.
      //
      // And it must be fetched on the PICK, not in an effect: `ensureSchema`
      // re-fetches a connection left in "error", so an effect re-running on
      // every `whTables` change would retry a broken warehouse forever.
      expect(src, `${f} should load the schema it offers`).toMatch(
        /if \(v !== LOCAL_SOURCE_KEY\) ctx\.ensureSchema\(v\)/,
      );
      expect(src, `${f} must not fetch schemas from an effect`).not.toMatch(
        /useEffect\([^)]*ensureSchema/s,
      );
    }
  });
});
