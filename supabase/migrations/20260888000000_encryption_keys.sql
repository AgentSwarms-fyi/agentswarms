-- Envelope encryption: the wrapped data-encryption key (DEK).
--
-- With KMS_PROVIDER=env nothing here is used: the DEK is derived from
-- PROVIDER_CREDS_SECRET as it always was. With an external key provider the
-- DEK is random, wrapped by the provider's key (the KEK, which never leaves
-- it), and stored here as ciphertext the provider alone can open. One row is
-- active; retired rows stay so ciphertext written under an earlier DEK still
-- decrypts while the re-encrypt sweep moves it.
--
-- Why a table and not a file: replicas share it, it backs up with the data,
-- and a database dump without the provider's permission opens nothing.

CREATE TABLE public.encryption_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('vault', 'aws', 'gcp', 'azure', 'oci')),
  key_ref text NOT NULL,
  -- The wrapped DEK, in the provider's own ciphertext form (e.g. "vault:v1:…").
  material text NOT NULL,
  -- Fingerprint of the DEK, the same scheme ciphertext rows carry as `kid`.
  kid text NOT NULL UNIQUE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

-- Exactly one active data key at a time.
CREATE UNIQUE INDEX encryption_keys_one_active
  ON public.encryption_keys ((retired_at IS NULL))
  WHERE retired_at IS NULL;

ALTER TABLE public.encryption_keys ENABLE ROW LEVEL SECURITY;

-- Superadmins may see which keys exist (the material is useless without the
-- provider); writes go through the service role from guarded server code.
CREATE POLICY "Superadmins view encryption keys"
  ON public.encryption_keys FOR SELECT
  USING (public.is_superadmin(auth.uid()));
