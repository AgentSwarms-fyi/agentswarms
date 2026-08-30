-- Materialized views: a query whose answer is stored as a real table and
-- refreshed on a schedule.
--
-- DuckLake has no materialized view of its own, so a refresh is
-- CREATE OR REPLACE TABLE ... AS <query>, which lands as a single catalog
-- commit. Readers therefore see either the old table or the new one, never a
-- half-built one — the property that makes refreshing a live table safe.
--
-- The stored table is an ordinary lakehouse table: it is queryable, joinable,
-- partitionable and governed by exactly the same chokepoint as everything
-- else. What this row adds is the definition, the schedule, and the record of
-- how the last refresh went.
CREATE TABLE public.lakehouse_materialized_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  sql text NOT NULL,
  -- 'manual' never runs on its own; the rest ride the same sweep as BI
  -- refreshes and ETL schedules.
  schedule text NOT NULL DEFAULT 'manual'
    CHECK (schedule IN ('manual', 'hourly', 'daily', 'weekly')),
  is_active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_refreshed_at timestamptz,
  last_status text CHECK (last_status IN ('ok', 'error')),
  last_error text,
  last_duration_ms integer,
  last_row_count bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schema_name, table_name)
);

CREATE INDEX idx_lakehouse_matviews_due
  ON public.lakehouse_materialized_views(next_run_at)
  WHERE is_active AND schedule <> 'manual';

ALTER TABLE public.lakehouse_materialized_views ENABLE ROW LEVEL SECURITY;

-- Same shape as lakehouse_schemas: the owner manages it, a grantee on the
-- schema may read the definition (they can query the table itself anyway, so
-- hiding the SQL that built it would buy nothing but confusion).
CREATE POLICY "own matviews" ON public.lakehouse_materialized_views
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "granted matviews readable" ON public.lakehouse_materialized_views
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.lakehouse_schemas s
      WHERE s.name = lakehouse_materialized_views.schema_name
        AND public.has_resource_access('lakehouse_schema', s.id, auth.uid())
    )
  );

CREATE TRIGGER lakehouse_matviews_updated
  BEFORE UPDATE ON public.lakehouse_materialized_views
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
