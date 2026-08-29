-- Version history for ETL pipelines: a snapshot per meaningful save, so a bad
-- edit is one restore away. Content columns mirror what the editor writes.
CREATE TABLE IF NOT EXISTS public.etl_pipeline_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.etl_pipelines(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  name text NOT NULL,
  mode text NOT NULL,
  graph jsonb,
  source_code text NOT NULL DEFAULT '',
  requirements text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, version_no)
);

CREATE INDEX IF NOT EXISTS etl_pipeline_versions_pipeline_idx
  ON public.etl_pipeline_versions (pipeline_id, version_no DESC);

ALTER TABLE public.etl_pipeline_versions ENABLE ROW LEVEL SECURITY;

-- Read-only for the owner: versions are written and restored by the server
-- (service role) so history cannot be forged or edited from the client.
CREATE POLICY "Users read own etl versions"
  ON public.etl_pipeline_versions FOR SELECT
  USING (auth.uid() = user_id);
