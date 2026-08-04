-- Alert thresholds for GROUP budgets.
--
-- Group caps were enforceable but silent: budget_limits carried a cap and an
-- on/off flag and nothing else, so a team could run from 0% to blocked without
-- anyone being told. The per-user path (budget_settings) has had thresholds,
-- per-period dedupe and an email since the beginning. This gives the group
-- path the SAME four columns rather than a second mechanism — one shape to
-- reason about, one place to change.
--
-- Applies to every scope_type in the table (group, embed_key, swarm_api_key),
-- because a public embed key running away is exactly as worth an email as a
-- team is, and they are already the same row shape.

ALTER TABLE public.budget_limits
  -- Percentages of the cap that trigger a warning. Same default as
  -- budget_settings so the two paths behave alike out of the box.
  ADD COLUMN IF NOT EXISTS alert_thresholds integer[] NOT NULL DEFAULT ARRAY[50, 75, 90],
  -- Thresholds already emailed for the period in notified_period. Without this
  -- every traced call past 50% would send another email — the alert path runs
  -- after EVERY call, so "notify on crossing" has to mean "once".
  ADD COLUMN IF NOT EXISTS notified_thresholds integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  -- First-of-month the array above covers. When the month rolls, the array is
  -- treated as empty rather than being cleared by a job that might not run.
  ADD COLUMN IF NOT EXISTS notified_period date,
  -- Month the "cap exceeded" email was sent, tracked separately: crossing 90%
  -- and hitting 100% are two different messages and must not suppress
  -- each other.
  ADD COLUMN IF NOT EXISTS cap_exceeded_notified_period date,
  -- Off by default. An operator who has not asked for alerts should not start
  -- receiving them because they upgraded.
  ADD COLUMN IF NOT EXISTS alerts_enabled boolean NOT NULL DEFAULT false;

-- Only sane percentages. A threshold of 0 would fire on the first call of the
-- month, and one above 100 can never fire — both are configuration mistakes
-- worth rejecting at the write rather than debugging later.
ALTER TABLE public.budget_limits
  DROP CONSTRAINT IF EXISTS budget_limits_alert_thresholds_range;
ALTER TABLE public.budget_limits
  ADD CONSTRAINT budget_limits_alert_thresholds_range
  CHECK (
    alert_thresholds <@ ARRAY[
      1,2,3,4,5,10,15,20,25,30,33,40,50,60,66,70,75,80,85,90,95,99
    ]::integer[]
  );

COMMENT ON COLUMN public.budget_limits.alert_thresholds IS
  'Percentages of monthly_cap_usd that trigger a warning email. Requires alerts_enabled.';
COMMENT ON COLUMN public.budget_limits.notified_thresholds IS
  'Thresholds already emailed during notified_period — per-period idempotency.';
COMMENT ON COLUMN public.budget_limits.alerts_enabled IS
  'Off by default: enabling alerts is an explicit choice, not an upgrade side effect.';

-- The alert path reads this row on every traced call for every group the
-- caller belongs to, so the lookup must be an index hit.
CREATE INDEX IF NOT EXISTS idx_budget_limits_scope_active
  ON public.budget_limits (scope_type, scope_id)
  WHERE is_active;
