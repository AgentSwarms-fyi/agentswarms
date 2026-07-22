-- Data Catalog business glossary. A term defines a tag: tagging an asset
-- with a term's name links it to the definition, so glossary membership
-- needs no extra join table and terms are searchable through the existing
-- tag search.
CREATE TABLE public.catalog_glossary_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  term text NOT NULL,
  definition text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, term)
);

ALTER TABLE public.catalog_glossary_terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own glossary terms" ON public.catalog_glossary_terms
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
