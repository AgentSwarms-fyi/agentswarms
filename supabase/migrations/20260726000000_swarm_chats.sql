-- Conversational Chat Swarm: run a saved swarm as a multi-turn conversation.
--
-- Each row is one conversation with a swarm. `messages` holds the full
-- transcript ([{role, content, ts}]) shown in the panel AND replayed into the
-- swarm's agent nodes each turn; `state` holds the flow-state variables carried
-- from the previous turn so a chat swarm can accumulate structured state.
CREATE TABLE public.swarm_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  swarm_id uuid NOT NULL REFERENCES public.swarms(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New chat',
  messages jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ role, content, ts }]
  state jsonb NOT NULL DEFAULT '{}'::jsonb,     -- carried flow-state variables
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.swarm_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own swarm chats" ON public.swarm_chats
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_swarm_chats_user_swarm
  ON public.swarm_chats(user_id, swarm_id, updated_at DESC);
CREATE TRIGGER update_swarm_chats_updated_at
  BEFORE UPDATE ON public.swarm_chats
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
