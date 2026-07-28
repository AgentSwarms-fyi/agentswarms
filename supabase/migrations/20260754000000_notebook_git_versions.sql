-- Git versioning for notebooks.
--
-- A published notebook is a production endpoint, so its source belongs in the
-- same place the rest of your code does. Committing already works through the
-- per-user git_export_config; this table is the in-app history: which commit a
-- version landed in, and what the notebook hashed to at the time, so the editor
-- can say "uncommitted changes" instead of guessing.
--
-- Git remains the source of truth — this is an index into it, not a second copy.

CREATE TABLE IF NOT EXISTS public.notebook_git_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notebook_id uuid NOT NULL REFERENCES public.user_python_notebooks(id) ON DELETE CASCADE,
  commit_sha text NOT NULL,
  commit_url text,
  message text NOT NULL,
  -- FNV-1a of the committed script. Compare against the live notebook to show
  -- whether there are changes that have not been committed.
  content_hash text NOT NULL,
  file_path text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab')),
  repo text NOT NULL,
  branch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notebook_git_versions_notebook
  ON public.notebook_git_versions(notebook_id, created_at DESC);

ALTER TABLE public.notebook_git_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own notebook git versions"
  ON public.notebook_git_versions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
