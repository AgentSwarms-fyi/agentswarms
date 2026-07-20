-- User-authored Python notebooks (run client-side via Pyodide).
-- Cells are stored as a jsonb array: [{ id, type: 'markdown'|'code', source }].

CREATE TABLE public.user_python_notebooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled notebook',
  description text,
  cells jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_python_notebooks_user ON public.user_python_notebooks(user_id);

ALTER TABLE public.user_python_notebooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own python notebooks"
  ON public.user_python_notebooks FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_user_python_notebooks_updated_at
  BEFORE UPDATE ON public.user_python_notebooks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
