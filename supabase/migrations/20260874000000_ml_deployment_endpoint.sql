-- Where the scorer is listening, remembered.
--
-- Resolving it meant asking the orchestrator on EVERY score, which for the
-- Docker backend is a `docker inspect` round trip through the socket proxy.
-- Measured on a warm endpoint that was otherwise answering instantly, that
-- lookup was most of the 1.6 seconds a "warm" prediction took — the container
-- start was gone and a slower thing had taken its place.
--
-- The address is stable for the life of the sandbox, so it is written once
-- when the deployment goes ready and re-resolved only when a call to it
-- actually fails.
ALTER TABLE public.ml_deployments
  ADD COLUMN IF NOT EXISTS endpoint text;

COMMENT ON COLUMN public.ml_deployments.endpoint IS
  'Base URL of the running scorer; re-resolved from the orchestrator only when a call to it fails.';
