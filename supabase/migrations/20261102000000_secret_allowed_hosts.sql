-- Where a shared secret may be sent (R419, VA-2026-10-25-30).
--
-- Sharing a secret by IAM grant is meant to let a colleague USE it without
-- ever seeing its value. In every config a colleague writes they also choose
-- where it goes (a provider base URL, a connection host, an HTTP node URL), so
-- a shared {{secret:NAME}} aimed at their own server handed them the value.
-- The owner now lists the hosts a secret may be sent to; the server resolves a
-- shared secret only toward those (src/utils/secrets.server.ts) and validates
-- each entry when it is saved (src/lib/secretHosts.ts). The owner's own use is
-- not restricted, and an empty list means nobody else can use the secret.
--
-- Safe in either order with the R419 code: the resolver reads `*`, so before
-- this runs a shared secret simply has no allowed host.

ALTER TABLE public.user_secrets
  ADD COLUMN IF NOT EXISTS allowed_hosts text[] NOT NULL DEFAULT '{}';

-- The owner's FOR ALL policy lets a client write its own row directly, past
-- the server's validation, so the database bounds what that can store.
ALTER TABLE public.user_secrets
  DROP CONSTRAINT IF EXISTS user_secrets_allowed_hosts_bounded;
ALTER TABLE public.user_secrets
  ADD CONSTRAINT user_secrets_allowed_hosts_bounded CHECK (
    cardinality(allowed_hosts) <= 50
    AND array_position(allowed_hosts, NULL) IS NULL
    AND length(array_to_string(allowed_hosts, ',')) <= 13000
  );

COMMENT ON COLUMN public.user_secrets.allowed_hosts IS
  'Hosts a grantee may send this secret to (exact, or *.domain). Empty: nobody but the owner can use it.';

-- ── Prove it ─────────────────────────────────────────────────────────────────
-- The list is the owner's decision; a policy that let a grantee UPDATE the row
-- would let them allow their own server. Every policy that can write must be
-- scoped to the owner, and the column must be what the resolver expects.
DO $$
DECLARE p record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_secrets'
      AND column_name = 'allowed_hosts' AND data_type = 'ARRAY'
      AND udt_name = '_text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'secret allowed hosts: user_secrets.allowed_hosts is not text[] NOT NULL';
  END IF;
  FOR p IN
    SELECT policyname, cmd, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_secrets'
      AND cmd IN ('ALL', 'UPDATE', 'INSERT')
  LOOP
    IF coalesce(p.qual, p.with_check) IS NULL
       OR coalesce(p.qual, '') ~ '\mOR\M' OR coalesce(p.with_check, '') ~ '\mOR\M'
       OR position('auth.uid()' in coalesce(p.qual, p.with_check)) = 0
       OR position('user_id' in coalesce(p.qual, p.with_check)) = 0 THEN
      RAISE EXCEPTION 'secret allowed hosts: policy % on user_secrets is not owner-only', p.policyname;
    END IF;
  END LOOP;
END $$;
