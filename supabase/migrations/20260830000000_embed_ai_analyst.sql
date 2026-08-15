-- Embed an AI Analyst: the conversational chat surface, on someone else's
-- site, answering questions typed by anonymous visitors.
--
-- WHAT THIS IS, next to the dashboard embed. A dashboard embed serves stored
-- snapshots: a fixed set of numbers the owner already computed and looked at.
-- An analyst embed accepts a QUESTION and runs the full reasoning loop —
-- plan, generate SQL, execute, self-check, synthesise — against the analyst's
-- data scope. It is the more powerful surface and the more exposed one, and
-- the difference is worth being explicit about rather than discovering.
--
-- WHAT BOUNDS IT:
--   • The analyst's own `source` is the boundary. An analyst scoped to two
--     datasets can only ever read those two; one pointed at a warehouse
--     connection can only read that connection. Scoping the analyst IS the
--     access control, which is why the embed dialog says so before you copy
--     the snippet.
--   • It runs as the OWNER (like every other embed), so the owner's IAM model
--     rules and semantic row filters / column masks still apply.
--   • Per-key budget cap, rate limit, domain allow-list, expiry and instant
--     deactivation are inherited unchanged from embed_keys.
--
-- NOT signed viewers. Those turn a token's attributes into row filters over
-- STORED results (see 20260829000000). An analyst writes fresh SQL for every
-- question, so a filter could only be enforced on the governed steps and not
-- on the raw-SQL ones — enforcement on part of an answer is a badge that
-- vouches for less than it appears to. The CHECK below therefore continues to
-- restrict require_signed_viewer to dashboards.

ALTER TABLE public.embed_keys DROP CONSTRAINT IF EXISTS embed_keys_resource_type_check;

ALTER TABLE public.embed_keys
  ADD CONSTRAINT embed_keys_resource_type_check
  CHECK (resource_type IN ('agent', 'swarm', 'bi_dashboard', 'ai_analyst'));

COMMENT ON COLUMN public.embed_keys.resource_type IS
  'agent | swarm | bi_dashboard | ai_analyst. An ai_analyst embed answers free-form questions server-side as the owner, bounded by the analyst''s configured data source.';
