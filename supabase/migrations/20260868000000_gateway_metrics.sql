-- Gateway keys reach the semantic layer.
--
-- A third scope, "metrics", lets a gateway key list the semantic models its
-- owner may read and run governed metric queries against them over HTTP
-- (GET /api/v1/metrics, POST /api/v1/metrics/query) - the same compiler, the
-- same share policies and the same audit row the metric_query agent tool
-- produces, reached by a client that is not an agent. An optional allow-list
-- narrows a key to named models; empty means every model the owner owns or
-- is granted, and naming a model never grants access the owner lacks.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.gateway_keys'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%scopes%'
  LOOP
    EXECUTE format('ALTER TABLE public.gateway_keys DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.gateway_keys
  ADD CONSTRAINT gateway_keys_scopes_check
  CHECK (scopes <@ ARRAY['agents', 'models', 'metrics']::text[] AND cardinality(scopes) >= 1);

ALTER TABLE public.gateway_keys
  ADD COLUMN IF NOT EXISTS semantic_model_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN public.gateway_keys.semantic_model_ids IS
  'With the metrics scope: the semantic models this key may query; empty = every model the owner may read.';

-- The allow-list is configuration, so a change to it is audited like the
-- other configuration columns; use counters stay out of the audit trail.
DROP TRIGGER IF EXISTS audit_gateway_keys ON public.gateway_keys;
CREATE TRIGGER audit_gateway_keys
  AFTER INSERT OR DELETE OR UPDATE OF
    name, scopes, agent_ids, model_allow, fallback_models, semantic_model_ids,
    rate_limit_per_min, is_active, expires_at, revoked_at
  ON public.gateway_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('gateway_key');

-- Instance default, editable under Admin -> Developer runtime; NULL = env.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS gateway_metrics_max_rows integer;
COMMENT ON COLUMN public.notebook_runtime_settings.gateway_metrics_max_rows IS
  'Rows one metrics API query may return; NULL = env AI_GATEWAY_METRICS_MAX_ROWS, then 10000.';
