-- SaaS data sources: connections that are PULLED INTO datasets rather than
-- queried live.
--
-- Deliberately a separate table from data_warehouse_connections. A warehouse is
-- queried in place with SQL and nothing is copied; a SaaS source has no query
-- language and is paged through an HTTP API into user_data_tables. Sharing one
-- table would mean a row where half the columns are meaningless whichever kind
-- it is, and a CHECK constraint enumerating both.
--
-- `config` holds { ciphertext, iv } — AES-GCM, encrypted in server code, same
-- scheme as provider_credentials and warehouse credentials. The database never
-- sees a service-account key.
--
-- NOTE ON THE provider CHECK: keep it in step with SAAS_PROVIDERS. The
-- warehouse table's equivalent went five providers stale and silently rejected
-- every save; tests/unit/saasConnections asserts this one matches the
-- TypeScript union so that cannot repeat.

CREATE TABLE public.saas_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_sheets')),
  -- Display name. Also prefixes the dataset names this connection creates, so
  -- two sources with a same-named stream cannot overwrite one another.
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Stream ids the user chose to sync, e.g. worksheet titles.
  streams jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  last_sync_status text,
  last_sync_error text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX idx_saas_connections_user ON public.saas_connections(user_id);

ALTER TABLE public.saas_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own saas connections"
  ON public.saas_connections FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_saas_connections_updated_at
  BEFORE UPDATE ON public.saas_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
