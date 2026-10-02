-- A served model gets a serving budget, not a training one.
--
-- MEASURED. A scorer replica is a container holding Python, the ML stack and
-- one fitted pipeline, answering requests. Running one on this deployment and
-- watching it serve: 169 MiB resident, 0.02% CPU idle, and a prediction
-- answered in 0.105 s. Its memory limit was 8 GiB, because the serving path
-- reused ml_train_mem_limit_mb — the budget for FITTING a model on two million
-- rows, which is a different job with a different appetite.
--
-- On one host that over-allocation is harmless: a Docker limit reserves
-- nothing, so a 48x-too-large ceiling costs nothing but the ceiling.
--
-- ON KUBERNETES IT IS THE CEILING ON HOW MANY COPIES YOU MAY RUN. A namespace
-- ResourceQuota bounds limits.memory — that is the ordinary way to bound a
-- tenant — so every scorer spends 8 GiB of the quota to use a sixth of a
-- gigabyte. A 32 GiB quota permits four copies of a model that would fit forty
-- times over. A LimitRange with a maximum refuses the pod outright. Spreading
-- serving across machines is exactly what that arithmetic prevents.
--
-- The default here is not the measurement either, because models vary: the
-- artifact itself may be up to ml_artifact_max_mb (512 MB by default) and an
-- unpickled model is a multiple of its file size. 2 GiB leaves room for the
-- largest artifact the platform will accept, on top of a runtime measured at
-- a sixth of that — and it is a setting, so somebody serving something unusual
-- raises it rather than discovering a cap.
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ml_serve_mem_limit_mb integer;

COMMENT ON COLUMN public.notebook_runtime_settings.ml_serve_mem_limit_mb IS
  'Memory ceiling of a scorer replica. Separate from ml_train_mem_limit_mb because serving holds one fitted model resident (measured at 169 MiB) while training fits one; on Kubernetes this number is what a namespace ResourceQuota counts per copy.';
