-- What a read of the migrated catalog found (R454). docs/security/scripts/schema-audit.sql
-- is that read, and docs/security/assessments/2026-11-06-schema.md is what it found.
--
-- Apply this AFTER the R454 build. It drops the two functions the browser used to
-- seed sample datasets with, and the R454 build seeds them on the server instead.

-- 1. budget_spend_since let anyone read anyone's spend.
--
-- The guard was IF NOT (auth.uid() = _user_id OR ...). With no signed-in user,
-- auth.uid() is NULL, so the comparison is NULL, the whole condition is NULL, and
-- NOT NULL is NULL. IF NULL does not take the branch, so "not authorized" was never
-- raised. It also let a signed-in user pass their own id with a _scope_type, and the
-- query then ignored the id and summed that credential's spend, whoever owned it.
CREATE OR REPLACE FUNCTION public.budget_spend_since(
  _user_id uuid,
  _since timestamp with time zone,
  _scope_type text DEFAULT NULL::text,
  _scope_id uuid DEFAULT NULL::uuid,
  _user_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _total numeric;
BEGIN
  -- Callers may only ask about themselves, unless they are a superadmin or the
  -- service role (which is how the server-side guard runs). COALESCE, because any
  -- of these can be NULL, and a guard that comes out NULL does not refuse.
  IF NOT COALESCE(
    (_scope_type IS NULL AND _user_ids IS NULL AND auth.uid() = _user_id)
    OR public.is_superadmin(auth.uid())
    OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role',
    false
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
$function$;

-- Nothing signed-out has a reason to call these, whatever their own checks say.
-- Functions that row-level policies call stay executable: anon evaluates those too.
REVOKE ALL ON FUNCTION public.budget_spend_since(uuid, timestamp with time zone, text, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_spend_since(uuid, timestamp with time zone, text, uuid, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_spend_by_user(timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_spend_by_user(timestamp with time zone) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.audit_chain_verify() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_chain_verify() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.shared_dataset_rows(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shared_dataset_rows(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_use_notebook_runtime(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_use_notebook_runtime(uuid) TO authenticated, service_role;

-- 2. Anyone signed in could publish into every tenant's samples.
--
-- A sample is readable by everyone, and these tables' UPDATE policies never looked at
-- is_sample, so `UPDATE ... SET is_sample = true` on your own row put it in front of
-- every other tenant, agents' knowledge bases included. Four of these tables did not
-- check it on INSERT either. A policy cannot see the old value, so this is a trigger:
-- it refuses the change, and leaves any other edit to a row alone. Service-role and
-- migration writes are not affected, and nothing in the client ever sets this flag.
CREATE OR REPLACE FUNCTION public.refuse_client_sample_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND NEW.is_sample IS TRUE
     AND (TG_OP = 'INSERT' OR OLD.is_sample IS NOT TRUE) THEN
    RAISE EXCEPTION 'only the platform can mark a row as a sample'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.user_data_tables;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.user_data_tables
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.user_data_semantics;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.user_data_semantics
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.knowledge_bases;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.knowledge_documents;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.kb_chunks;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.kb_chunks
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.kb_chunk_parents;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.kb_chunk_parents
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.kb_sources;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.kb_sources
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.kb_graph_entities;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.kb_graph_entities
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.kb_graph_mentions;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.kb_graph_mentions
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();
DROP TRIGGER IF EXISTS refuse_client_sample_flag ON public.kb_graph_relations;
CREATE TRIGGER refuse_client_sample_flag BEFORE INSERT OR UPDATE OF is_sample ON public.kb_graph_relations
  FOR EACH ROW EXECUTE FUNCTION public.refuse_client_sample_flag();

-- 3. Anyone signed in could write into the shared sample datasets.
--
-- The browser seeded them through these two, with content it chose, so any user could
-- create a sample or add rows to one, and every tenant then read them. The R454 build
-- seeds them on the server, from the CSVs it ships with.
DROP FUNCTION IF EXISTS public.upsert_sample_dataset(text, text, jsonb);
DROP FUNCTION IF EXISTS public.insert_sample_rows(uuid, jsonb);

-- 4. The contact form could be skipped.
--
-- /api/contact writes with the service role, after its validation, its rate limit and
-- its honeypot. This policy let anyone insert straight through the database API without
-- any of them, and set status and admin_notes while they were at it.
DROP POLICY IF EXISTS "Anyone can submit a contact message" ON public.contact_messages;
REVOKE INSERT ON public.contact_messages FROM anon, authenticated;

-- 5. Avatars are public, and took any file of any size.
--
-- Same 5 MB as the page. Image types only, and no SVG: an SVG can carry script, and
-- this bucket serves it to anyone with the link.
UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
WHERE id = 'avatars';

-- 6. Grants that row-level security was the only thing standing behind.
--
-- These are Supabase's defaults. Nothing was reachable through them, because no policy
-- lets anon write now, but a table that one day ships without row-level security
-- should not be writable by the signed-out world. TRUNCATE ignores row-level security
-- altogether, and no client has a use for it, or for REFERENCES or TRIGGER.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;

-- Prove it on apply, so a partial run cannot pass for a finished one.
DO $proof$
DECLARE
  guarded integer;
BEGIN
  IF has_function_privilege('anon', 'public.budget_spend_since(uuid, timestamp with time zone, text, uuid, uuid[])', 'execute') THEN
    RAISE EXCEPTION 'R454: anon can still call budget_spend_since';
  END IF;
  IF to_regprocedure('public.insert_sample_rows(uuid, jsonb)') IS NOT NULL
     OR to_regprocedure('public.upsert_sample_dataset(text, text, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'R454: a browser sample writer is still there';
  END IF;
  IF has_table_privilege('anon', 'public.contact_messages', 'insert')
     OR has_table_privilege('authenticated', 'public.contact_messages', 'insert')
     OR EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'contact_messages' AND cmd = 'INSERT'
     ) THEN
    RAISE EXCEPTION 'R454: clients can still insert into contact_messages';
  END IF;
  SELECT count(*) INTO guarded
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.column_name = 'is_sample'
    AND NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = format('public.%I', c.table_name)::regclass
        AND t.tgname = 'refuse_client_sample_flag'
    );
  IF guarded <> 0 THEN
    RAISE EXCEPTION 'R454: % table(s) with is_sample have no guard', guarded;
  END IF;
END;
$proof$;
