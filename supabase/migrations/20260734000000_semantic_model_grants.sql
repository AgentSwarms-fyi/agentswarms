-- Enable IAM resource grants to target semantic_models.
--
-- The RLS SELECT policy on semantic_models (via has_resource_access(
-- 'semantic_model', ...)) is already in place (20260733000000); this just
-- widens the grants CHECK so a superadmin can create such grants. Sharing is
-- read-only (the "manage own" policy still gates writes to the owner).
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
      'semantic_model'
    )
  );
