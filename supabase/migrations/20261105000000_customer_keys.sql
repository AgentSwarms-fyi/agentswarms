-- Customer keys and user keys: the key layer between the deployment's key and
-- a user's stored values (docs/KEY_MANAGEMENT.md#customer-keys-and-user-keys).
--
--   deployment key ─wraps─▶ user key ─encrypts─▶ the user's stored values
--   deployment key ─wraps─▶ customer key (held by the app)  ─wraps─▶ members' user keys
--   customer's KMS ─wraps─▶ customer key (in their own KMS) ─wraps─▶ members' user keys
--
-- Every key here is stored wrapped; none is usable without the key above it.
-- Erasing a user key, or destroying a customer key, nulls its material and
-- keeps the row: the fingerprint stays, so a value under it can say why it no
-- longer reads, and nothing reuses the fingerprint.
--
-- Server-only: RLS is on with no policies, so only the service role reads or
-- writes these tables. The admin card goes through superadmin-gated server
-- functions.

CREATE TABLE public.customer_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- 'app': wrapped by the deployment's key, here. Otherwise the provider of
  -- the customer's own key, which wraps it there.
  provider text NOT NULL CHECK (provider IN ('app', 'vault', 'aws', 'azure', 'gcp', 'oci')),
  key_ref text,
  -- OCI Vault only: the customer vault's cryptographic endpoint.
  endpoint text,
  material text,
  iv text,
  -- Held by the app: the fingerprint of the deployment key that wrapped it.
  wrapped_by text,
  kid text NOT NULL UNIQUE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  destroyed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK ((provider = 'app') = (key_ref IS NULL)),
  CHECK (destroyed_at IS NOT NULL OR material IS NOT NULL),
  CHECK (provider <> 'app' OR destroyed_at IS NOT NULL OR (iv IS NOT NULL AND wrapped_by IS NOT NULL))
);

-- One name per live key: the card and the audit name keys by it.
CREATE UNIQUE INDEX customer_keys_live_name
  ON public.customer_keys (lower(btrim(name)))
  WHERE destroyed_at IS NULL;

-- Who a customer key covers: users directly, or IAM groups. A user or a group
-- is assigned to one customer key at most; a user in two groups assigned to
-- different keys is a conflict the app refuses to guess at.
CREATE TABLE public.customer_key_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_key_id uuid NOT NULL REFERENCES public.customer_keys(id) ON DELETE CASCADE,
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id uuid UNIQUE REFERENCES public.iam_groups(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (group_id IS NULL))
);

CREATE INDEX customer_key_members_key ON public.customer_key_members (customer_key_id);

-- One key per user, made at the user's first save. Deleting the account
-- deletes it, and with it every value it encrypted.
CREATE TABLE public.user_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kid text NOT NULL UNIQUE,
  material text,
  iv text,
  -- The customer key that wraps it; NULL when the deployment's key does.
  customer_key_id uuid REFERENCES public.customer_keys(id) ON DELETE RESTRICT,
  -- The wrapper's fingerprint: a deployment key's, or the customer key's.
  wrapped_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  erased_at timestamptz,
  erased_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (erased_at IS NOT NULL OR (material IS NOT NULL AND iv IS NOT NULL))
);

-- Exactly one live key per user; erased ones stay as tombstones.
CREATE UNIQUE INDEX user_keys_one_live
  ON public.user_keys (user_id)
  WHERE erased_at IS NULL;

CREATE INDEX user_keys_customer ON public.user_keys (customer_key_id)
  WHERE customer_key_id IS NOT NULL;

ALTER TABLE public.customer_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_key_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_keys ENABLE ROW LEVEL SECURITY;

-- Destroying a customer key, in one transaction: the assignments go (so no
-- member's next save is written under it), every user key it wraps is erased,
-- and its own material is nulled. Returns how many user keys were erased.
CREATE OR REPLACE FUNCTION public.destroy_customer_key(p_id uuid, p_by uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  erased integer;
BEGIN
  PERFORM 1 FROM public.customer_keys WHERE id = p_id AND destroyed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer key % does not exist or is already destroyed', p_id
      USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM public.customer_key_members WHERE customer_key_id = p_id;
  UPDATE public.user_keys
     SET material = NULL, iv = NULL, erased_at = now(), erased_by = p_by
   WHERE customer_key_id = p_id AND erased_at IS NULL;
  GET DIAGNOSTICS erased = ROW_COUNT;
  UPDATE public.customer_keys
     SET material = NULL, iv = NULL, destroyed_at = now(), destroyed_by = p_by
   WHERE id = p_id;
  RETURN erased;
END;
$$;

REVOKE ALL ON FUNCTION public.destroy_customer_key(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.destroy_customer_key(uuid, uuid) TO service_role;
