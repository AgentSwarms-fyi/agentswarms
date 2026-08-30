-- Lakehouse: schema ownership + query history for the built-in DuckLake
-- warehouse. The DATA lives as Parquet in object storage with its own
-- transactional catalog (Postgres, LAKEHOUSE_CATALOG_URL); these tables hold
-- what the APP owns — who a schema belongs to, and who ran what.

CREATE TABLE IF NOT EXISTS public.lakehouse_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The DuckLake schema name, unique across the deployment (one shared
  -- catalog; access is governed here, not in DuckDB).
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lakehouse_schemas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own lakehouse schemas"
  ON public.lakehouse_schemas FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Shared lakehouse schemas are readable"
  ON public.lakehouse_schemas FOR SELECT
  USING (public.has_resource_access('lakehouse_schema', id, auth.uid()));

-- Every statement the lakehouse ran for a user: the operational memory the
-- history panel reads. Server-written; owners read their own.
CREATE TABLE IF NOT EXISTS public.lakehouse_query_history (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sql text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  row_count integer,
  duration_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lakehouse_query_history_user_idx
  ON public.lakehouse_query_history (user_id, id DESC);

ALTER TABLE public.lakehouse_query_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own lakehouse history"
  ON public.lakehouse_query_history FOR SELECT
  USING (auth.uid() = user_id);

-- Lakehouse schemas become grantable resources like everything else.
ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT IF EXISTS iam_resource_grants_resource_type_check;

ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (
    resource_type IN (
      'knowledge_base',
      'data_table',
      'secret',
      'bi_dashboard',
      'semantic_model',
      'catalog_source',
      'integration',
      'provider_credential',
      'warehouse_connection',
      'saas_connection',
      'ai_analyst',
      -- New: a schema in the built-in lakehouse.
      'lakehouse_schema'
    )
  );
