-- A retention floor for evidence.
--
-- THE PROBLEM THIS FIXES. Retention is already configurable: an operator can
-- set trace_retention_days to 30 and audit_retention_days below a year. Those
-- settings do not know what they are deleting. A trace or audit row carrying a
-- decision_id is not ordinary telemetry -- it is the evidence behind an answer
-- someone was given, and deleting it silently empties that answer's passport
-- while leaving the decision row pointing at nothing.
--
-- WHY 183 DAYS. The EU AI Act obliges a deployer of a high-risk system to keep
-- the automatically generated logs for at least six months (Article 26(6)),
-- and those obligations have applied since 2 August 2026. 183 days is that
-- floor. It is a DEFAULT, not a lock: an operator outside that scope can lower
-- it, and one keeping technical documentation to the ten-year standard of
-- Article 18 can raise it. What the platform will not do is destroy evidence
-- as a side effect of a setting that never mentioned it.
--
-- The floor never SHORTENS retention. Where the ordinary window is longer, the
-- longer window wins; the floor only stops evidence being deleted early.
ALTER TABLE public.iam_settings
  ADD COLUMN IF NOT EXISTS provenance_retention_days integer NOT NULL DEFAULT 183;

COMMENT ON COLUMN public.iam_settings.provenance_retention_days IS
  'Minimum days to keep execution_traces and audit_events that carry a decision_id, regardless of the ordinary retention windows. Default 183 (six months), the EU AI Act Article 26(6) deployer floor. 0 disables the protection.';

-- Decisions outlive nothing they point at: purged on the same clock as the
-- evidence, so an instance does not accumulate rows whose chain is gone.
CREATE INDEX IF NOT EXISTS decisions_created_idx ON public.decisions (created_at);
