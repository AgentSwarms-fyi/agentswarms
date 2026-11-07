// The Iceberg panel's reading of a table, against metadata a real engine
// wrote: Spark 4.1 with Iceberg 1.12, through a REST catalog, captured as
// DuckDB 1.5.5 returns it (tests/fixtures/iceberg-spark-metadata.json, R457).
// orders_v3 is format 3 with deletion vectors, a renamed and an added column,
// a partition spec that changed, a sort order, a branch and a tag.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  allSnapshotIds,
  fileCountsFrom,
  icebergTypeName,
  inspectIcebergMetadata,
  mountViewTarget,
  resolveSnapshotRef,
  safeProperties,
  schemaChanges,
} from "@/utils/lakehouse/icebergInspect";

type Captured = {
  metadata: unknown;
  files: {
    manifest_content: string;
    content: string;
    file_format: string;
    files: number;
    records: number;
  }[];
};
const fixture = JSON.parse(
  readFileSync("tests/fixtures/iceberg-spark-metadata.json", "utf8"),
) as Record<"orders_v3" | "orders_v2", Captured>;
const opts = { catalog: "rig", namespace: "sales", table: "orders_v3" };

describe("a v3 table Spark wrote", () => {
  const v3 = fixture.orders_v3;
  const t = inspectIcebergMetadata(v3.metadata, fileCountsFrom(v3.files), opts);

  it("reads the format version and the v3 features actually in use", () => {
    expect(t.format_version).toBe(3);
    expect(t.features.deletion_vectors).toBe(true);
    expect(t.features.row_lineage).toBe(true);
    expect(t.features.variant).toBe(true);
    expect(t.features.geospatial).toBe(false);
  });

  it("keeps 64-bit snapshot ids exact, as strings", () => {
    // 7259124565828023429 as a JS number is 7259124565828023000: a snapshot
    // that does not exist.
    const ids = allSnapshotIds(v3.metadata);
    expect(ids).toContain("7259124565828023429");
    expect(t.snapshots.every((s) => typeof s.id === "string" && /^\d+$/.test(s.id))).toBe(true);
    expect(t.current_snapshot_id).toMatch(/^\d{15,20}$/);
  });

  it("lists snapshots newest first, with what each did", () => {
    expect(t.snapshot_count).toBe(ids().length);
    expect(t.snapshots[0].sequence).toBeGreaterThan(
      t.snapshots[t.snapshots.length - 1].sequence ?? 0,
    );
    expect(t.snapshots.map((s) => s.operation)).toEqual(
      expect.arrayContaining(["append", "overwrite", "delete"]),
    );
    const first = t.snapshots[t.snapshots.length - 1];
    expect(first.added_records).toBe(10000);
    function ids() {
      return allSnapshotIds(v3.metadata);
    }
  });

  it("names the branch and the tag, main first", () => {
    expect(t.refs.map((r) => `${r.type}:${r.name}`)).toEqual([
      "branch:main",
      "branch:audit",
      "tag:q3-close",
    ]);
  });

  it("follows the schema's evolution by field id: a rename is not a drop and an add", () => {
    expect(t.schema_versions).toBe(3);
    expect(t.schema_changes).toEqual([
      "customer renamed to customer_name (schema 1)",
      "channel added (schema 2)",
    ]);
    expect(t.columns.map((c) => c.name)).toEqual([
      "id",
      "customer_name",
      "region",
      "amount",
      "ts",
      "payload",
      "channel",
    ]);
  });

  it("shows the current partition spec, and that it changed", () => {
    expect(t.partition_spec).toEqual([
      { name: "ts_day", transform: "day", source: "ts" },
      { name: "id_bucket", transform: "bucket[4]", source: "id" },
      { name: "region", transform: "identity", source: "region" },
    ]);
    expect(t.partition_spec_versions).toBe(2);
    expect(t.sort_order.map((s) => `${s.source} ${s.direction}`)).toEqual(["region asc", "id asc"]);
  });

  it("counts the live files by kind: Puffin deletes are deletion vectors", () => {
    // Spark reported 48 Puffin delete files when it wrote the table. Two more
    // are listed in the manifests as removed (status DELETED); counting them
    // read 50, the UI pass's finding (R457).
    expect(t.files).toEqual({
      data_files: 153,
      data_records: 10175,
      position_delete_files: 0,
      deletion_vector_files: 48,
      equality_delete_files: 0,
      deleted_records: 50,
    });
  });

  it("says how many rows a reader sees, not how many records the data files hold", () => {
    const main = t.snapshots.find((s) => s.refs.includes("main"));
    // 10,175 records in data files, 50 of them deleted by position: Spark
    // and the engine both read 10,125. The list said 10,176 before (R457, UI).
    expect(main?.total_records).toBe(10175);
    expect(main?.rows).toBe(10125);
    const audit = t.snapshots.find((s) => s.refs.includes("audit"));
    expect(audit?.rows).toBe(10126);
    expect(t.snapshots[0].refs).toEqual(["audit"]);
  });

  it("advises upkeep with the Spark procedure, naming the catalog as registered", () => {
    const kinds = t.advice.map((a) => a.kind);
    expect(kinds).toContain("deletes");
    expect(kinds).toContain("compact");
    expect(kinds).not.toContain("upgrade");
    const compact = t.advice.find((a) => a.kind === "compact");
    expect(compact?.title).toBe("153 data files averaging 67 rows");
    expect(compact?.sql).toBe("CALL rig.system.rewrite_data_files(table => 'sales.orders_v3')");
  });

  it("time-travels to a branch or a tag through its snapshot id", () => {
    const ids = allSnapshotIds(v3.metadata);
    expect(resolveSnapshotRef(t.refs, ids, "q3-close")).toBe("7673858549884858483");
    expect(resolveSnapshotRef(t.refs, ids, "audit")).toBe("639915463891739903");
    expect(resolveSnapshotRef(t.refs, ids, "7259124565828023429")).toBe("7259124565828023429");
    expect(resolveSnapshotRef(t.refs, ids, "123")).toBeNull();
    expect(resolveSnapshotRef(t.refs, ids, "1; DROP TABLE x")).toBeNull();
  });
});

describe("a v2 table", () => {
  const v2 = fixture.orders_v2;
  const t = inspectIcebergMetadata(v2.metadata, fileCountsFrom(v2.files), {
    ...opts,
    table: "orders_v2",
  });

  it("is read as v2, its positional deletes as Parquet, and an upgrade is offered as information", () => {
    expect(t.format_version).toBe(2);
    expect(t.features.deletion_vectors).toBe(false);
    expect(t.features.row_lineage).toBe(false);
    expect(t.files?.position_delete_files).toBe(6);
    expect(t.files?.deletion_vector_files).toBe(0);
    const upgrade = t.advice.find((a) => a.kind === "upgrade");
    expect(upgrade?.detail).toContain("cannot be undone");
    expect(upgrade?.sql).toBe(
      "ALTER TABLE rig.sales.orders_v2 SET TBLPROPERTIES ('format-version' = '3')",
    );
    // 200 deleted of 2,000: a tenth, so rewriting the deletes is advised.
    expect(t.advice.map((a) => a.kind)).toContain("deletes");
  });
});

describe("the pieces", () => {
  it("spells nested types out", () => {
    expect(icebergTypeName("long")).toBe("long");
    expect(icebergTypeName({ type: "list", element: "string" })).toBe("list<string>");
    expect(icebergTypeName({ type: "map", key: "string", value: "int" })).toBe("map<string, int>");
    expect(
      icebergTypeName({
        type: "struct",
        fields: [
          { name: "city", type: "string" },
          { name: "zip", type: "string" },
        ],
      }),
    ).toBe("struct<city: string, zip: string>");
  });

  it("never shows a property that could hold a credential", () => {
    const shown = safeProperties({
      owner: "spark",
      "s3.secret-access-key": "x",
      "s3.access-key-id": "x",
      "rest.token": "x",
      "client.password": "x",
      "write.format.default": "parquet",
    }).map((p) => p.key);
    expect(shown).toEqual(["owner", "write.format.default"]);
  });

  it("reads a drop and a retype between schema versions", () => {
    const s = (id: number, fields: { id: number; name: string; type: string }[]) => ({
      "schema-id": String(id),
      fields: fields.map((f) => ({ ...f, id: String(f.id), required: false })),
    });
    expect(
      schemaChanges([
        s(0, [
          { id: 1, name: "a", type: "int" },
          { id: 2, name: "b", type: "string" },
        ]),
        s(1, [{ id: 1, name: "a", type: "long" }]),
      ]),
    ).toEqual(["a changed from int to long (schema 1)", "b dropped (schema 1)"]);
  });

  it("finds the table a mount's view reads, quoted or not, and nothing else", () => {
    const alias = `ice_${"a".repeat(32)}`;
    expect(
      mountViewTarget(
        `CREATE VIEW ice_sales.daily_metrics AS SELECT * FROM "${alias}"."sales-prod"."daily-metrics";`,
      ),
    ).toEqual({ alias, namespace: "sales-prod", table: "daily-metrics" });
    expect(mountViewTarget(`CREATE VIEW s.v AS SELECT * FROM ${alias}.sales.orders;`)).toEqual({
      alias,
      namespace: "sales",
      table: "orders",
    });
    expect(mountViewTarget(`CREATE VIEW s.v AS SELECT * FROM lake.analytics.orders;`)).toBeNull();
  });
});
