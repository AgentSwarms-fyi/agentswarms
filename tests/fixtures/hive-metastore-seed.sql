CREATE DATABASE sales COMMENT 'Revenue data, owned by finance';
CREATE DATABASE marketing COMMENT 'Campaign data';

-- Managed Parquet, with rows, analysed: the one honest row count.
CREATE TABLE sales.orders (
  order_id BIGINT COMMENT 'Primary key',
  customer_email STRING COMMENT 'Contact address',
  amount DECIMAL(12,2),
  created_at TIMESTAMP
) COMMENT 'Every order we have taken' STORED AS PARQUET;
INSERT INTO sales.orders VALUES
  (1,'a@example.com',10.50,'2026-01-01 10:00:00'),
  (2,'b@example.com',20.00,'2026-01-02 11:00:00'),
  (3,'c@example.com',31.25,'2026-01-03 12:00:00');
ANALYZE TABLE sales.orders COMPUTE STATISTICS;

-- Partitioned ORC with three real partitions.
CREATE TABLE sales.events (
  event_id BIGINT,
  payload STRING
) PARTITIONED BY (dt STRING, region STRING) STORED AS ORC;
INSERT INTO sales.events PARTITION (dt='2026-01-01', region='emea') VALUES (1,'x');
INSERT INTO sales.events PARTITION (dt='2026-01-01', region='apac') VALUES (2,'y');
INSERT INTO sales.events PARTITION (dt='2026-01-02', region='emea') VALUES (3,'z');

-- External CSV, never analysed: its numRows must not read as 0 rows.
CREATE EXTERNAL TABLE sales.customers_csv (
  id STRING, full_name STRING, phone STRING
) ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.OpenCSVSerde'
STORED AS TEXTFILE LOCATION '/opt/hive/data/warehouse/external/customers_csv'
TBLPROPERTIES ('skip.header.line.count'='1');

-- Nested types, Avro, JSON, plain text, bucketing.
CREATE TABLE marketing.campaigns (
  id INT,
  tags ARRAY<STRING>,
  budget MAP<STRING,DOUBLE>,
  owner_info STRUCT<name:STRING,email:STRING>
) STORED AS AVRO;
CREATE TABLE marketing.clicks_json (id INT, url STRING)
  ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.JsonSerDe' STORED AS TEXTFILE;
CREATE TABLE marketing.raw_log (line STRING) STORED AS TEXTFILE;
CREATE TABLE marketing.bucketed_users (user_id BIGINT, ssn STRING)
  CLUSTERED BY (user_id) INTO 8 BUCKETS STORED AS ORC;

-- The properties a JDBC table holds, with the password in plain text. Hive will
-- not create a real JDBC table without a live database behind it, and the risk
-- under test is the properties, so they sit on a plain table here.
CREATE EXTERNAL TABLE sales.jdbc_ledger (id INT, memo STRING)
STORED AS TEXTFILE LOCATION '/opt/hive/data/warehouse/external/jdbc_ledger'
TBLPROPERTIES (
  'hive.sql.database.type'='POSTGRES',
  'hive.sql.jdbc.driver'='org.postgresql.Driver',
  'hive.sql.jdbc.url'='jdbc:postgresql://ledger.internal:5432/books',
  'hive.sql.dbcp.username'='ledger_ro',
  'hive.sql.dbcp.password'='FIXTURE-NOT-A-REAL-PASSWORD',
  'hive.sql.table'='ledger'
);

-- A view over a join across databases, for lineage.
CREATE VIEW sales.order_summary COMMENT 'Orders with campaign spend' AS
  SELECT o.order_id, o.amount, c.id AS campaign_id
  FROM sales.orders o JOIN marketing.campaigns c ON o.order_id = c.id;

-- Iceberg, as Hive 4 writes it.
CREATE TABLE sales.ledger_iceberg (id BIGINT, memo STRING)
  PARTITIONED BY (year INT) STORED BY ICEBERG;

-- What Spark leaves behind: the placeholder column and the real schema in properties.
CREATE EXTERNAL TABLE sales.spark_users (col ARRAY<STRING> COMMENT 'from deserializer')
STORED AS TEXTFILE LOCATION '/opt/hive/data/warehouse/external/spark_users'
TBLPROPERTIES (
  'spark.sql.sources.provider'='parquet',
  'spark.sql.sources.schema.numParts'='1',
  'spark.sql.sources.schema.part.0'='{"type":"struct","fields":[{"name":"id","type":"long","nullable":true,"metadata":{"comment":"user id"}},{"name":"email","type":"string","nullable":true,"metadata":{}},{"name":"prefs","type":{"type":"map","keyType":"string","valueType":"integer","valueContainsNull":true},"nullable":true,"metadata":{}}]}'
);

SHOW TABLES IN sales;
SHOW TABLES IN marketing;
