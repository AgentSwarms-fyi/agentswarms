-- Sheets sharing: a workbook shared with people (by their account) or with
-- IAM groups, as a viewer or an editor. A viewer's share can leave sheets
-- out and keep only some rows of a sheet ("only the rows where Region is
-- West"); the server sends that viewer only those rows, so the rest never
-- reach their browser. See src/utils/sheets/access.server.ts.
--
-- Every read and write of a shared workbook goes through the server, which
-- resolves the caller's shares (their own, and their groups'); a browser
-- never reads these rows directly. Sharing and unsharing are audited by the
-- server (sheet.share / sheet.unshare), naming who was given what.

CREATE TABLE IF NOT EXISTS public.sheet_workbook_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workbook_id uuid NOT NULL REFERENCES public.sheet_workbooks(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  -- Viewers only: {"<sheet name, lower-case>": {"column": .., "values": [..], "header": n}}.
  row_filters jsonb CHECK (row_filters IS NULL OR role = 'viewer'),
  -- Viewers only: the sheets left out of this share (lower-case names).
  hidden_sheets text[] CHECK (hidden_sheets IS NULL OR role = 'viewer'),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workbook_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS sheet_workbook_shares_principal_idx
  ON public.sheet_workbook_shares (principal_type, principal_id);

ALTER TABLE public.sheet_workbook_shares ENABLE ROW LEVEL SECURITY;
-- No policy: only the server (service role) reads or writes shares, after
-- checking who is asking. RLS on with no policy refuses every browser.
