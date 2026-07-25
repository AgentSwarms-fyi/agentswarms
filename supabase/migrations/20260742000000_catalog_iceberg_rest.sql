-- Allow an Iceberg REST catalog as a Data Catalog source kind. Metadata-only:
-- config holds { uri, warehouse }, credentials holds the encrypted bearer token
-- (same AES-GCM envelope as object-storage credentials).
ALTER TABLE public.catalog_sources DROP CONSTRAINT catalog_sources_kind_check;
ALTER TABLE public.catalog_sources
  ADD CONSTRAINT catalog_sources_kind_check
  CHECK (kind IN ('warehouse', 'object_storage', 'iceberg_rest'));
