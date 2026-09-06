// Everything a pipeline reads from or writes to is picked, not typed. Pinned
// here: how a Data Catalog asset resolves to the source the compiler already
// knows (each kind, each refusal), how the compiler and the run service read
// it as that source with the cursor carried across and lineage naming the
// asset, the reverse-ETL target's bearer token as a picked secret, and the
// editor's pickers standing where the typed fields were.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  catalogAssetLineage,
  describeResolvedSource,
  isCatalogAsset,
  resolveCatalogAsset,
  unwrapSourceConfig,
  type CatalogAssetSourceConfig,
} from "@/utils/etl/catalogAsset";
import { compileGraph, requirementsFor, type EtlGraph, type EtlNode } from "@/utils/etl/codegen";
import { AWS_REGIONS } from "@/utils/etl/streaming";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

const node = (id: string, kind: EtlNode["kind"], config: Record<string, unknown>): EtlNode =>
  ({ id, kind, config }) as EtlNode;
const STORE_TGT = node("n9", "target", {
  type: "object_storage",
  dataset: "etl",
  table: "items",
  format: "parquet",
  write_mode: "replace",
});
const graphOf = (source: EtlNode, target = STORE_TGT): EtlGraph => ({
  nodes: [source, target],
  edges: [{ id: "e1", from: source.id, to: target.id }],
});

const table = {
  asset_type: "table",
  schema_name: "public",
  name: "orders",
  fqn: "public.orders",
  format: null,
};
const warehouse = { id: "src-1", kind: "warehouse", connection_id: "conn-1", name: "Warehouse" };
const bucket = { id: "src-2", kind: "object_storage", connection_id: null, name: "Bucket" };

describe("a catalog asset resolves to the source it stands for", () => {
  it("a warehouse table or view is a database read through the source's connection", () => {
    expect(resolveCatalogAsset(table, warehouse, { provider: "postgres" })).toEqual({
      ok: true,
      resolved: {
        type: "database",
        connection_id: "conn-1",
        provider: "postgres",
        mode: "table",
        table: "public.orders",
      },
    });
    expect(resolveCatalogAsset({ ...table, asset_type: "view" }, warehouse).ok).toBe(true);
    expect(resolveCatalogAsset({ ...table, asset_type: "file" }, warehouse)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a table or a view"),
    });
    expect(resolveCatalogAsset(table, { ...warehouse, connection_id: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no connection"),
    });
  });

  it("the lakehouse's own tables are lakehouse reads, by schema and name", () => {
    const facts = {
      asset_type: "table",
      schema_name: "analytics",
      name: "revenue_facts",
      fqn: "analytics.revenue_facts",
      format: null,
    };
    expect(resolveCatalogAsset(facts, warehouse, { provider: "lakehouse" })).toEqual({
      ok: true,
      resolved: { type: "lakehouse", schema: "analytics", mode: "table", table: "revenue_facts" },
    });
    expect(
      resolveCatalogAsset({ ...facts, schema_name: null }, warehouse, { provider: "lakehouse" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("no schema") });
  });

  it("a bucket file or folder is an object-storage read, in a format the engine has", () => {
    expect(
      resolveCatalogAsset(
        {
          asset_type: "file",
          schema_name: "raw",
          name: "orders.csv",
          fqn: "raw/orders.csv",
          format: "csv",
        },
        bucket,
      ),
    ).toEqual({
      ok: true,
      resolved: {
        type: "object_storage",
        catalog_source_id: "src-2",
        path: "raw/orders.csv",
        format: "csv",
      },
    });
    // A root-level folder glob loses the crawler's "./"; ndjson is the jsonl reader.
    expect(
      resolveCatalogAsset(
        {
          asset_type: "dataset",
          schema_name: null,
          name: "*.ndjson",
          fqn: "./*.ndjson",
          format: "ndjson",
        },
        bucket,
      ),
    ).toEqual({
      ok: true,
      resolved: {
        type: "object_storage",
        catalog_source_id: "src-2",
        path: "*.ndjson",
        format: "jsonl",
      },
    });
    // The extension answers when the crawl recorded no format.
    expect(
      resolveCatalogAsset(
        {
          asset_type: "file",
          schema_name: null,
          name: "x.parquet",
          fqn: "x.parquet",
          format: null,
        },
        bucket,
      ),
    ).toMatchObject({ ok: true, resolved: { format: "parquet" } });
    expect(
      resolveCatalogAsset(
        { asset_type: "file", schema_name: null, name: "logo.png", fqn: "logo.png", format: "png" },
        bucket,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("PNG") });
    expect(resolveCatalogAsset({ ...table, asset_type: "table" }, bucket)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a file or a dataset"),
    });
  });

  it("an Iceberg REST table points at the lakehouse mount, and an unknown kind refuses", () => {
    expect(
      resolveCatalogAsset(table, { id: "s", kind: "iceberg_rest", connection_id: null }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Lakehouse → Iceberg") });
    expect(
      resolveCatalogAsset(table, { id: "s", kind: "other", connection_id: null }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("unwraps to the resolution with the cursor carried, and refuses an asset never picked", () => {
    const c: CatalogAssetSourceConfig = {
      type: "catalog_asset",
      asset_id: "a",
      source_id: "s",
      fqn: "public.orders",
      resolved: {
        type: "database",
        connection_id: "conn-1",
        mode: "table",
        table: "public.orders",
      },
      incremental: { cursor_column: "updated_at" },
    };
    expect(unwrapSourceConfig(c)).toEqual({
      type: "database",
      connection_id: "conn-1",
      mode: "table",
      table: "public.orders",
      incremental: { cursor_column: "updated_at" },
    });
    expect(unwrapSourceConfig({ type: "http_api", url: "x" })).toEqual({
      type: "http_api",
      url: "x",
    });
    expect(() =>
      unwrapSourceConfig({ type: "catalog_asset", asset_id: "", source_id: "", fqn: "" }),
    ).toThrow("pick an asset");
    expect(isCatalogAsset(c)).toBe(true);
    expect(isCatalogAsset({ type: "database" })).toBe(false);
    expect(catalogAssetLineage(c)).toBe("catalog:public.orders");
    expect(describeResolvedSource(undefined)).toContain("No asset");
    expect(describeResolvedSource(c.resolved)).toContain("public.orders");
  });
});

describe("the compiler reads a catalog asset as what it resolved to", () => {
  it("a warehouse asset compiles as a database read, keeps its cursor, and lineage names the asset", () => {
    const g = graphOf(
      node("n1", "source", {
        type: "catalog_asset",
        asset_id: "a",
        source_id: "s",
        fqn: "public.orders",
        resolved: {
          type: "database",
          connection_id: "conn-1",
          provider: "postgres",
          mode: "table",
          table: "public.orders",
        },
        incremental: { cursor_column: "updated_at" },
      }),
    );
    const code = compileGraph(g);
    expect(code).toContain("def _src_n1():");
    expect(code).toContain("public.orders");
    expect(code).toContain("'lineage_sources': ['catalog:public.orders']");
    expect(code).toContain("updated_at");
    expect(code).toContain("_watermarks");
    expect(requirementsFor(g)).toContain("sqlalchemy");
  });

  it("a lakehouse asset brings the lakehouse helper, a bucket asset its reader, an unpicked one refuses", () => {
    const lake = graphOf(
      node("n1", "source", {
        type: "catalog_asset",
        asset_id: "a",
        source_id: "s",
        fqn: "analytics.revenue_facts",
        resolved: { type: "lakehouse", schema: "analytics", mode: "table", table: "revenue_facts" },
      }),
    );
    expect(compileGraph(lake)).toContain("_lakehouse_con()");
    expect(requirementsFor(lake)).toContain("duckdb");
    const files = graphOf(
      node("n1", "source", {
        type: "catalog_asset",
        asset_id: "a",
        source_id: "s",
        fqn: "raw/orders.csv",
        resolved: {
          type: "object_storage",
          catalog_source_id: "s",
          path: "raw/orders.csv",
          format: "csv",
        },
      }),
    );
    expect(compileGraph(files)).toContain("raw/orders.csv");
    expect(requirementsFor(files)).toContain("s3fs");
    expect(() =>
      compileGraph(
        graphOf(
          node("n1", "source", { type: "catalog_asset", asset_id: "", source_id: "", fqn: "" }),
        ),
      ),
    ).toThrow("pick an asset");
  });
});

describe("a reverse-ETL target's bearer token is a picked secret", () => {
  const src = node("n1", "source", { type: "http_api", url: "https://api.example.com/items" });
  it("compiles to the node's own env stem, and the older env-var binding still works", () => {
    const withSecret = compileGraph(
      graphOf(
        src,
        node("n9", "target", {
          type: "http_api",
          url: "https://x.test/in",
          auth_secret: "API_TOKEN",
        }),
      ),
    );
    expect(withSecret).toMatch(/os\.environ\.get\('[A-Z0-9_]+_AUTH_TOKEN'\)/);
    expect(withSecret).not.toContain("API_TOKEN");
    const legacy = compileGraph(
      graphOf(
        src,
        node("n9", "target", { type: "http_api", url: "https://x.test/in", auth_env: "MY_TOKEN" }),
      ),
    );
    expect(legacy).toContain("os.environ.get('MY_TOKEN')");
  });
});

describe("the wiring", () => {
  it("the run service resolves an asset as its source, checks lakehouse access on it, binds the token", () => {
    const svc = flat(rd("src/utils/etl/service.server.ts"));
    expect(svc).toContain("isCatalogAsset(raw) ? unwrapSourceConfig(raw) : raw");
    expect(svc).toContain('effective(n).type === "lakehouse"');
    expect(svc).toContain('const schema = effective(node).schema ?? "";');
    expect(svc).toContain("env[`${stem}_AUTH_TOKEN`] = value;");
    expect(svc).toContain("isCatalogAsset(c) ? c.source_id : c.catalog_source_id");
  });

  it("the editor lists the catalog source and picks everything the platform knows", () => {
    const ui = flat(rd("src/routes/_authenticated/etl.tsx"));
    expect(rd("src/utils/etl/nodeDefaults.ts")).toContain(
      '{ type: "catalog_asset", label: "Data Catalog asset" }',
    );
    for (const p of [
      "<CatalogAssetPicker",
      "<LakehousePicker",
      "<WarehouseTablePicker",
      "<StoragePathPicker",
      "<StorageTargetPicker",
      "<SecretPicker",
      "<RegionPicker",
    ]) {
      expect(ui, p).toContain(p);
    }
    // The typed fields the pickers replaced are gone.
    for (const gone of [
      'placeholder="schema.orders"',
      'placeholder="raw/orders/*.csv"',
      'placeholder="MY_API_TOKEN"',
      'placeholder="us-east-1"',
      "unCsv(",
    ]) {
      expect(ui, gone).not.toContain(gone);
    }
    // Merge keys and the cursor are picked from known columns.
    expect(ui).toContain('<Field label="Incremental cursor column (optional)"> <ColumnCombo');
    expect(ui).toContain('<Field label="Primary key columns"> <ColumnChips');
    const pickers = rd("src/components/etl/SourcePickers.tsx");
    for (const name of [
      "CatalogAssetPicker",
      "LakehousePicker",
      "WarehouseTablePicker",
      "StoragePathPicker",
      "StorageTargetPicker",
      "SecretPicker",
      "RegionPicker",
      "useSecretNames",
    ]) {
      expect(pickers, name).toContain(`export function ${name}`);
    }
    expect(rd("src/utils/etl.functions.ts")).toContain(
      "export const etlListWarehouseTables = createServerFn",
    );
    expect(rd("src/utils/etl.functions.ts")).toContain(
      "export const etlListLakehouseTables = createServerFn",
    );
    // Each picker is a hierarchy: one level narrows the next.
    for (const level of [
      'placeholder="Choose a catalog source"',
      'label={isBucket ? "Folder" : "Schema"}',
      'label={isBucket ? "File or dataset" : "Table or view"}',
      'label="Folder"',
      'label="Lakehouse schema"',
      "allowNew ? schemas.filter((s) => s.writable) : schemas",
    ]) {
      expect(pickers, level).toContain(level);
    }
    // The lakehouse picker reads the fast listing, never the row-counting overview.
    expect(pickers).not.toContain("getLakehouseOverview");
    expect(AWS_REGIONS.map((r) => r.code)).toContain("eu-west-1");
    expect(new Set(AWS_REGIONS.map((r) => r.code)).size).toBe(AWS_REGIONS.length);
  });

  it("the docs say so", () => {
    expect(rd("docs/ETL_PIPELINES.md")).toContain("## Picking sources and targets");
    expect(flat(rd("src/routes/docs.etl.tsx"))).toContain("A Data Catalog asset");
    expect(rd("README.md")).toContain("Data Catalog assets");
  });
});
