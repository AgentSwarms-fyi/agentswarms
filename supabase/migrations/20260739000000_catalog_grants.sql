-- Org-shared data catalog. A catalog is fundamentally a team asset, but
-- catalog_sources/catalog_assets shipped owner-private (auth.uid() = user_id).
-- Plug into the existing IAM grant system (same as knowledge_base / data_table):
-- a superadmin grants a 'catalog_source' to a user or group, and the grantee
-- gets READ access to that source and all its crawled assets. Writes (curation,
-- re-crawl, delete) stay owner-only via the untouched FOR ALL policy, so sharing
-- is read-only.

ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT iam_resource_grants_resource_type_check;
ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (
    resource_type IN (
      'knowledge_base',
      'data_table',
      'secret',
      'bi_dashboard',
      'semantic_model',
      'catalog_source'
    )
  );

-- Grantees can READ a shared source's metadata row…
CREATE POLICY "Granted catalog sources are visible"
  ON public.catalog_sources FOR SELECT
  USING (public.has_resource_access('catalog_source', id, auth.uid()));

-- …and all assets crawled from it.
CREATE POLICY "Granted catalog assets are visible"
  ON public.catalog_assets FOR SELECT
  USING (public.has_resource_access('catalog_source', source_id, auth.uid()));
