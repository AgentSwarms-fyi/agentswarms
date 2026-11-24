-- R532: a warm endpoint's copy can be a KServe InferenceService.
--
-- On Kubernetes, with ML_SERVING_BACKEND=kserve, the app no longer starts a
-- sandbox per copy. It applies one InferenceService per side of an endpoint
-- (primary, candidate) and the cluster's autoscaler runs the pods behind it.
-- The replica row then stands for that object: its name and namespace, so
-- the app can reach it, read it, and delete it when the endpoint stops.
--
-- On the replicas table and nowhere else on purpose. ml_deployments is
-- writable by its owner under RLS; ml_deployment_replicas is reached only by
-- the service role (its policy refuses everything). A name a client could
-- write would be a name the app deletes, or derives a token for.
--
-- Additive: existing rows are sandbox copies and keep NULL in both.

ALTER TABLE public.ml_deployment_replicas
  ADD COLUMN IF NOT EXISTS isvc_name text,
  ADD COLUMN IF NOT EXISTS isvc_namespace text;

-- Both or neither, and names Kubernetes would accept (DNS labels).
ALTER TABLE public.ml_deployment_replicas
  DROP CONSTRAINT IF EXISTS ml_deployment_replicas_isvc_check;
ALTER TABLE public.ml_deployment_replicas
  ADD CONSTRAINT ml_deployment_replicas_isvc_check CHECK (
    (isvc_name IS NULL AND isvc_namespace IS NULL)
    OR (
      isvc_name ~ '^[a-z]([-a-z0-9]*[a-z0-9])?$' AND length(isvc_name) <= 63
      AND isvc_namespace ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' AND length(isvc_namespace) <= 63
    )
  );

-- The orphan sweep and the "does another live copy name this object" check
-- both look rows up by the object.
CREATE INDEX IF NOT EXISTS ml_deployment_replicas_isvc_idx
  ON public.ml_deployment_replicas (isvc_namespace, isvc_name)
  WHERE isvc_name IS NOT NULL;

COMMENT ON COLUMN public.ml_deployment_replicas.isvc_name IS
  'The KServe InferenceService this copy is (R532), or NULL for a sandbox copy.';
COMMENT ON COLUMN public.ml_deployment_replicas.isvc_namespace IS
  'The namespace of isvc_name; set exactly when it is.';
