-- Remove the Community feature entirely: publishing/browsing/remixing
-- community agents & swarms, likes, and reports. The app no longer has
-- any UI or API surface that reads or writes these tables.
-- CASCADE drops the dependent triggers (trg_community_agents_updated_at,
-- trg_community_swarms_updated_at, trg_community_likes_count,
-- trg_community_reports_count) and indexes along with their tables.
DROP TABLE IF EXISTS public.community_likes CASCADE;
DROP TABLE IF EXISTS public.community_reports CASCADE;
DROP TABLE IF EXISTS public.community_agents CASCADE;
DROP TABLE IF EXISTS public.community_swarms CASCADE;

DROP FUNCTION IF EXISTS public.update_community_likes_count();
DROP FUNCTION IF EXISTS public.update_community_reports_count();
DROP FUNCTION IF EXISTS public.bump_community_remix_count(TEXT, UUID);
