-- Track per-user usage of the built-in AgentSwarms AI gateway so we can
-- cap free usage at 15 requests/user before requiring a BYO provider key.
CREATE TABLE public.gateway_usage_counters (
  user_id UUID NOT NULL PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.gateway_usage_counters ENABLE ROW LEVEL SECURITY;

-- Users can read their own counter (so the UI can show "X / 15 used").
CREATE POLICY "Users can view their own usage counter"
ON public.gateway_usage_counters
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- All writes (insert/update) happen server-side via the service role,
-- which bypasses RLS. We intentionally do NOT grant insert/update/delete
-- to authenticated so users can't reset their own counter.

-- updated_at trigger
CREATE TRIGGER update_gateway_usage_counters_updated_at
BEFORE UPDATE ON public.gateway_usage_counters
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Atomic increment helper. SECURITY DEFINER so it can write past RLS.
-- Returns the post-increment count. Used by the chat API to enforce caps.
CREATE OR REPLACE FUNCTION public.increment_gateway_usage(_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  INSERT INTO public.gateway_usage_counters (user_id, request_count, last_request_at)
  VALUES (_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE
    SET request_count = public.gateway_usage_counters.request_count + 1,
        last_request_at = now()
  RETURNING request_count INTO new_count;

  RETURN new_count;
END;
$$;