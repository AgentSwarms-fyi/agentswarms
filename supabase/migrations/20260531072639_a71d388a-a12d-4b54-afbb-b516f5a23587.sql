
ALTER TABLE public.budget_settings ALTER COLUMN monthly_cap_usd SET DEFAULT 5;
UPDATE public.budget_settings SET monthly_cap_usd = 5 WHERE monthly_cap_usd = 500;
ALTER TABLE public.budget_settings
  ADD COLUMN IF NOT EXISTS notified_thresholds INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN IF NOT EXISTS notified_period DATE,
  ADD COLUMN IF NOT EXISTS cap_exceeded_notified_period DATE;
