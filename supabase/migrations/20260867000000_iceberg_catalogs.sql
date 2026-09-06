-- Iceberg interop: REST catalogs a user registers, mounted as lakehouse
-- schemas (views over the catalog's tables, nothing copied) or written to
-- (a lakehouse table published as an Iceberg table). Credentials are secret
-- names; the values stay under Settings -> Secrets.

CREATE TABLE IF NOT EXISTS public.iceberg_catalogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  endpoint text NOT NULL,
  warehouse text NOT NULL,
  auth_type text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'oauth2')),
  token_secret text,
  client_id_secret text,
  client_secret_secret text,
  oauth2_server_uri text,
  storage text NOT NULL DEFAULT 'vended' CHECK (storage IN ('vended', 'lakehouse')),
  is_active boolean NOT NULL DEFAULT true,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS iceberg_catalogs_user_idx ON public.iceberg_catalogs (user_id, created_at DESC);

ALTER TABLE public.iceberg_catalogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own iceberg catalogs"
  ON public.iceberg_catalogs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Definition changes are audited; is_active flips and last_error are not.
DROP TRIGGER IF EXISTS audit_iceberg_catalogs ON public.iceberg_catalogs;
CREATE TRIGGER audit_iceberg_catalogs
  AFTER INSERT OR DELETE OR UPDATE OF
    name, endpoint, warehouse, auth_type, token_secret, client_id_secret,
    client_secret_secret, oauth2_server_uri, storage
  ON public.iceberg_catalogs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('iceberg_catalog');

-- A lakehouse schema can be a mount of one Iceberg namespace: read-only
-- views over the catalog's tables, governed like every other schema.
ALTER TABLE public.lakehouse_schemas
  ADD COLUMN IF NOT EXISTS iceberg_catalog_id uuid REFERENCES public.iceberg_catalogs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS iceberg_namespace text;
CREATE INDEX IF NOT EXISTS lakehouse_schemas_iceberg_idx
  ON public.lakehouse_schemas (iceberg_catalog_id) WHERE iceberg_catalog_id IS NOT NULL;
