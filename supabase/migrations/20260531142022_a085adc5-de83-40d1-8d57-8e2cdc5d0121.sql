CREATE TABLE public.blog_view_counts (
  blog_slug TEXT PRIMARY KEY,
  views BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.blog_view_counts TO anon, authenticated;
GRANT ALL ON public.blog_view_counts TO service_role;

ALTER TABLE public.blog_view_counts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view counts readable by all" ON public.blog_view_counts
  FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION public.increment_blog_view(_slug TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_count BIGINT;
BEGIN
  IF _slug IS NULL OR length(_slug) = 0 OR length(_slug) > 200 THEN
    RAISE EXCEPTION 'invalid slug';
  END IF;
  INSERT INTO public.blog_view_counts (blog_slug, views)
  VALUES (_slug, 1)
  ON CONFLICT (blog_slug) DO UPDATE
    SET views = public.blog_view_counts.views + 1,
        updated_at = now()
  RETURNING views INTO new_count;
  RETURN new_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_blog_view(TEXT) TO anon, authenticated;