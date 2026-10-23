-- R318: a cost below a millionth of a dollar keeps its digits.
--
-- execution_traces.cost_usd was NUMERIC(10,6), so a call priced at $0.0000046
-- was stored as $0.000005, and every total over such calls carried that
-- rounding. The run and evaluation tables were NUMERIC(12,6): the same six
-- places. Each is now unconstrained `numeric`, which keeps the figure the
-- provider's price produced.
--
-- Removing a numeric column's precision and scale changes only its type
-- modifier, so Postgres does not rewrite the table: quick on a large install
-- too. No view reads these columns, and the functions that sum them already
-- return `numeric`.
ALTER TABLE public.execution_traces ALTER COLUMN cost_usd TYPE numeric;
ALTER TABLE public.swarm_runs ALTER COLUMN total_cost_usd TYPE numeric;
ALTER TABLE public.swarm_run_steps ALTER COLUMN cost_usd TYPE numeric;
ALTER TABLE public.eval_runs ALTER COLUMN total_cost_usd TYPE numeric;
ALTER TABLE public.eval_results ALTER COLUMN cost_usd TYPE numeric;
