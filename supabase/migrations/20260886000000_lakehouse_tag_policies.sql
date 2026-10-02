-- Policies by tag.
--
-- A security policy named one table. Tag a column `pii` on ten tables and
-- you still wrote ten policies, and the eleventh table shipped unmasked. A
-- tag policy is one rule an owner writes once: every column carrying the tag
-- is masked, or every table carrying the tag is filtered, wherever the tag
-- is — in the catalog, on the asset (table tags) or on its columns. At read
-- time the rule is folded into the same per-table policy the parser-level
-- rewrite already enforces, so nothing about how enforcement works changes.
CREATE TABLE public.lakehouse_tag_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tag text NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
  -- column: mask every column carrying the tag; table: filter every table carrying it.
  scope text NOT NULL CHECK (scope IN ('column', 'table')),
  mask_style text NOT NULL DEFAULT 'null' CHECK (mask_style IN ('null', 'hash')),
  row_filter text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tag, scope)
);

ALTER TABLE public.lakehouse_tag_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owners manage their tag policies"
  ON public.lakehouse_tag_policies FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.lakehouse_tag_policies IS
  'One rule per (tag, scope): mask every column with the tag, or filter every table with it, for everyone but the owner.';
