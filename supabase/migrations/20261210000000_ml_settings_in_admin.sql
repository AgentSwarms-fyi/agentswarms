-- Machine-learning settings an operator sets in Admin → Developer runtime
-- (R550), where until now only the server's environment could set them.
--
-- Each is NULL by default, and NULL keeps today's behaviour: the environment
-- variable named in the comment, then the built-in default. A value saved on
-- the page wins over both. Cluster wiring (ML_SERVING_BACKEND, KSERVE_*, the
-- GPU node rules) deliberately stays in the environment: it decides which
-- namespace, service account and image the app deploys with, which an admin
-- login should not be able to repoint.
--
-- Additive only.

ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_api_rate_limit_per_min integer
    CHECK (ml_api_rate_limit_per_min IS NULL OR ml_api_rate_limit_per_min > 0),
  ADD COLUMN IF NOT EXISTS ml_evaluations_per_sweep integer
    CHECK (ml_evaluations_per_sweep IS NULL OR ml_evaluations_per_sweep > 0),
  ADD COLUMN IF NOT EXISTS ml_explain_max_rows integer
    CHECK (ml_explain_max_rows IS NULL OR ml_explain_max_rows > 0),
  ADD COLUMN IF NOT EXISTS ml_explain_top_k integer
    CHECK (ml_explain_top_k IS NULL OR ml_explain_top_k > 0),
  ADD COLUMN IF NOT EXISTS ml_explain_batch_max_rows integer
    CHECK (ml_explain_batch_max_rows IS NULL OR ml_explain_batch_max_rows > 0),
  ADD COLUMN IF NOT EXISTS ml_explain_batch_top_k integer
    CHECK (ml_explain_batch_top_k IS NULL OR ml_explain_batch_top_k > 0),
  ADD COLUMN IF NOT EXISTS ml_explain_chunk_rows integer
    CHECK (ml_explain_chunk_rows IS NULL OR ml_explain_chunk_rows > 0),
  ADD COLUMN IF NOT EXISTS ml_serve_target_rpm_per_replica integer
    CHECK (ml_serve_target_rpm_per_replica IS NULL OR ml_serve_target_rpm_per_replica > 0),
  ADD COLUMN IF NOT EXISTS ml_serve_scale_cooldown_seconds integer
    CHECK (ml_serve_scale_cooldown_seconds IS NULL OR ml_serve_scale_cooldown_seconds > 0),
  ADD COLUMN IF NOT EXISTS ml_import_max_mb integer
    CHECK (ml_import_max_mb IS NULL OR ml_import_max_mb BETWEEN 1 AND 4096);

COMMENT ON COLUMN public.notebook_runtime_settings.ml_api_rate_limit_per_min IS
  'Calls a minute one ML API key may make; NULL = env ML_API_RATE_LIMIT_PER_MIN, then 60.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_evaluations_per_sweep IS
  'Prediction runs one accuracy sweep re-measures; NULL = env ML_EVALUATIONS_PER_SWEEP, then 20.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_explain_max_rows IS
  'Rows one request may have explained; NULL = env ML_EXPLAIN_MAX_ROWS, then 20.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_explain_top_k IS
  'Features an explanation lists; NULL = env ML_EXPLAIN_TOP_K, then 8.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_explain_batch_max_rows IS
  'Rows a batch may have reason codes written for; NULL = env ML_EXPLAIN_BATCH_MAX_ROWS, then 50000.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_explain_batch_top_k IS
  'Reason codes written per row of a batch; NULL = env ML_EXPLAIN_BATCH_TOP_K, then 3.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_explain_chunk_rows IS
  'Rows explained together while a batch writes reason codes; NULL = env ML_EXPLAIN_CHUNK_ROWS, then 2000.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_serve_target_rpm_per_replica IS
  'Requests a minute one copy of a warm endpoint is sized for; NULL = env ML_SERVE_TARGET_RPM_PER_REPLICA, then 120.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_serve_scale_cooldown_seconds IS
  'Seconds a warm endpoint waits between two resizes; NULL = env ML_SERVE_SCALE_COOLDOWN_SECONDS, then 180.';
COMMENT ON COLUMN public.notebook_runtime_settings.ml_import_max_mb IS
  'Largest MLflow model (MB) an import accepts; NULL = env ML_IMPORT_MAX_MB, then 500.';
