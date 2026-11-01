-- An Iceberg catalog may require a private network path (R428, private
-- connectivity Phase 3).
--
-- When set, the lakehouse engine attaches the catalog only if its REST
-- endpoint (and its OAuth2 token server, when it names one) resolves to
-- private addresses from the app server; every engine sync checks it again
-- and detaches a catalog whose name has stopped resolving privately
-- (src/utils/lakehouse/iceberg.server.ts). Off for every existing catalog.
--
-- Safe in either order with the R428 code: until this runs, a catalog reads
-- as not requiring a private path, and a catalog saved with the rule on is
-- refused with a message naming this migration.

ALTER TABLE public.iceberg_catalogs
  ADD COLUMN IF NOT EXISTS require_private boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.iceberg_catalogs.require_private IS
  'Attach only when the endpoint and token server resolve to private addresses from the app server.';
