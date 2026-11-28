-- R556: the catalog keeps no value of a column its data's own rules hide.
--
-- A crawl profiles each column from a sample of rows and keeps three values it
-- read: one `sample`, and for numbers a `min` and a `max`. The catalog can be
-- shared read-only with people who have no access to the data itself
-- (20260739000000_catalog_grants), and it outlives the data: a value erased or
-- masked at the source stayed here. From now on a column keeps none of them
-- when
--   * it was judged to hold personal data (`pii`), or its owner tagged it `pii`;
--   * one of its owner's column mask rules keys on one of its tags
--     (lakehouse_tag_policies, scope 'column');
--   * its owner's policy for the table masks it (lakehouse_table_policies);
-- and no column of a table keeps one when a row filter covers the table (its
-- policy's, or a table-scope tag rule's on one of its tags): the sample could
-- be from a row some readers are filtered away from.
--
-- A column it empties is marked `values_hidden`, so the catalog panel can say
-- why it shows no sample; a column no longer hidden loses the mark on its next
-- write.
--
-- One function decides, on every insert and every update of the columns, so
-- the rule holds for every writer: a crawl, a sheet published to the
-- lakehouse, a tag typed in the catalog panel. A rule written later applies it
-- again to the owner's assets it reaches. A value a rule hid comes back only
-- when a later crawl reads it again with the rule gone. The application drops
-- the values of personal columns itself as well (src/lib/catalogColumnValues),
-- so it holds before this is applied too.

CREATE OR REPLACE FUNCTION public.catalog_strip_hidden_values()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  mask_tags text[];
  masked text[];
  filtered boolean;
BEGIN
  IF NEW.columns IS NULL OR jsonb_typeof(NEW.columns) <> 'array' THEN
    RETURN NEW;
  END IF;

  -- Tags whose columns are masked: the owner's column rules, and `pii`.
  SELECT coalesce(array_agg(lower(btrim(p.tag))), '{}')
    INTO mask_tags
    FROM public.lakehouse_tag_policies p
   WHERE p.user_id = NEW.user_id
     AND p.scope = 'column';
  mask_tags := mask_tags || 'pii'::text;

  -- The owner's policy for this table: the columns it masks, and its filter.
  SELECT coalesce(array_agg(lower(m.col)) FILTER (WHERE m.col IS NOT NULL), '{}'),
         coalesce(bool_or(nullif(btrim(tp.row_filter), '') IS NOT NULL), false)
    INTO masked, filtered
    FROM public.lakehouse_table_policies tp
    LEFT JOIN LATERAL unnest(tp.masked_columns) AS m(col) ON true
   WHERE tp.user_id = NEW.user_id
     AND lower(tp.schema_name) = lower(coalesce(NEW.schema_name, ''))
     AND lower(tp.table_name) = lower(NEW.name);

  -- A table-scope rule's filter, on one of the table's own tags.
  filtered := filtered OR EXISTS (
    SELECT 1
      FROM public.lakehouse_tag_policies p
     WHERE p.user_id = NEW.user_id
       AND p.scope = 'table'
       AND nullif(btrim(p.row_filter), '') IS NOT NULL
       AND lower(btrim(p.tag)) IN (
         SELECT lower(btrim(t.tag)) FROM unnest(coalesce(NEW.tags, '{}')) AS t(tag)
       )
  );

  NEW.columns := (
    SELECT coalesce(
             jsonb_agg(
               CASE
                 WHEN jsonb_typeof(e.c) <> 'object' THEN e.c
                 WHEN filtered
                   OR e.c ->> 'pii' = 'true'
                   OR lower(e.c ->> 'name') = ANY (masked)
                   OR (
                     jsonb_typeof(e.c -> 'tags') = 'array'
                     AND EXISTS (
                       SELECT 1
                         FROM jsonb_array_elements_text(e.c -> 'tags') AS t(tag)
                        WHERE lower(btrim(t.tag)) = ANY (mask_tags)
                     )
                   )
                 THEN (e.c - 'sample' - 'min' - 'max') || '{"values_hidden": true}'::jsonb
                 ELSE e.c - 'values_hidden'
               END
               ORDER BY e.ord
             ),
             '[]'::jsonb
           )
      FROM jsonb_array_elements(NEW.columns) WITH ORDINALITY AS e(c, ord)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS catalog_assets_strip_hidden_values ON public.catalog_assets;
CREATE TRIGGER catalog_assets_strip_hidden_values
  BEFORE INSERT OR UPDATE OF columns, tags, schema_name, name ON public.catalog_assets
  FOR EACH ROW EXECUTE FUNCTION public.catalog_strip_hidden_values();

-- A rule written or changed later: run the owner's affected assets through the
-- function again. Only rows that still hold a value are touched.
CREATE OR REPLACE FUNCTION public.catalog_reapply_hidden_values()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'lakehouse_table_policies' THEN
    UPDATE public.catalog_assets a
       SET columns = a.columns
     WHERE a.user_id = NEW.user_id
       AND lower(coalesce(a.schema_name, '')) = lower(NEW.schema_name)
       AND lower(a.name) = lower(NEW.table_name)
       AND a.columns @? '$[*] ? (exists(@.sample) || exists(@.min) || exists(@.max))';
  ELSE
    UPDATE public.catalog_assets a
       SET columns = a.columns
     WHERE a.user_id = NEW.user_id
       AND a.columns @? '$[*] ? (exists(@.sample) || exists(@.min) || exists(@.max))';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS lakehouse_table_policies_hide_catalog_values ON public.lakehouse_table_policies;
CREATE TRIGGER lakehouse_table_policies_hide_catalog_values
  AFTER INSERT OR UPDATE ON public.lakehouse_table_policies
  FOR EACH ROW EXECUTE FUNCTION public.catalog_reapply_hidden_values();

DROP TRIGGER IF EXISTS lakehouse_tag_policies_hide_catalog_values ON public.lakehouse_tag_policies;
CREATE TRIGGER lakehouse_tag_policies_hide_catalog_values
  AFTER INSERT OR UPDATE ON public.lakehouse_tag_policies
  FOR EACH ROW EXECUTE FUNCTION public.catalog_reapply_hidden_values();

-- Trigger functions only: nobody calls them.
REVOKE ALL ON FUNCTION public.catalog_strip_hidden_values() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.catalog_reapply_hidden_values() FROM public, anon, authenticated;

-- The values already kept: every asset that holds one goes through once.
UPDATE public.catalog_assets a
   SET columns = a.columns
 WHERE jsonb_typeof(a.columns) = 'array'
   AND a.columns @? '$[*] ? (exists(@.sample) || exists(@.min) || exists(@.max))';
