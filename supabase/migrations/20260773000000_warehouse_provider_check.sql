-- Widen data_warehouse_connections.provider to every provider the app offers.
--
-- The original CHECK (20260720300000) listed the five providers that existed
-- then and was never widened as more were added. So postgres, mysql, trino,
-- athena and oracle — all shipped and all in the picker — could not actually
-- be SAVED: the insert failed on a constraint violation with a message that
-- says nothing about which provider or why. The twelve added since inherited
-- the same problem.
--
-- This is the same landmine as the integrations.type CHECK. The durable fix is
-- not this migration but the test beside it: tests/unit/warehouseProviders
-- parses the constraint out of this file and asserts it matches
-- WAREHOUSE_PROVIDERS exactly, so the next provider added to the TypeScript
-- union fails CI until this list grows with it.

ALTER TABLE public.data_warehouse_connections
  DROP CONSTRAINT IF EXISTS data_warehouse_connections_provider_check;

ALTER TABLE public.data_warehouse_connections
  ADD CONSTRAINT data_warehouse_connections_provider_check
  CHECK (provider IN (
    -- Original five
    'redshift',
    'snowflake',
    'databricks',
    'bigquery',
    'azure_synapse',
    -- Shipped later, never permitted until now
    'postgres',
    'mysql',
    'trino',
    'athena',
    'oracle',
    -- TDS + own HTTP protocol
    'sqlserver',
    'clickhouse',
    -- PostgreSQL wire protocol
    'cockroachdb',
    'timescaledb',
    'alloydb',
    'greenplum',
    'yugabytedb',
    -- MySQL wire protocol
    'mariadb',
    'singlestore',
    'starrocks',
    'doris',
    'planetscale'
  ));
