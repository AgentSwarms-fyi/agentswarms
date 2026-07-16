
-- Allow shared sample datasets (user_id NULL = public sample, owned by no one)
ALTER TABLE public.user_data_tables ALTER COLUMN user_id DROP NOT NULL;

-- Replace existing RLS policy with split read/write rules
DROP POLICY IF EXISTS "Users manage own data tables" ON public.user_data_tables;

CREATE POLICY "Anyone can view samples or own tables"
  ON public.user_data_tables FOR SELECT
  USING (is_sample = true OR auth.uid() = user_id);

CREATE POLICY "Users insert own tables"
  ON public.user_data_tables FOR INSERT
  WITH CHECK (auth.uid() = user_id AND is_sample = false);

CREATE POLICY "Users update own tables"
  ON public.user_data_tables FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own tables"
  ON public.user_data_tables FOR DELETE
  USING (auth.uid() = user_id);

-- Replace user_data_rows policies — anyone can read rows of a sample table,
-- only owners can read/write rows of their own tables.
DROP POLICY IF EXISTS "Users select own data rows" ON public.user_data_rows;
DROP POLICY IF EXISTS "Users insert own data rows" ON public.user_data_rows;
DROP POLICY IF EXISTS "Users update own data rows" ON public.user_data_rows;
DROP POLICY IF EXISTS "Users delete own data rows" ON public.user_data_rows;

CREATE POLICY "Anyone can view sample or own rows"
  ON public.user_data_rows FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.user_data_tables t
    WHERE t.id = user_data_rows.table_id
      AND (t.is_sample = true OR t.user_id = auth.uid())
  ));

CREATE POLICY "Users insert rows in own tables"
  ON public.user_data_rows FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_data_tables t
    WHERE t.id = user_data_rows.table_id
      AND t.user_id = auth.uid()
  ));

CREATE POLICY "Users update rows in own tables"
  ON public.user_data_rows FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.user_data_tables t
    WHERE t.id = user_data_rows.table_id
      AND t.user_id = auth.uid()
  ));

CREATE POLICY "Users delete rows in own tables"
  ON public.user_data_rows FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.user_data_tables t
    WHERE t.id = user_data_rows.table_id
      AND t.user_id = auth.uid()
  ));

-- Service-role bypass for seeding the global sample. We expose a SECURITY DEFINER
-- function so the client can request seeding without owning the row.
CREATE OR REPLACE FUNCTION public.upsert_sample_dataset(
  _name text,
  _source_filename text,
  _columns jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_id uuid;
  new_id uuid;
BEGIN
  -- Only authenticated users can trigger seeding
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

  SELECT id INTO existing_id
  FROM public.user_data_tables
  WHERE name = _name AND is_sample = true AND user_id IS NULL
  LIMIT 1;

  IF existing_id IS NOT NULL THEN
    RETURN existing_id;
  END IF;

  INSERT INTO public.user_data_tables (user_id, name, source_filename, columns, is_sample)
  VALUES (NULL, _name, _source_filename, _columns, true)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.insert_sample_rows(
  _table_id uuid,
  _rows jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

  -- Refuse if table is not a public sample
  IF NOT EXISTS (
    SELECT 1 FROM public.user_data_tables
    WHERE id = _table_id AND is_sample = true AND user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'not a public sample table';
  END IF;

  INSERT INTO public.user_data_rows (table_id, row)
  SELECT _table_id, value FROM jsonb_array_elements(_rows);

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_sample_dataset(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_sample_rows(uuid, jsonb) TO authenticated;
