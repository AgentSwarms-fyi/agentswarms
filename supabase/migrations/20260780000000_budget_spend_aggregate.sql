-- Month-to-date spend, summed in the database.
--
-- Five call sites computed this by SELECTing every execution_traces row for the
-- month and adding cost_usd up in JavaScript — including budgetGuard, which is
-- the gate that actually refuses a call. No LIMIT, no aggregate.
--
-- Two problems, and the second is the serious one:
--
--   1. Volume. Every model call writes a trace row. A public embed key at its
--      30/min rate limit can produce ~1.3M rows a month, and the guard fetched
--      all of them, once a minute per user, to add up one column.
--
--   2. It fails OPEN. Both call sites read the result as `data ?? []`, so a
--      statement timeout or any other error yields an empty array, which sums
--      to $0, which is under every cap. The budget stops enforcing precisely
--      when there is the most spend to enforce against, and nothing says so.
--
-- Aggregating here fixes both: one numeric comes back, and a failure is an
-- error the caller can distinguish from "spent nothing".
--
-- SECURITY DEFINER because execution_traces is RLS'd to its owner and the
-- guard runs under the service role. The authorization check below is
-- therefore mandatory, not decorative: without it any signed-in user could read
-- any other user's spend.

CREATE OR REPLACE FUNCTION public.budget_spend_since(
  _user_id     uuid,
  _since       timestamptz,
  _scope_type  text DEFAULT NULL,
  _scope_id    uuid DEFAULT NULL,
  -- Group caps ask "what has this TEAM spent", which is a sum across members.
  -- Taken as an array rather than as N calls so a 200-person group is still
  -- one aggregate.
  _user_ids    uuid[] DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _total numeric;
BEGIN
  -- Callers may only ask about themselves, unless they are a superadmin or the
  -- service role (which is how the server-side guard runs).
  IF NOT (
    (_user_ids IS NULL AND auth.uid() = _user_id)
    OR public.is_superadmin(auth.uid())
    OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role'
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(sum(t.cost_usd), 0)::numeric
    INTO _total
    FROM public.execution_traces t
   WHERE t.created_at >= _since
     -- Scope-less callers ask "what has this USER spent". A scoped caller asks
     -- about one credential (an embed key, a swarm API key) and must NOT be
     -- narrowed by user as well: the point of a per-credential cap is to bound
     -- what that key can spend, whoever triggered it.
     AND (
       (_scope_type IS NOT NULL
           AND t.cost_scope_type = _scope_type
           AND t.cost_scope_id = _scope_id)
       OR (_scope_type IS NULL AND _user_ids IS NOT NULL AND t.user_id = ANY(_user_ids))
       OR (_scope_type IS NULL AND _user_ids IS NULL AND t.user_id = _user_id)
     );

  RETURN _total;
END;
$$;

REVOKE ALL ON FUNCTION public.budget_spend_since(uuid, timestamptz, text, uuid, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.budget_spend_since(uuid, timestamptz, text, uuid, uuid[])
  TO authenticated, service_role;

-- The guard filters by user + created_at on every check; the scoped variant by
-- (cost_scope_type, cost_scope_id, created_at), which 20260750000000 already
-- indexed.
CREATE INDEX IF NOT EXISTS idx_execution_traces_user_created
  ON public.execution_traces(user_id, created_at DESC);
