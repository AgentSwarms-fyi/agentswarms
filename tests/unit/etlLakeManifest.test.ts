// What an ETL run may do in the lakehouse: its declared reads and loads.
//
// The sandbox holds no lakehouse credential; it asks the app for these by node
// id, and the app serves nothing else (sandboxLake.server). So what is
// declared here is the whole of what a run can touch.
import { describe, expect, it } from "vitest";

import { etlLakeManifest } from "@/utils/etl/lakeManifest";

const src = (id: string, config: Record<string, unknown>) => ({ id, kind: "source", config });
const tgt = (id: string, config: Record<string, unknown>) => ({ id, kind: "target", config });

const graph = {
  nodes: [
    src("s1", { type: "lakehouse", schema: "sales", mode: "table", table: "orders" }),
    src("s2", { type: "lakehouse", schema: "sales", mode: "query", query: "SELECT 1 AS x" }),
    src("s3", {
      type: "catalog_asset",
      asset_id: "a",
      source_id: "c",
      fqn: "sales.refunds",
      resolved: { type: "lakehouse", schema: "sales", mode: "table", table: "refunds" },
    }),
    src("k", { type: "ingest" }),
    tgt("t1", { type: "lakehouse", schema: "mine", table: "out", write_mode: "append" }),
    tgt("t2", {
      type: "lakehouse",
      schema: "mine",
      table: "keyed",
      write_mode: "merge",
      primary_key: ["id"],
    }),
    tgt("t3", { type: "lakehouse", schema: "mine", table: "snap", write_mode: "replace" }),
  ],
};

describe("an ETL run's lakehouse manifest", () => {
  it("declares each lakehouse read and load by node, a catalog asset as what it resolved to", () => {
    const m = etlLakeManifest({ id: "p1", schedule: "manual" }, graph)!;
    expect(m.reads).toEqual({
      s1: { label: "s1", sql: 'SELECT * FROM "sales"."orders"' },
      s2: { label: "s2", sql: "SELECT 1 AS x" },
      s3: { label: "s3", sql: 'SELECT * FROM "sales"."refunds"' },
    });
    expect(m.writes).toEqual({
      t1: { label: "t1", schema: "mine", table: "out", mode: "append", primaryKey: [] },
      t2: { label: "t2", schema: "mine", table: "keyed", mode: "upsert", primaryKey: ["id"] },
      t3: { label: "t3", schema: "mine", table: "snap", mode: "replace", primaryKey: [] },
    });
    expect(m.cursors).toBeUndefined();
  });

  it("gives a preview no loads", () => {
    const m = etlLakeManifest({ id: "p1", schedule: "manual" }, graph, { skipTargets: true })!;
    expect(m.writes).toEqual({});
    expect(Object.keys(m.reads)).toEqual(["s1", "s2", "s3"]);
  });

  it("commits cursors only for a continuous exactly-once run, and only for its own sources", () => {
    const m = etlLakeManifest({ id: "p1", schedule: "continuous" }, graph)!;
    expect(m.cursors).toEqual({ pipelineId: "p1", nodes: ["s1", "s2", "s3", "k"] });
    // A storage target takes the run out of exactly-once: no cursors commit with loads.
    const mixed = {
      nodes: [...graph.nodes, tgt("t4", { type: "object_storage", dataset: "d", table: "x" })],
    };
    expect(etlLakeManifest({ id: "p1", schedule: "continuous" }, mixed)!.cursors).toBeUndefined();
  });

  it("is nothing at all for a run that does not touch the lakehouse", () => {
    expect(
      etlLakeManifest({ id: "p1", schedule: "manual" }, { nodes: [src("k", { type: "ingest" })] }),
    ).toBeNull();
  });
});
