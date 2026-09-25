-- The Sheets page: "edited" that means edited, and a thumbnail per workbook.
--
-- R122. A workbook's updated_at moved only when the workbook row itself
-- changed (a rename, a restore), never when its cells did: the grid save
-- writes sheet_tabs. So the Sheets page said "edited 4h ago" of a workbook
-- edited a minute earlier, and kept it below ones untouched for hours. A
-- change to a sheet now touches its workbook.

CREATE OR REPLACE FUNCTION public.sheet_tabs_touch_workbook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wb uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    wb := OLD.workbook_id;
  ELSE
    wb := NEW.workbook_id;
  END IF;
  -- The workbook's own BEFORE UPDATE trigger sets updated_at to now().
  -- While the workbook itself is being deleted, its row is already gone and
  -- this matches nothing.
  UPDATE public.sheet_workbooks SET updated_at = now() WHERE id = wb;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sheet_tabs_touch_workbook ON public.sheet_tabs;
CREATE TRIGGER sheet_tabs_touch_workbook
  AFTER INSERT OR DELETE OR UPDATE OF grid, table_config, name, kind, position
  ON public.sheet_tabs
  FOR EACH ROW EXECUTE FUNCTION public.sheet_tabs_touch_workbook();

-- Workbooks edited before this: their last sheet change, not the time the
-- row was last renamed. The workbook's own trigger would stamp now(), so it
-- is held off for this one statement.
ALTER TABLE public.sheet_workbooks DISABLE TRIGGER sheet_workbooks_updated_at;
UPDATE public.sheet_workbooks w
   SET updated_at = t.last_edit
  FROM (SELECT workbook_id, max(updated_at) AS last_edit FROM public.sheet_tabs GROUP BY workbook_id) t
 WHERE t.workbook_id = w.id AND t.last_edit > w.updated_at;
ALTER TABLE public.sheet_workbooks ENABLE TRIGGER sheet_workbooks_updated_at;

-- The thumbnail: the top-left corner of the first grid sheet as it reads on
-- screen, built in the browser (where the values are computed). A table of
-- its own, so writing one is not an edit of the workbook.
CREATE TABLE IF NOT EXISTS public.sheet_workbook_previews (
  workbook_id uuid PRIMARY KEY REFERENCES public.sheet_workbooks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  preview jsonb NOT NULL CHECK (pg_column_size(preview) <= 16384),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sheet_workbook_previews ENABLE ROW LEVEL SECURITY;
-- Read and written by the server for the workbook's owner; the owner may
-- read their own.
DROP POLICY IF EXISTS "Owners read their workbook previews" ON public.sheet_workbook_previews;
CREATE POLICY "Owners read their workbook previews" ON public.sheet_workbook_previews
  FOR SELECT USING (auth.uid() = user_id);
