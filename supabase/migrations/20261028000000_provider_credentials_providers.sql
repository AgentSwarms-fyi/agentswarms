-- Every provider the encrypted credential store is asked to hold.
--
-- provider_credentials was created with
--   CHECK (provider IN ('bedrock', 'vertex', 'anthropic', 'azure_openai'))
-- and never widened, while the save path (saveProviderCredential) also accepts
-- 'oci_genai' and 'qwen' — so those saves were refused by the database. This
-- replaces the check with one that lists every provider the save schema knows,
-- including the new 'claude_aws' (Claude Platform on AWS).
--
-- The original constraint was declared inline, so its name is generated; drop
-- whichever CHECK constraint covers `provider`, rather than assuming the name.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.provider_credentials'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE public.provider_credentials DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

ALTER TABLE public.provider_credentials
  ADD CONSTRAINT provider_credentials_provider_check
  CHECK (provider IN (
    'bedrock',
    'vertex',
    'anthropic',
    'azure_openai',
    'oci_genai',
    'qwen',
    'claude_aws'
  ));

-- Prove it on apply: exactly one CHECK constraint covers `provider`, and it
-- admits every provider the save schema sends.
DO $$
DECLARE
  n int;
  def text;
  p text;
BEGIN
  SELECT count(*), max(pg_get_constraintdef(oid))
    INTO n, def
  FROM pg_constraint
  WHERE conrelid = 'public.provider_credentials'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%provider%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'provider_credentials: expected one provider CHECK constraint, found %', n;
  END IF;
  FOREACH p IN ARRAY ARRAY['bedrock', 'vertex', 'anthropic', 'azure_openai', 'oci_genai', 'qwen', 'claude_aws']
  LOOP
    IF position(quote_literal(p) IN def) = 0 THEN
      RAISE EXCEPTION 'provider_credentials: provider % is not admitted by %', p, def;
    END IF;
  END LOOP;
END
$$;
