-- External data warehouse connections (Redshift, Snowflake, Databricks,
-- BigQuery, Azure Synapse). Credentials are AES-GCM encrypted in server code
-- ({ciphertext, iv} — same scheme as provider_credentials); the DB never
-- sees plaintext secrets. Queried by the Data & SQL page, the BI panel, and
-- the warehouse agent tools through /api/warehouse/*.

CREATE TABLE public.data_warehouse_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (
    provider IN ('redshift', 'snowflake', 'databricks', 'bigquery', 'azure_synapse')
  ),
  -- Display name, also how agents reference the connection in tool calls.
  name text NOT NULL,
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  last_test_status text,
  last_test_error text,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX idx_dw_connections_user ON public.data_warehouse_connections(user_id);

ALTER TABLE public.data_warehouse_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own warehouse connections"
  ON public.data_warehouse_connections FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_dw_connections_updated_at
  BEFORE UPDATE ON public.data_warehouse_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
