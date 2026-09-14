-- The predictive models an analyst may use — its own choice, made in the same
-- dialog as its reasoning model and its data.
--
-- Until now the analyst's planner was shown every trained model its owner
-- could use and chose among them by the question. That is still the default:
-- NULL means every model the owner can use. A list means exactly those, by
-- name, and an empty list means none — the planner is then not told about
-- scoring at all. The same rule an agent's ML tool follows
-- (agents.ml_model_names), enforced the same way: the server refuses a model
-- outside the list when a step tries to score with it, whatever the planner
-- was shown. Existing analysts keep NULL and behave exactly as before.
ALTER TABLE public.ai_analysts
  ADD COLUMN IF NOT EXISTS ml_model_names text[] NULL;

COMMENT ON COLUMN public.ai_analysts.ml_model_names IS
  'Predictive models this analyst may score or forecast with, by name. NULL = every model the owner can use; [] = none.';
