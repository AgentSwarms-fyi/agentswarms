-- Slack as an agent channel.
--
-- Slack could reach exactly one thing: the AI Analyst named on the workspace
-- row. A workspace with a support agent and a data analyst had to pick one,
-- and an agent could not be asked anything from Slack at all.
--
-- Two additions. A workspace now routes PER SLASH COMMAND, so /ask can stay
-- the analyst while /support is an agent; a command with no route still falls
-- back to analyst_id, which is what every existing installation has, so
-- nothing changes for them until they add a route. And a workspace can name
-- one target for @mentions and direct messages, which is how people actually
-- talk to a bot once it is in the room.

CREATE TABLE IF NOT EXISTS public.slack_command_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.slack_workspaces(id) ON DELETE CASCADE,
  -- The slash command as Slack sends it, normalised to lowercase with one
  -- leading slash: "/ask". Stored that way so the lookup is an equality.
  command text NOT NULL CHECK (command ~ '^/[a-z0-9][a-z0-9_-]{0,31}$'),
  target_type text NOT NULL CHECK (target_type IN ('agent', 'analyst')),
  -- No foreign key: the target is in one of two tables. The server checks
  -- ownership when the route is saved and again when it answers, so a deleted
  -- agent is a refusal in words rather than a dangling join.
  target_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One answer per command per workspace: two rows would make "who answers
  -- /ask?" ambiguous and the endpoint would silently pick one.
  UNIQUE (workspace_id, command)
);
CREATE INDEX IF NOT EXISTS slack_command_routes_user_idx
  ON public.slack_command_routes (user_id, created_at DESC);

ALTER TABLE public.slack_command_routes ENABLE ROW LEVEL SECURITY;

-- Owner-only. The inbound endpoints read with the service role because the
-- request arrives with no AgentSwarms session — it proves itself with the
-- signature instead, exactly as the slash-command endpoint already does.
CREATE POLICY "Users manage own slack command routes"
  ON public.slack_command_routes FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_slack_command_routes_updated_at
  BEFORE UPDATE ON public.slack_command_routes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Where a command points is configuration; the clock is not.
DROP TRIGGER IF EXISTS audit_slack_command_routes ON public.slack_command_routes;
CREATE TRIGGER audit_slack_command_routes
  AFTER INSERT OR DELETE OR UPDATE OF command, target_type, target_id, is_active
  ON public.slack_command_routes
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('slack_command_route');

-- Who answers an @mention or a direct message. NULL means the Events API is
-- configured but nothing is listening, and the endpoint says so rather than
-- silently ignoring the person.
ALTER TABLE public.slack_workspaces
  ADD COLUMN IF NOT EXISTS mention_target_type text
    CHECK (mention_target_type IS NULL OR mention_target_type IN ('agent', 'analyst')),
  ADD COLUMN IF NOT EXISTS mention_target_id uuid,
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

COMMENT ON COLUMN public.slack_workspaces.mention_target_type IS
  'Who answers @mentions and DMs: an agent, an analyst, or nobody when NULL.';
COMMENT ON COLUMN public.slack_workspaces.last_event_at IS
  'Set by the Events endpoint. Proves Slack can reach this deployment, which a saved row does not.';

-- The mention target is configuration, like the analyst already on this row.
DROP TRIGGER IF EXISTS audit_slack_workspaces ON public.slack_workspaces;
CREATE TRIGGER audit_slack_workspaces
  AFTER INSERT OR DELETE OR UPDATE OF
    team_id, team_name, analyst_id, mention_target_type, mention_target_id, is_active
  ON public.slack_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('slack_workspace');
