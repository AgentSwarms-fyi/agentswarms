-- A notebook saves the model it trained through the platform.
--
-- A run could record an artifact's URI and digest, but producing that artifact
-- was the author's problem: write a joblib file in the registry's contract,
-- get it into the lake bucket without the bucket's credentials (a kernel does
-- not hold them, on purpose), hash it, and only then call finish. Nobody did,
-- so notebook-authored models stayed in notebooks. Now the kernel uploads the
-- bytes to the app with its session token, the app writes them beside the
-- other artifacts and records the digest it computed itself, and the run can
-- be registered as a version from the same notebook cell.

ALTER TABLE public.ml_experiment_runs
  -- Size of the uploaded artifact, for the panel and for the cap below.
  ADD COLUMN IF NOT EXISTS artifact_bytes bigint;

ALTER TABLE public.notebook_runtime_settings
  -- Largest artifact one run may upload. NULL = env ML_ARTIFACT_MAX_MB, then
  -- 512. Not capped in code: a large VM may keep a large model.
  ADD COLUMN IF NOT EXISTS ml_artifact_max_mb integer;
COMMENT ON COLUMN public.notebook_runtime_settings.ml_artifact_max_mb IS
  'Largest artifact (MB) a notebook run may upload into the lake bucket; NULL = env ML_ARTIFACT_MAX_MB, then 512.';
