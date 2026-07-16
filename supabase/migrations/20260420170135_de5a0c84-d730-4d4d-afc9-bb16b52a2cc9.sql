
-- Recreate functions with explicit search_path (silences linter)
CREATE OR REPLACE FUNCTION public.upsert_sample_dataset(
  _name text,
  _source_filename text,
  _columns jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  existing_id uuid;
  new_id uuid;
BEGIN
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
SET search_path = ''
AS $$
DECLARE
  inserted_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

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

-- Also harden the two pre-existing functions flagged by the linter
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
