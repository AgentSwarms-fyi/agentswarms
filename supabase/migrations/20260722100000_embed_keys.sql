-- Web embedding: iframe embeds of agents, swarms and BI dashboards on
-- external sites, authorized by a per-embed secret key with a domain
-- allow-list.
--
-- Model:
--   - The owner creates a key from /dashboard (Web Embedding section). The
--     key ships inside the customer page's <iframe src>, so it is treated
--     as a *capability token*, not a secret credential: it grants access to
--     exactly one resource, only from allowed parent domains, and can be
--     deactivated at any time.
--   - Server-side validation happens in /api/embed (resolve/ask) and
--     /api/embed/chat via the service role; owners manage their keys
--     through plain RLS below.
--   - allowed_domains: hostnames ('example.com'), wildcards
--     ('*.example.com'), or '*' (any site — also permits opening the embed
--     URL directly). Empty array = nothing allowed (key parked).

CREATE TABLE public.embed_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key text NOT NULL UNIQUE CHECK (key LIKE 'emk\_%' ESCAPE '\' AND length(key) BETWEEN 20 AND 80),
  resource_type text NOT NULL CHECK (resource_type IN ('agent', 'swarm', 'bi_dashboard')),
  resource_id uuid NOT NULL,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  -- BI dashboards only: expose the "Ask AI" analyst to embed viewers.
  allow_ai boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.embed_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own embed keys" ON public.embed_keys
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_embed_keys_user ON public.embed_keys(user_id);
CREATE INDEX idx_embed_keys_key ON public.embed_keys(key);

CREATE TRIGGER update_embed_keys_updated_at
BEFORE UPDATE ON public.embed_keys
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
