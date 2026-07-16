
-- ============================================================
-- 1. PROFILES: restrict SELECT to authenticated users only
-- ============================================================
DROP POLICY IF EXISTS "Public can view profiles" ON public.profiles;

CREATE POLICY "Authenticated users can view profiles"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- 2. CERTIFICATES: remove blanket anon SELECT
-- ============================================================
DROP POLICY IF EXISTS "Public can verify certificates by code" ON public.certificates;

-- ============================================================
-- 3. REALTIME: remove mcp_servers (contains auth_token)
-- ============================================================
ALTER PUBLICATION supabase_realtime DROP TABLE public.mcp_servers;

-- ============================================================
-- 4. REVOKE EXECUTE from anon on SECURITY DEFINER functions
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.enqueue_email(text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(text, integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_email(text, bigint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(text, text, bigint, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_gateway_usage(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.add_gateway_output_tokens(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_gateway_image_usage(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bump_community_remix_count(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_community_reports_count() FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_community_likes_count() FROM anon;
REVOKE EXECUTE ON FUNCTION public.insert_sample_rows(uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.upsert_sample_dataset(text, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.derive_memory_keywords() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prune_agent_memory_items(uuid, uuid, integer) FROM anon;
