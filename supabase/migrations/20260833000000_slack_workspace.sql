-- Inbound Slack: a workspace that may ask the AI Analyst a question.
--
-- Distinct from the OUTBOUND notification webhook already in `integrations`.
-- That one is a URL we post to; this one is a caller we have to authenticate,
-- which is a different trust problem entirely: the endpoint is public because
-- Slack has to reach it, so the signing secret is the only thing standing
-- between a slash command and anyone who learns the URL.
--
-- ONE ROW PER SLACK WORKSPACE (team_id), owned by the AgentSwarms user who
-- installed it. team_id is how an inbound request finds its owner — the
-- request carries no AgentSwarms identity of its own.

CREATE TABLE IF NOT EXISTS public.slack_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Slack's workspace id (T…). The join key for every inbound request.
  team_id text NOT NULL,
  team_name text,
  -- AES-GCM {ciphertext, iv}, same envelope as every other stored credential.
  -- The signing secret verifies inbound requests; the bot token is only needed
  -- for posting outside a response_url (threads, channels).
  signing_secret_enc jsonb,
  bot_token_enc jsonb,
  -- Which analyst answers. NULL means the integration is configured but has
  -- nothing to ask, and the endpoint says exactly that rather than failing
  -- with something generic.
  analyst_id uuid REFERENCES public.ai_analysts(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_command_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One installation per workspace: two rows would make "whose analyst answers
  -- this?" ambiguous, and the endpoint would silently pick one.
  UNIQUE (team_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_workspaces_user ON public.slack_workspaces(user_id);

ALTER TABLE public.slack_workspaces ENABLE ROW LEVEL SECURITY;

-- Owner-only. The inbound endpoint reads with the service role because the
-- request arrives with no AgentSwarms session — it proves itself with the
-- signature instead.
CREATE POLICY "Users manage own slack workspaces"
  ON public.slack_workspaces FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_slack_workspaces_updated_at
  BEFORE UPDATE ON public.slack_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
