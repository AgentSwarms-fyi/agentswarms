-- Custom component authoring: reusable, user-authored transform nodes.
--
-- A component is a named snippet of sandboxed JavaScript with a DECLARED
-- parameter schema. It appears in the canvas node palette; dropping one
-- creates a `function` node bound to it, so the existing Worker sandbox
-- (src/lib/sandbox/jsSandbox.ts) executes it — no new execution path, and no
-- new place for user code to run.
--
-- Reproducibility over live-linking, on purpose: a node stores a SNAPSHOT of
-- the component's code and params alongside the component id. A swarm that
-- ran last week still runs the code it ran with, and an exported/shared swarm
-- carries everything it needs. The inspector surfaces "the library has a newer
-- version" and updating is an explicit act — the same posture as the
-- widget-snapshot and swarm-version machinery elsewhere in the app.
--
-- SECURITY: custom code stays canvas-only. The headless executor refuses
-- `function` nodes ("arbitrary code isn't executed on the server"), and
-- binding a component to one does not change that — the deploy dialog's
-- pre-flight already flags such nodes before anyone deploys.

CREATE TABLE public.swarm_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '',
  -- Palette grouping. Free text so the library can grow without a migration.
  category text NOT NULL DEFAULT 'Custom',
  -- [{ name, label, type: "text"|"number"|"boolean"|"select", options?,
  --    default?, required? }] — rendered as the node's parameter form and
  --  passed to the snippet as ctx.params.
  params jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The snippet body. Same contract as the function node: it receives
  -- { input, vars, params } and returns a value.
  code text NOT NULL DEFAULT 'return ctx.input;',
  -- Bumped on every save; a node's snapshot records the version it copied so
  -- the inspector can say "newer version available" without diffing code.
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX idx_swarm_components_user ON public.swarm_components(user_id, updated_at DESC);

ALTER TABLE public.swarm_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own swarm components" ON public.swarm_components
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Keep updated_at honest (the same trigger function the rest of the schema uses).
CREATE TRIGGER trg_swarm_components_updated_at
  BEFORE UPDATE ON public.swarm_components
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
