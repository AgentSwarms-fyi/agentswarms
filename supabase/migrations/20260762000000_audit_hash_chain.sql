-- Tamper-evidence for the audit trail.
--
-- Each audit event now carries a hash over its own content PLUS the previous
-- event's hash, forming a chain: silently editing or deleting a row breaks
-- every hash after it, which the verification pass detects. This is
-- tamper-EVIDENT, not tamper-PROOF — an attacker with service-role access
-- could rewrite the whole chain — but it turns "quietly edit one row" into
-- "recompute and rewrite everything after it", which is loud, slow, and
-- defeated by shipping the NDJSON archive (with hashes) off the box.
--
-- Concurrency: the chain needs strict ordering, so the trigger takes a
-- transaction-scoped advisory lock. That serialises audit INSERTs — acceptable
-- because auditEvent() is fire-and-forget and low-volume by design.
--
-- Retention: the hourly purge deletes the oldest rows, so the first remaining
-- row's predecessor is gone. Verification therefore validates every LINK from
-- the oldest remaining row forward; the head row itself is vouched for by the
-- archived NDJSON, not by the live chain.

ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS chain_seq bigint,
  ADD COLUMN IF NOT EXISTS chain_hash text;

CREATE INDEX IF NOT EXISTS idx_audit_events_chain_seq
  ON public.audit_events(chain_seq) WHERE chain_seq IS NOT NULL;

CREATE OR REPLACE FUNCTION public.audit_hash_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  prev_hash text;
  prev_seq bigint;
BEGIN
  -- Serialise chain extension; the lock releases at transaction end.
  PERFORM pg_advisory_xact_lock(hashtext('audit_events_chain'));
  SELECT chain_hash, chain_seq INTO prev_hash, prev_seq
  FROM public.audit_events
  WHERE chain_seq IS NOT NULL
  ORDER BY chain_seq DESC
  LIMIT 1;

  NEW.chain_seq := COALESCE(prev_seq, 0) + 1;
  NEW.chain_hash := encode(
    sha256(
      convert_to(
        COALESCE(prev_hash, 'genesis')
          || '|' || NEW.chain_seq::text
          || '|' || COALESCE(NEW.user_id::text, '')
          || '|' || COALESCE(NEW.action, '')
          || '|' || COALESCE(NEW.resource_type, '')
          || '|' || COALESCE(NEW.resource_id::text, '')
          || '|' || COALESCE(NEW.resource_name, '')
          || '|' || COALESCE(NEW.detail::text, '{}'),
        'utf8'
      )
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_hash_chain ON public.audit_events;
CREATE TRIGGER trg_audit_hash_chain
  BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_hash_chain();

-- Walk the chain and recompute every link. Returns the first broken sequence
-- number, or NULL when every link from the oldest remaining row holds.
-- SECURITY DEFINER + superadmin gate, since it scans the whole trail.
CREATE OR REPLACE FUNCTION public.audit_chain_verify()
RETURNS TABLE (checked bigint, first_broken_seq bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  prev_hash text := NULL;
  prev_seq bigint := NULL;
  expected text;
  n bigint := 0;
BEGIN
  IF NOT public.is_superadmin(auth.uid()) THEN
    RAISE EXCEPTION 'audit_chain_verify is superadmin-only';
  END IF;
  FOR r IN
    SELECT * FROM public.audit_events WHERE chain_seq IS NOT NULL ORDER BY chain_seq ASC
  LOOP
    n := n + 1;
    IF prev_seq IS NOT NULL THEN
      -- A gap in sequence numbers means a deleted row.
      IF r.chain_seq <> prev_seq + 1 THEN
        RETURN QUERY SELECT n, r.chain_seq;
        RETURN;
      END IF;
      expected := encode(
        sha256(
          convert_to(
            prev_hash
              || '|' || r.chain_seq::text
              || '|' || COALESCE(r.user_id::text, '')
              || '|' || COALESCE(r.action, '')
              || '|' || COALESCE(r.resource_type, '')
              || '|' || COALESCE(r.resource_id::text, '')
              || '|' || COALESCE(r.resource_name, '')
              || '|' || COALESCE(r.detail::text, '{}'),
            'utf8'
          )
        ),
        'hex'
      );
      IF expected <> r.chain_hash THEN
        RETURN QUERY SELECT n, r.chain_seq;
        RETURN;
      END IF;
    END IF;
    prev_hash := r.chain_hash;
    prev_seq := r.chain_seq;
  END LOOP;
  RETURN QUERY SELECT n, NULL::bigint;
END;
$$;
