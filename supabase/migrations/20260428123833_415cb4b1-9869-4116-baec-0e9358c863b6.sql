ALTER TABLE public.gateway_usage_counters
  ADD COLUMN IF NOT EXISTS output_tokens integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.add_gateway_output_tokens(_user_id uuid, _tokens integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_total integer;
  today date := (now() AT TIME ZONE 'utc')::date;
BEGIN
  IF _tokens IS NULL OR _tokens <= 0 THEN
    SELECT output_tokens INTO new_total
      FROM public.gateway_usage_counters
     WHERE user_id = _user_id AND period_date = today;
    RETURN COALESCE(new_total, 0);
  END IF;

  INSERT INTO public.gateway_usage_counters (user_id, period_date, request_count, output_tokens, last_request_at)
  VALUES (_user_id, today, 0, _tokens, now())
  ON CONFLICT (user_id, period_date) DO UPDATE
    SET output_tokens = public.gateway_usage_counters.output_tokens + EXCLUDED.output_tokens,
        last_request_at = now(),
        updated_at = now()
  RETURNING output_tokens INTO new_total;

  RETURN new_total;
END;
$$;