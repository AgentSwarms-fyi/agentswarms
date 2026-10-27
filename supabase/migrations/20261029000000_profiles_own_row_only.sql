-- VA-2026-10-25-16: every signed-in user could read every profile -- name,
-- avatar, role, designation, organization, bio, first and last name -- and so
-- list every user_id, because public.profiles had a SELECT policy USING (true)
-- for `authenticated` (20260504100311, which narrowed an anon-readable one that
-- 20260419113056 added for community author cards).
--
-- Nothing in the app reads another user's profile through a user's session.
-- The browser reads only the signed-in user's own row (Account settings, the
-- user menu, the dashboard greeting, onboarding). Every place that shows other
-- people's names -- the approver picker, IAM's user list, a sheet's sharing
-- labels, budget alerts, SCIM -- is a server function reading as the service
-- role, which bypasses RLS and returns only the fields that feature needs.
-- Community cards carry an author snapshot taken when the item is published.
-- So the instance-wide policy goes, and the owner-only policy is what remains.
--
-- The approver picker's directory (id, email and display name of each account,
-- for routing an approval to a person or a group) stays: it is the one
-- directory the product needs, and it is minimal. The assessment records it as
-- accepted.

DROP POLICY IF EXISTS "Authenticated users can view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Public can view profiles" ON public.profiles;

-- Re-assert the owner-only policy rather than rely on the 2026-04 one having
-- survived untouched.
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile"
  ON public.profiles
  FOR SELECT
  USING (auth.uid() = user_id);

-- Prove it on apply, so a bad push fails here rather than shipping.
DO $$
DECLARE
  bad text;
  other uuid;
  stranger uuid := gen_random_uuid();
  seen_as_stranger integer;
  seen_as_owner integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass) THEN
    RAISE EXCEPTION 'profiles own-row: row level security is off on public.profiles';
  END IF;

  -- Every permissive policy that lets a client read (SELECT or ALL) must be
  -- the owner-only one.
  SELECT string_agg(format('%s (%s): %s', policyname, cmd, coalesce(qual, 'no USING')), '; ')
    INTO bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profiles'
    AND cmd IN ('SELECT', 'ALL')
    AND permissive = 'PERMISSIVE'
    AND coalesce(qual, '') <> '(auth.uid() = user_id)';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'profiles own-row: a policy still lets users read other profiles: %', bad;
  END IF;

  -- And as Postgres enforces it: a signed-in user who is not the owner sees
  -- none of a real profile, and its owner sees it. Needs one profile to read
  -- (a fresh install has none) and the right to act as `authenticated`.
  SELECT user_id INTO other FROM public.profiles LIMIT 1;
  IF other IS NULL THEN
    RAISE NOTICE 'profiles own-row: no profiles yet, so the as-a-user read was skipped';
    RETURN;
  END IF;
  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', stranger, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO seen_as_stranger FROM public.profiles WHERE user_id = other;
    PERFORM set_config('request.jwt.claim.sub', other::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', other, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO seen_as_owner FROM public.profiles WHERE user_id = other;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'profiles own-row: could not act as authenticated here, so the as-a-user read was skipped';
    RETURN;
  END;
  IF seen_as_stranger <> 0 THEN
    RAISE EXCEPTION 'profiles own-row: a signed-in user can still read another user''s profile';
  END IF;
  IF seen_as_owner <> 1 THEN
    RAISE EXCEPTION 'profiles own-row: a user can no longer read their own profile (saw % rows)', seen_as_owner;
  END IF;
END $$;
