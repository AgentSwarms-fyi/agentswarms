// A partitioned folder reaches a pipeline as a recursive glob, and its partition
// values are in the paths, not in the files. Found by reading what the compiler
// generates: the catalog listed `sales` with `dt` and `region`, and a pipeline
// reading it would have had neither.
import { describe, expect, it } from "vitest";

import { sourceFn, type EtlGraph, type EtlNode } from "@/utils/etl/codegen";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";

const node = (path: string, extra: Record<string, unknown> = {}): EtlNode =>
  ({
    id: "s1",
    kind: "source",
    label: "sales",
    config: { type: "object_storage", path, format: "parquet", ...extra },
  }) as EtlNode;

describe("a partitioned folder as a pipeline source", () => {
  const code = sourceFn(node("warehouse/sales/**/*.parquet"));

  it("takes each file's partition values from its path", () => {
    expect(code).toContain("def _with_partitions(df, key):");
    expect(code).toContain("frames.append(_with_partitions(pd.read_parquet(f), k))");
  });

  it("decodes them, and reads Hive's marker for a null as a null", () => {
    expect(code).toContain("unquote(value)");
    expect(code).toContain("__HIVE_DEFAULT_PARTITION__");
  });

  it("does the same for auto-ingest, which reads files one at a time too", () => {
    const ingest = sourceFn(node("warehouse/sales/**/*.parquet", { new_files_only: true }));
    expect(ingest).toContain("frames.append(_with_partitions(pd.read_parquet(f), k))");
  });

  it("leaves any other path as it was", () => {
    const plain = sourceFn(node("landing/*.parquet"));
    expect(plain).not.toContain("_with_partitions");
    expect(plain).toContain("frames.append(pd.read_parquet(f))");
  });
});

describe("the same table on the Spark engine", () => {
  const graph = (path: string): EtlGraph => ({
    nodes: [
      node(path),
      {
        id: "t1",
        kind: "target",
        label: "Lakehouse",
        config: { type: "lakehouse", schema: "analytics", table: "sales", write_mode: "append" },
      },
    ] as EtlGraph["nodes"],
    edges: [{ id: "e1", from: "s1", to: "t1" }],
  });

  it("reads the folder, because Hadoop's glob has no recursive `**`", () => {
    // MEASURED on Spark 4.2: the glob fails with PATH_NOT_FOUND on two levels of
    // partitions, and the folder gives 6,000 rows with `dt` and `region`.
    const program = compileSparkGraph(graph("warehouse/sales/**/*.parquet"));
    expect(program).toContain("_p = 's3a://' + _base + '/' + 'warehouse/sales/'.lstrip('/')");
  });

  it("leaves a plain glob alone", () => {
    expect(compileSparkGraph(graph("landing/*.parquet"))).toContain("'landing/*.parquet'");
  });
});
