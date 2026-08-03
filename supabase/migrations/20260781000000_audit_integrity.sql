-- Audit-log integrity: survive the subject, and stop the subject writing it.
--
-- Two problems with audit_events as it stood, both of the kind that only show
-- up when someone actually needs the log.
--
-- ── 1. Deleting a user deleted their audit trail ──────────────────────────
--
-- user_id was `REFERENCES auth.users(id) ON DELETE CASCADE`, and
-- iamDeleteUser calls auth.admin.deleteUser(). So removing an account erased
-- the record of everything that account did — silently, and precisely when an
-- investigation would want it. "Offboard the departing employee" and "destroy
-- the evidence" were the same button.
--
-- The FK becomes SET NULL and the actor's email is denormalised at write time,
-- so the trail stays readable after the account is gone. A row with a NULL
-- user_id is a deleted subject, and is visible only to superadmins — there is
-- no longer an owner to show it to.
--
-- ── 2. Any client could forge any event ───────────────────────────────────
--
-- The INSERT policy was `WITH CHECK (auth.uid() = user_id)`, which lets a
-- browser write ANY action string attributed to itself. Browser-side inserts
-- exist for a real reason (local dataset queries record their own activity),
-- but nothing distinguished those from server-emitted governance events, so a
-- user could fabricate an `iam.access.grant` in their own trail, or flood the
-- table to push real entries out through retention.
--
-- Clients are now restricted to the handful of actions they legitimately
-- emit. Everything else goes through the service role, which bypasses RLS.

-- ── The trail outlives the account ───────────────────────────────────────────
ALTER TABLE public.audit_events
  DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey;

ALTER TABLE public.audit_events
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.audit_events
  ADD CONSTRAINT audit_events_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Captured when the event is written. Without it a deleted subject's rows are
-- an unattributable NULL, which is not much better than deleting them.
ALTER TABLE public.audit_events
  ADD COLUMN IF NOT EXISTS actor_email text;

-- ── Who can read what ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "View own or all audit events" ON public.audit_events;
CREATE POLICY "View own or all audit events" ON public.audit_events
  FOR SELECT USING (
    -- An orphaned row (deleted subject) has no owner, so only superadmins.
    (user_id IS NOT NULL AND auth.uid() = user_id)
    OR public.is_superadmin(auth.uid())
  );

-- ── What a browser may write ────────────────────────────────────────────────
-- Kept as a table rather than an inline list so adding a client-side event is
-- a visible, reviewable change rather than a string edit in a policy.
CREATE TABLE IF NOT EXISTS public.audit_client_actions (
  action text PRIMARY KEY
);

INSERT INTO public.audit_client_actions (action) VALUES
  ('dataset.query'),
  ('dataset.export'),
  ('dashboard.view'),
  ('workbench.query')
ON CONFLICT (action) DO NOTHING;

ALTER TABLE public.audit_client_actions ENABLE ROW LEVEL SECURITY;
-- Readable so the policy below can be understood from the client; writable
-- only by the service role (no INSERT/UPDATE/DELETE policy exists).
DROP POLICY IF EXISTS "Anyone signed in may read the client action list"
  ON public.audit_client_actions;
CREATE POLICY "Anyone signed in may read the client action list"
  ON public.audit_client_actions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Insert own audit events" ON public.audit_events;
CREATE POLICY "Insert own audit events" ON public.audit_events
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND action IN (SELECT a.action FROM public.audit_client_actions a)
  );

-- No UPDATE or DELETE policy on audit_events, deliberately: with RLS enabled
-- and no policy, those operations are denied outright for every non-service
-- role. That is what makes an entry append-only once written.

COMMENT ON TABLE public.audit_events IS
  'Append-only activity trail. Rows survive deletion of their subject (user_id '
  'becomes NULL, actor_email retains attribution). Browser inserts are limited '
  'to audit_client_actions; everything else is written with the service role.';
