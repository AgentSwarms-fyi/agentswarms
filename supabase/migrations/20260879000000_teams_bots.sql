-- Inbound Microsoft Teams: a bot registration that may ask an agent or the
-- analyst a question.
--
-- The mirror of `slack_workspaces`, and deliberately a SEPARATE table rather
-- than a `channel` column on that one. The two integrations authenticate
-- nothing alike: Slack signs each request with a shared secret we store, while
-- Bot Framework sends a token Microsoft signed with a rotating key we fetch —
-- so the columns that matter (`signing_secret_enc` against `app_password_enc`,
-- `team_id` against `app_id`) have no overlap. Folding them together would
-- give every row half a set of meaningless columns and let a bug in one
-- channel's lookup reach the other's rows.
--
-- ONE ROW PER BOT REGISTRATION (app_id), owned by the AgentSwarms user who
-- installed it. app_id is how an inbound activity finds its owner: the request
-- carries no AgentSwarms identity, only a token whose `aud` is this app id.

CREATE TABLE IF NOT EXISTS public.teams_bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The bot's Microsoft App (client) id. The join key for every inbound
  -- activity, and the audience its token must carry.
  app_id text NOT NULL,
  display_name text,
  -- The Entra tenant this bot serves, when it is single-tenant. Null for a
  -- multi-tenant registration.
  tenant_id text,
  -- AES-GCM {ciphertext, iv}, the same envelope as every other stored
  -- credential. Needed only to mint the OUTBOUND token that posts the answer
  -- back; inbound requests are verified against Microsoft's published keys and
  -- need no secret of ours at all.
  app_password_enc jsonb,
  -- Who answers. An agent or an analyst, exactly as a Slack mention target —
  -- the shared runner takes it from here.
  target_type text CHECK (target_type IN ('agent', 'analyst')),
  target_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  last_activity_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One installation per bot: two rows would make "whose agent answers this?"
  -- ambiguous, and the endpoint would silently pick one.
  UNIQUE (app_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_bots_user ON public.teams_bots(user_id);

ALTER TABLE public.teams_bots ENABLE ROW LEVEL SECURITY;

-- Owner-only. The inbound endpoint reads with the service role because the
-- request arrives with no AgentSwarms session — it proves itself with a
-- Microsoft-signed token instead.
CREATE POLICY "Users manage own teams bots"
  ON public.teams_bots FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_teams_bots_updated_at
  BEFORE UPDATE ON public.teams_bots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Registering a bot is configuration a person will be asked about later:
-- which agent answers in Teams, and who pointed it there.
DROP TRIGGER IF EXISTS audit_teams_bots ON public.teams_bots;
CREATE TRIGGER audit_teams_bots
  AFTER INSERT OR DELETE OR UPDATE OF app_id, tenant_id, target_type, target_id, is_active
  ON public.teams_bots
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('teams_bot');
