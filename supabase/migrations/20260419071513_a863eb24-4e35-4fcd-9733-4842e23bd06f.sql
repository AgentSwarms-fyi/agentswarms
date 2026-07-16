-- Community Agents: publicly browsable copies of agent configs (no secrets).
CREATE TABLE public.community_agents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  author_id UUID NOT NULL,
  author_name TEXT,
  source_agent_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  -- Public, secret-free manifest. Includes system_prompt, model, temperature,
  -- max_tokens, tool ids (built-in tool IDs only, no API keys), guardrails,
  -- and a knowledge_base_hint (name only, not contents).
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  knowledge_base_hint TEXT,
  likes_count INTEGER NOT NULL DEFAULT 0,
  remix_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  is_hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_community_agents_recent ON public.community_agents (created_at DESC) WHERE is_hidden = false;
CREATE INDEX idx_community_agents_popular ON public.community_agents (likes_count DESC) WHERE is_hidden = false;
CREATE INDEX idx_community_agents_category ON public.community_agents (category) WHERE is_hidden = false;

ALTER TABLE public.community_agents ENABLE ROW LEVEL SECURITY;

-- Anyone (including anonymous) can read non-hidden community agents
CREATE POLICY "Public can view non-hidden community agents"
ON public.community_agents FOR SELECT
USING (is_hidden = false OR auth.uid() = author_id);

-- Only authenticated users can publish, and only as themselves
CREATE POLICY "Users can publish their own community agents"
ON public.community_agents FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = author_id);

-- Author can update their own (e.g. edit description, hide it)
CREATE POLICY "Authors can update their own community agents"
ON public.community_agents FOR UPDATE
TO authenticated
USING (auth.uid() = author_id);

-- Author can delete their own
CREATE POLICY "Authors can delete their own community agents"
ON public.community_agents FOR DELETE
TO authenticated
USING (auth.uid() = author_id);

-- Community Swarms: same idea for swarm graphs
CREATE TABLE public.community_swarms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  author_id UUID NOT NULL,
  author_name TEXT,
  source_swarm_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  -- Portable swarm format: nodes/edges with no credentials
  nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
  edges JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge_base_hint TEXT,
  likes_count INTEGER NOT NULL DEFAULT 0,
  remix_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  is_hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_community_swarms_recent ON public.community_swarms (created_at DESC) WHERE is_hidden = false;
CREATE INDEX idx_community_swarms_popular ON public.community_swarms (likes_count DESC) WHERE is_hidden = false;
CREATE INDEX idx_community_swarms_category ON public.community_swarms (category) WHERE is_hidden = false;

ALTER TABLE public.community_swarms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can view non-hidden community swarms"
ON public.community_swarms FOR SELECT
USING (is_hidden = false OR auth.uid() = author_id);

CREATE POLICY "Users can publish their own community swarms"
ON public.community_swarms FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = author_id);

CREATE POLICY "Authors can update their own community swarms"
ON public.community_swarms FOR UPDATE
TO authenticated
USING (auth.uid() = author_id);

CREATE POLICY "Authors can delete their own community swarms"
ON public.community_swarms FOR DELETE
TO authenticated
USING (auth.uid() = author_id);

-- Likes: one row per user per item
CREATE TABLE public.community_likes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('agent','swarm')),
  item_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, item_kind, item_id)
);

CREATE INDEX idx_community_likes_item ON public.community_likes (item_kind, item_id);

ALTER TABLE public.community_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can see likes"
ON public.community_likes FOR SELECT USING (true);

CREATE POLICY "Users can like as themselves"
ON public.community_likes FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can unlike their own likes"
ON public.community_likes FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- Reports: anyone authed can flag content for review
CREATE TABLE public.community_reports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reporter_id UUID NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('agent','swarm')),
  item_id UUID NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(reporter_id, item_kind, item_id)
);

ALTER TABLE public.community_reports ENABLE ROW LEVEL SECURITY;

-- Reporter can see their own reports; nobody else can see them (privacy).
CREATE POLICY "Reporters see their own reports"
ON public.community_reports FOR SELECT
TO authenticated
USING (auth.uid() = reporter_id);

CREATE POLICY "Authed users can report"
ON public.community_reports FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = reporter_id);

-- Triggers to maintain counters

CREATE OR REPLACE FUNCTION public.update_community_likes_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.item_kind = 'agent' THEN
      UPDATE public.community_agents SET likes_count = likes_count + 1 WHERE id = NEW.item_id;
    ELSE
      UPDATE public.community_swarms SET likes_count = likes_count + 1 WHERE id = NEW.item_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.item_kind = 'agent' THEN
      UPDATE public.community_agents SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = OLD.item_id;
    ELSE
      UPDATE public.community_swarms SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = OLD.item_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_community_likes_count
AFTER INSERT OR DELETE ON public.community_likes
FOR EACH ROW EXECUTE FUNCTION public.update_community_likes_count();

CREATE OR REPLACE FUNCTION public.update_community_reports_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.item_kind = 'agent' THEN
    UPDATE public.community_agents
      SET report_count = report_count + 1,
          is_hidden = CASE WHEN report_count + 1 >= 5 THEN true ELSE is_hidden END
      WHERE id = NEW.item_id;
  ELSE
    UPDATE public.community_swarms
      SET report_count = report_count + 1,
          is_hidden = CASE WHEN report_count + 1 >= 5 THEN true ELSE is_hidden END
      WHERE id = NEW.item_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_community_reports_count
AFTER INSERT ON public.community_reports
FOR EACH ROW EXECUTE FUNCTION public.update_community_reports_count();

-- Atomic remix count bump (called from app on successful clone)
CREATE OR REPLACE FUNCTION public.bump_community_remix_count(_kind TEXT, _id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _kind = 'agent' THEN
    UPDATE public.community_agents SET remix_count = remix_count + 1 WHERE id = _id;
  ELSE
    UPDATE public.community_swarms SET remix_count = remix_count + 1 WHERE id = _id;
  END IF;
END;
$$;

-- updated_at triggers
CREATE TRIGGER trg_community_agents_updated_at
BEFORE UPDATE ON public.community_agents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_community_swarms_updated_at
BEFORE UPDATE ON public.community_swarms
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();