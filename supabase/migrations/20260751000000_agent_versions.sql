-- Version history for standalone agents.
--
-- Swarms already had this (swarm_versions + a versions dialog). Agents did not:
-- editing a production agent's system prompt, model or tool wiring was an
-- unversioned in-place mutation with no way to see what changed or roll back.
--
-- A version is a point-in-time snapshot of the agent's whole configuration.
-- Snapshots are taken automatically on save (skipped when nothing changed) and
-- capped per agent so history can't grow without bound.
CREATE TABLE IF NOT EXISTS public.agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Snapshot',
  -- 'auto'    — taken on save
  -- 'manual'  — user pressed "Save version"
  -- 'restore' — snapshot of what was replaced, taken before a rollback so the
  --             rollback itself is undoable
  kind text NOT NULL DEFAULT 'auto' CHECK (kind IN ('auto', 'manual', 'restore')),
  -- Full agent config at that moment (name, prompt, provider/model, params,
  -- knowledge bases, tools, guardrails, skills…).
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own agent versions" ON public.agent_versions;
CREATE POLICY "Users manage their own agent versions"
  ON public.agent_versions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent
  ON public.agent_versions(agent_id, created_at DESC);
