-- Retention window for the high-volume observability tables (execution_traces,
-- swarm_runs → swarm_run_steps cascades). These grow without bound today, and
-- swarm_run_steps is the fastest-growing table in the schema: it stores full
-- per-node input/output plus RAG chunks.
--
-- DEFAULT 0 = keep forever, i.e. OFF. Existing instances see no behaviour
-- change; the purge only activates once an admin sets a positive window. This
-- is deliberate — a nonzero default would silently start deleting analytics
-- history an operator may be relying on. (audit_retention_days stays separate
-- and compliance-oriented at 365; trace data is operational and much larger,
-- so its retention is a distinct, opt-in knob.)
ALTER TABLE public.iam_settings
  ADD COLUMN IF NOT EXISTS trace_retention_days integer NOT NULL DEFAULT 0
  CHECK (trace_retention_days BETWEEN 0 AND 3650);
