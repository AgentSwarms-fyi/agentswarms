-- User attributes for attribute-driven row-level security.
--
-- A share grant's row filter may carry the token {{user.<key>}} instead of a
-- literal value; at query time the token resolves to THIS caller's values
-- for <key> — one grant rule, per-viewer scope. Written only by superadmins
-- (service role via the IAM server functions); a user may read their own
-- rows so disclosure surfaces can explain the scope they are seeing.
CREATE TABLE IF NOT EXISTS public.iam_user_attributes (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-zA-Z_][a-zA-Z0-9_]*$' AND length(key) <= 64),
  attr_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (user_id, key)
);

ALTER TABLE public.iam_user_attributes ENABLE ROW LEVEL SECURITY;

-- Self-read only; every write goes through the service role. No INSERT/
-- UPDATE/DELETE policies exist on purpose — authenticated clients cannot
-- write their own attributes, which would let them widen their own scope.
DROP POLICY IF EXISTS "read own attributes" ON public.iam_user_attributes;
CREATE POLICY "read own attributes" ON public.iam_user_attributes
  FOR SELECT USING (auth.uid() = user_id);
