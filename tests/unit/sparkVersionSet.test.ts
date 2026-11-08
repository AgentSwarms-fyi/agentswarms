// One Spark version set, everywhere a Spark is started or a client is pinned
// (R459).
//
// Asked for "the versions where everything works with everything". Spark 4.2
// was not that: Iceberg publishes a Spark runtime for 4.0 and 4.1 only, so on
// 4.2 the engine had no Iceberg. On 4.1.4 every connector has a build for the
// same Spark (sparkVersions.ts lists them, with what was checked). This holds
// the places that cannot import that module to the same set: the Compose
// endpoint, the sandbox image's client, the admin form's hint. A bump that
// misses one fails here instead of at the first s3a:// read or the first
// Connect call from a client one protocol version off.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DELTA_VERSION,
  HADOOP_AWS_VERSION,
  ICEBERG_VERSION,
  SPARK_IMAGE,
  SPARK_PACKAGES,
  SPARK_SQL_EXTENSIONS,
  SPARK_VERSION,
} from "@/utils/etl/sparkVersions";

const rd = (p: string) => readFileSync(p, "utf8");
const minor = (v: string) => v.split(".").slice(0, 2).join(".");

describe("the version set itself", () => {
  it("is Spark 4.1, the newest Spark Iceberg builds a runtime for", () => {
    expect(minor(SPARK_VERSION)).toBe("4.1");
    expect(SPARK_IMAGE.startsWith(`apache/spark:${SPARK_VERSION}-python3@sha256:`)).toBe(true);
  });

  it("names every connector for that Spark minor, at one version each", () => {
    const pkgs = SPARK_PACKAGES.split(",");
    expect(pkgs).toContain(`io.delta:delta-spark_${minor(SPARK_VERSION)}_2.13:${DELTA_VERSION}`);
    expect(pkgs).toContain(
      `org.apache.iceberg:iceberg-spark-runtime-${minor(SPARK_VERSION)}_2.13:${ICEBERG_VERSION}`,
    );
    // The S3 FileIO that applies credentials a REST catalog vends.
    expect(pkgs).toContain(`org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}`);
    // Spark 4.1.4's image ships hadoop-client 3.4.2 (measured: /opt/spark/jars).
    expect(pkgs).toContain(`org.apache.hadoop:hadoop-aws:${HADOOP_AWS_VERSION}`);
    expect(HADOOP_AWS_VERSION).toBe("3.4.2");
    // No unversioned Delta artifact: delta-spark_2.13 is built for Spark 4.2.
    expect(pkgs.some((p) => p.startsWith("io.delta:delta-spark_2.13:"))).toBe(false);
  });

  it("loads both formats' SQL extensions", () => {
    expect(SPARK_SQL_EXTENSIONS.split(",")).toEqual([
      "io.delta.sql.DeltaSparkSessionExtension",
      "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions",
    ]);
  });
});

describe("every place that starts Spark or pins its client agrees", () => {
  const compose = rd("docker-compose.yml");
  const block = compose.slice(
    compose.indexOf("  spark-connect:"),
    compose.indexOf("  # ── Server-side Office renderer"),
  );

  it("the Compose endpoint runs the same image, packages and extensions", () => {
    expect(block).toContain(`image: ${SPARK_IMAGE}`);
    expect(block).toContain(`--packages ${SPARK_PACKAGES} \\`);
    expect(block).toContain(`--conf spark.sql.extensions=${SPARK_SQL_EXTENSIONS} \\`);
    expect(block).not.toMatch(/apache\/spark:4\.2/);
  });

  it("neither server runs the Spark UI, which listed every run's per-call S3 keys", () => {
    expect(block).toContain("--conf spark.ui.enabled=false \\");
    expect(rd("src/utils/etl/sparkCluster.server.ts")).toContain("`spark.ui.enabled=false`,");
  });

  it("the per-run cluster defaults to the same set", () => {
    const src = rd("src/utils/etl/sparkCluster.server.ts");
    expect(src).toContain("const DEFAULT_PACKAGES = SPARK_PACKAGES;");
    expect(src).toContain("const DEFAULT_IMAGE = SPARK_IMAGE;");
    expect(src).toContain("`spark.sql.extensions=${SPARK_SQL_EXTENSIONS}`");
  });

  it("the sandbox image's Spark Connect client is the server's exact version", () => {
    const req = rd("docker/notebook-runtime/requirements.txt");
    expect(req).toMatch(
      new RegExp(`^pyspark-client==${SPARK_VERSION.replace(/\./g, "\\.")}$`, "m"),
    );
  });

  it("the admin form asks for the same Spark", () => {
    const tab = rd("src/components/admin/RuntimeTab.tsx");
    expect(tab).toContain(`placeholder="apache/spark:${SPARK_VERSION}-python3"`);
    expect(tab).toContain(`Must be Spark ${minor(SPARK_VERSION)}`);
  });

  it("the image scan's baseline names no Spark the platform no longer runs", () => {
    const baseline = rd(".github/grype-baseline.yaml");
    for (const m of baseline.matchAll(/apache\/spark[: ](\d+\.\d+\.\d+)/g)) {
      expect(m[1]).toBe(SPARK_VERSION);
    }
  });
});
