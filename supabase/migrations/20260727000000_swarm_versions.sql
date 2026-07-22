-- Swarm version history: point-in-time snapshots of a swarm's graph so users
-- can save milestones and restore/undo. Snapshots are captured automatically
-- on Save (deduped) and manually ("Save as version"); a safety snapshot is
-- taken before a Restore. History is capped per swarm client-side.
CREATE TABLE public.swarm_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_id uuid NOT NULL REFERENCES public.swarms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Snapshot',
  kind text NOT NULL DEFAULT 'manual', -- 'auto' | 'manual' | 'restore'
  nodes jsonb NOT NULL DEFAULT '[]'::jsonb,
  edges jsonb NOT NULL DEFAULT '[]'::jsonb,
  node_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.swarm_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own swarm versions" ON public.swarm_versions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_swarm_versions_swarm ON public.swarm_versions(swarm_id, created_at DESC);
