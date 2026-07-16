ALTER TABLE public.gateway_usage_counters
  ADD COLUMN IF NOT EXISTS image_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.increment_gateway_image_usage(_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count integer;
  today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  INSERT INTO public.gateway_usage_counters (user_id, period_date, image_count, last_request_at)
  VALUES (_user_id, today, 1, now())
  ON CONFLICT (user_id, period_date) DO UPDATE
    SET image_count = public.gateway_usage_counters.image_count + 1,
        last_request_at = now(),
        updated_at = now()
  RETURNING image_count INTO new_count;

  RETURN new_count;
END;
$$;