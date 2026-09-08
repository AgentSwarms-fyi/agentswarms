-- SCIM 2.0 provisioning: users and groups pushed from the identity provider.
--
-- The IdP authenticates with a bearer token a superadmin mints on the SSO
-- tab. The plaintext is shown once; only its SHA-256 lives here, the same
-- arrangement as gateway and ML keys. Groups gain the IdP's own id so a
-- renamed group stays the same group, and the signup gate learns that a
-- user the IdP pushed is as welcome as one an admin created.

CREATE TABLE public.iam_scim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count bigint NOT NULL DEFAULT 0,
  revoked_at timestamptz
);

ALTER TABLE public.iam_scim_tokens ENABLE ROW LEVEL SECURITY;

-- Superadmins see the list (never the hash of anything usable); every write
-- goes through the service role from a server function that has already
-- checked the caller.
CREATE POLICY "Superadmins view scim tokens"
  ON public.iam_scim_tokens FOR SELECT
  USING (public.is_superadmin(auth.uid()));

-- The IdP's identifier for a group. Nullable: groups made in the app have
-- none. Unique where present so two IdP groups cannot map to one of ours.
ALTER TABLE public.iam_groups ADD COLUMN external_id text;
CREATE UNIQUE INDEX iam_groups_external_id_key
  ON public.iam_groups (external_id)
  WHERE external_id IS NOT NULL;

-- A user the IdP provisioned passes the invite-only gate, like one an admin
-- created or one arriving through SSO.
CREATE OR REPLACE FUNCTION public.iam_enforce_signup_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT NOT allow_public_signup FROM public.iam_settings LIMIT 1)
     AND NEW.invited_at IS NULL
     AND COALESCE(NEW.raw_app_meta_data->>'provisioned_by', '') NOT IN ('admin', 'scim')
     AND COALESCE(NEW.raw_app_meta_data->>'provider', '') NOT LIKE 'sso:%'
  THEN
    RAISE EXCEPTION 'signups_disabled';
  END IF;
  RETURN NEW;
END;
$function$;
