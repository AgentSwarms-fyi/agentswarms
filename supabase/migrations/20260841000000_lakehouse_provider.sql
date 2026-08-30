-- The built-in lakehouse joins the warehouse-connection provider list: a
-- zero-credential connection whose queries run under the owner's lakehouse
-- schema grants. tests/unit/lakehouse.test.ts pins app<->db agreement.
ALTER TABLE public.data_warehouse_connections
  DROP CONSTRAINT IF EXISTS data_warehouse_connections_provider_check;

ALTER TABLE public.data_warehouse_connections
  ADD CONSTRAINT data_warehouse_connections_provider_check
  CHECK (provider IN (
    'postgres', 'mysql', 'sqlserver', 'oracle', 'redshift', 'snowflake',
    'databricks', 'bigquery', 'azure_synapse', 'trino', 'athena', 'clickhouse',
    'cockroachdb', 'timescaledb', 'alloydb', 'greenplum', 'yugabytedb',
    'mariadb', 'singlestore', 'starrocks', 'doris', 'planetscale',
    'lakehouse'
  ));
