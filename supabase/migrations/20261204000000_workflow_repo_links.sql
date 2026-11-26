-- ML pipelines in the team's own repository (R541).
--
-- A workflow can be saved to the GitHub or GitLab repository its owner has
-- connected (git_export_config), updated from it, imported from it, and
-- deployed from it by a CI job. This table remembers which file a workflow is
-- kept in, and what both sides looked like at the last save or update, so the
-- page can say "changed here since" or "changed in the repo" without guessing.
--
-- Two hashes, because the two sides are written by different hands: what the
-- platform held after the last sync (local_hash) and what the repository file
-- said at that commit (repo_hash). After a save they are the same; after an
-- update from a file that named its targets differently they are not.
--
-- WHO MAY READ AND WRITE. The owner reads their own links. Every write is the
-- server's, after it has checked the workflow is the caller's and the file
-- meets every rule an editor save meets, so there is no write policy.

CREATE TABLE IF NOT EXISTS public.workflow_repo_links (
  workflow_id uuid PRIMARY KEY REFERENCES public.workflows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Which repository: provider, host and path, e.g. github:acme/ml. An update
  -- or a CI deploy refuses when the connected repository is no longer this one,
  -- rather than reading the same path from a different repository.
  repo text NOT NULL CHECK (char_length(repo) BETWEEN 3 AND 600),
  -- The file, from the repository root: <folder>/ml/pipelines/<name>.json
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 400 AND path !~ '(^/|\.\.)'),
  local_hash text NOT NULL CHECK (local_hash ~ '^[0-9a-f]{64}$'),
  repo_hash text NOT NULL CHECK (repo_hash ~ '^[0-9a-f]{64}$'),
  -- The commit the last save made, or the one an update read.
  synced_commit text CHECK (synced_commit IS NULL OR synced_commit ~ '^[0-9a-f]{7,64}$'),
  synced_at timestamptz NOT NULL DEFAULT now(),
  -- save: written from here; pull: updated from the repo by a person;
  -- import: created from a file; ci: deployed by a CI job with the trigger token.
  synced_by text NOT NULL CHECK (synced_by IN ('save', 'pull', 'import', 'ci')),
  UNIQUE (user_id, repo, path)
);

ALTER TABLE public.workflow_repo_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners read their own workflow repo links" ON public.workflow_repo_links;
CREATE POLICY "Owners read their own workflow repo links"
  ON public.workflow_repo_links FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.workflow_repo_links IS
  'Which repository file a workflow is kept in, and both sides'' hashes at the last save, update, import or CI deploy (R541). Written only by the server.';
