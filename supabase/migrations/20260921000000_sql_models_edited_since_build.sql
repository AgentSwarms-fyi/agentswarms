-- A build's stamps describe the definition that was built, not the one on the row.
--
-- FOUND FROM THE UI. Open a model that says "built · 9,994 rows", change its
-- SQL, save: it still says "built · 9,994 rows". The status, the row count and
-- the time all belong to the previous definition, and the page has no way to
-- know. The save writes every column of the definition and none of the stamps,
-- so the stamps simply outlive what they vouched for.
--
-- The mark is set HERE, in a BEFORE UPDATE trigger, for the same reason the
-- semantic layer decertifies in one (20260820000000): every writer — the
-- editor, the API, a future import — goes through the row, and none can forget.
--
-- What counts as the definition: the SQL, where it builds to (schema, name),
-- how (materialization) and the tests a "built" also vouches for. Not the
-- description, tags, schedule or pause state — a model paused or rescheduled
-- still holds the table its last build wrote.
--
-- The mark is CLEARED by the runner, not here, and only when the mark it
-- loaded is still the mark on the row (run.server.ts, stampModel). A trigger
-- cannot tell a build that read the new definition from one that started
-- before the edit and stamped after it; the runner can, because it holds the
-- mark it read at plan time.

ALTER TABLE public.sql_models
  ADD COLUMN IF NOT EXISTS definition_changed_at timestamptz;

COMMENT ON COLUMN public.sql_models.definition_changed_at IS
  'Set when the SQL, target, materialization or tests change after a build; cleared by a build that read this definition. While set, last_status and last_row_count describe the previous definition.';

CREATE OR REPLACE FUNCTION public.sql_model_mark_edited()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sql             IS DISTINCT FROM OLD.sql
  OR NEW.schema_name     IS DISTINCT FROM OLD.schema_name
  OR NEW.name            IS DISTINCT FROM OLD.name
  OR NEW.materialization IS DISTINCT FROM OLD.materialization
  OR NEW.tests           IS DISTINCT FROM OLD.tests
  THEN
    NEW.definition_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sql_models_mark_edited ON public.sql_models;
CREATE TRIGGER trg_sql_models_mark_edited
  BEFORE UPDATE ON public.sql_models
  FOR EACH ROW
  EXECUTE FUNCTION public.sql_model_mark_edited();
