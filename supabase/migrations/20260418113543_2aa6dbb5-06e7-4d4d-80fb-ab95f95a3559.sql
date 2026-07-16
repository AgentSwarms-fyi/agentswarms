-- Convert gateway usage counter from lifetime to per-day (UTC).
ALTER TABLE public.gateway_usage_counters
  ADD COLUMN IF NOT EXISTS period_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date;

-- Drop old PK if it's just user_id, switch to (user_id, period_date)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gateway_usage_counters_pkey'
      AND conrelid = 'public.gateway_usage_counters'::regclass
  ) THEN
    ALTER TABLE public.gateway_usage_counters DROP CONSTRAINT gateway_usage_counters_pkey;
  END IF;
END$$;

ALTER TABLE public.gateway_usage_counters
  ADD CONSTRAINT gateway_usage_counters_pkey PRIMARY KEY (user_id, period_date);

-- Replace the increment function to scope by today's UTC date.
CREATE OR REPLACE FUNCTION public.increment_gateway_usage(_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_count INTEGER;
  today DATE := (now() AT TIME ZONE 'utc')::date;
BEGIN
  INSERT INTO public.gateway_usage_counters (user_id, period_date, request_count, last_request_at)
  VALUES (_user_id, today, 1, now())
  ON CONFLICT (user_id, period_date) DO UPDATE
    SET request_count = public.gateway_usage_counters.request_count + 1,
        last_request_at = now(),
        updated_at = now()
  RETURNING request_count INTO new_count;

  RETURN new_count;
END;
$function$;