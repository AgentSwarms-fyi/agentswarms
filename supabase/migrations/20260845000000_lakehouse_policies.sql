-- Row and column security for lakehouse tables.
--
-- DuckDB has no per-user ACLs, so a policy cannot be enforced by the engine's
-- own permission system. Instead the server rewrites a non-owner's SELECT
-- before it executes: the referenced table becomes a subquery carrying the
-- row filter and the column masks. The rewrite is done on the AST DuckDB
-- itself produced, so a policy cannot be dodged by creative SQL text.
--
-- Policies are authored ONLY by the schema owner and apply to everyone else
-- who has been granted access. The owner is never filtered — they can already
-- see everything by definition, and a policy they cannot see through would be
-- impossible to debug.
CREATE TABLE public.lakehouse_table_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  -- A boolean SQL expression over the table's own columns. Supports @me and
  -- @user_id placeholders, substituted server-side as escaped literals.
  row_filter text,
  -- Columns the reader may not see the values of.
  masked_columns text[] NOT NULL DEFAULT '{}',
  -- 'null' blanks the value for any type; 'hash' keeps text joinable while
  -- hiding the content, and falls back to null for non-text columns.
  mask_style text NOT NULL DEFAULT 'null' CHECK (mask_style IN ('null', 'hash')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, schema_name, table_name)
);

CREATE INDEX idx_lakehouse_table_policies_table
  ON public.lakehouse_table_policies(schema_name, table_name);

ALTER TABLE public.lakehouse_table_policies ENABLE ROW LEVEL SECURITY;

-- Only the author manages their policies. Readers never see the policy row —
-- knowing the filter would tell them exactly what they are being denied.
CREATE POLICY "own policies" ON public.lakehouse_table_policies
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TRIGGER lakehouse_table_policies_updated
  BEFORE UPDATE ON public.lakehouse_table_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
