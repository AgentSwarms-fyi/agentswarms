// The Spark version set: one Spark, and a build of every connector for it.
//
// R459. The question was which versions work with everything else. Spark 4.2
// did not: Iceberg publishes a Spark runtime for 4.0 and 4.1 only
// (`iceberg-spark-runtime-4.2_2.13` is not on Maven Central, checked
// 2026-11-08), so on 4.2 the Spark engine had no Iceberg at all. Spark 4.1.4
// is the newest release every piece is built for:
//
//   Spark          4.1.4   apache/spark:4.1.4-python3 (Java 21, Scala 2.13)
//   Delta          4.4.1   io.delta:delta-spark_4.1_2.13, built against Spark 4.1.0
//   Iceberg        1.12.0  iceberg-spark-runtime-4.1_2.13 + iceberg-aws-bundle
//   hadoop-aws     3.4.2   equal to the image's own hadoop-client jars; any
//                          other version fails at the first s3a:// read
//   pyspark-client 4.1.4   the sandbox image's Spark Connect client
//
// Everything that starts a Spark server or names one of these reads it from
// here, and tests/unit/sparkVersionSet.test.ts holds the places that cannot
// import it (the Compose file, the Kubernetes manifest, the sandbox image's
// requirements) to the same set. Move them together.

export const SPARK_VERSION = "4.1.4";

/** The image the per-run cluster and the Compose endpoint run, by digest. */
export const SPARK_IMAGE =
  "apache/spark:4.1.4-python3@sha256:847f91f8bb2f28d632064dfe632d423020f8fd60b27c7704c0e5bf5b0c6432c7";

export const ICEBERG_VERSION = "1.12.0";
export const DELTA_VERSION = "4.4.1";
export const HADOOP_AWS_VERSION = "3.4.2";

/**
 * SQLite's JDBC driver, for the catalog an Iceberg pipeline target commits
 * through: an in-memory database that lives in the run's own Spark session
 * (sparkCodegen's icebergStorageTarget). Iceberg's in-memory catalog cannot
 * do it, measured: it reads and writes metadata through an in-memory file
 * store whatever io-impl says ("No in-memory file found for location").
 * 3.53.4.0 (2026-08-26) rather than 3.54.1.0, which was ten days old.
 */
export const SQLITE_JDBC_VERSION = "3.53.4.0";

/**
 * The connectors a pipeline or a lakehouse job can need, resolved by the
 * driver at startup: S3A, Delta, Iceberg (with its S3 FileIO, which is what
 * applies credentials a REST catalog vends), the two JDBC drivers, and
 * SQLite's for the per-run Iceberg catalog.
 */
export const SPARK_PACKAGES = [
  `org.apache.hadoop:hadoop-aws:${HADOOP_AWS_VERSION}`,
  `io.delta:delta-spark_4.1_2.13:${DELTA_VERSION}`,
  `org.apache.iceberg:iceberg-spark-runtime-4.1_2.13:${ICEBERG_VERSION}`,
  `org.apache.iceberg:iceberg-aws-bundle:${ICEBERG_VERSION}`,
  "org.postgresql:postgresql:42.7.13",
  "com.mysql:mysql-connector-j:9.7.0",
  `org.xerial:sqlite-jdbc:${SQLITE_JDBC_VERSION}`,
].join(",");

/**
 * Both table formats' SQL extensions. Delta's gives MERGE over a path and its
 * DDL; Iceberg's gives CALL <catalog>.system.<procedure>, MERGE INTO an
 * Iceberg table and its ALTER TABLE forms. Order matters only for statements
 * both parse, and none of ours is one.
 */
export const SPARK_SQL_EXTENSIONS =
  "io.delta.sql.DeltaSparkSessionExtension,org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions";
