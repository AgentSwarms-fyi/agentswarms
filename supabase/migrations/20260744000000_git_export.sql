-- Git-based versioning: export BI dashboards + semantic models as sanitized
-- JSON "as code" to a connected GitHub/GitLab repo. Per-user config; the access
-- token is AES-GCM encrypted (same envelope as warehouse/catalog credentials)
-- and never returned to the client.
CREATE TABLE public.git_export_config (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab')),
  -- github: "owner/name"; gitlab: project path ("group/project") or numeric id.
  repo text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  base_path text NOT NULL DEFAULT 'agentswarms',
  -- Optional API base for self-hosted GitLab (e.g. https://gitlab.example.com).
  host text,
  -- { ciphertext, iv } — encrypted PAT.
  token_enc jsonb,
  last_export_at timestamptz,
  last_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.git_export_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own git config" ON public.git_export_config
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_git_export_config_updated_at
BEFORE UPDATE ON public.git_export_config
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
