-- My work: what a person starred and what they opened last (R515).
--
-- One row per person per object, for every kind of object: an agent, a
-- dashboard, a lakehouse table (whose id is schema.table, hence text). A row
-- says WHICH object and WHEN, and nothing else.
--
-- NO NAMES ARE STORED. A mark is given its name when it is read, by looking the
-- object up among what its owner may see at that moment. Something deleted, or
-- no longer shared, stops being listed without anybody tidying up, and a mark
-- can never show a name the object's own page would refuse to show.
--
-- WHO MAY READ AND WRITE. Only the person the row belongs to. What somebody
-- opened is theirs alone: there is no policy for anyone else, and no function
-- that reads it for an administrator.

CREATE TABLE IF NOT EXISTS public.object_marks (
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Which kind of object: 'agent', 'dashboard', 'lakehouse_table'. Not a CHECK
  -- list: a new kind is added in the app, and a list here would refuse it
  -- until a migration caught up.
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  object_id text NOT NULL CHECK (length(object_id) BETWEEN 1 AND 400),
  -- Set while it is a favourite; cleared when the star is taken off.
  starred_at timestamptz,
  -- The last time its owner opened it; cleared by "Clear recently opened".
  opened_at timestamptz,
  PRIMARY KEY (user_id, kind, object_id)
);

ALTER TABLE public.object_marks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "People read their own marks" ON public.object_marks;
CREATE POLICY "People read their own marks"
  ON public.object_marks FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "People add their own marks" ON public.object_marks;
CREATE POLICY "People add their own marks"
  ON public.object_marks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "People change their own marks" ON public.object_marks;
CREATE POLICY "People change their own marks"
  ON public.object_marks FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "People remove their own marks" ON public.object_marks;
CREATE POLICY "People remove their own marks"
  ON public.object_marks FOR DELETE
  USING (auth.uid() = user_id);

-- The two lists the app reads: favourites newest first, and what was opened
-- last. Partial, because most rows are only one of the two.
CREATE INDEX IF NOT EXISTS object_marks_starred_idx
  ON public.object_marks (user_id, starred_at DESC) WHERE starred_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS object_marks_opened_idx
  ON public.object_marks (user_id, opened_at DESC) WHERE opened_at IS NOT NULL;
