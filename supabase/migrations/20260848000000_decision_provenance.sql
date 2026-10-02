-- Decision provenance: one correlation key across everything a single answer
-- touched.
--
-- WHY. The platform already records the pieces of an answer's lineage -- the
-- model call (execution_traces), the data it read (audit_events: warehouse.query,
-- dataset.query, data.objectstore_query), the approvals (swarm checkpoints), the
-- cost (budgets) -- but nothing ties them together. Ask "where did this number
-- come from?" and the rows exist, scattered, with no key in common. This adds
-- the key.
--
-- A "decision" is the top-level thing a person asks about: one chat turn, one
-- swarm run, one dashboard refresh. Its id is reused as the correlation key on
-- every trace and audit row written while it was underway, and the row itself
-- records the one fact that cannot be reconstructed later: which lakehouse
-- snapshot was current when it began. DuckLake can re-run a query AT a
-- snapshot, so that single integer is what makes an answer reproducible rather
-- than merely recorded.

CREATE TABLE IF NOT EXISTS public.decisions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('chat_turn', 'swarm_run', 'dashboard_refresh')),
  -- What the id refers to in its own domain: the trace id, the swarm run id,
  -- the dashboard id. Kept as text because the domains disagree on type.
  root_ref text,
  -- max(snapshot_id) from lake.snapshots() at the moment the decision began;
  -- NULL when the lakehouse is not configured or could not be read. A NULL here
  -- means "recorded, not reproducible" and the passport must say so.
  lakehouse_snapshot_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_user_created_idx ON public.decisions (user_id, created_at DESC);

ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
-- Owners read their own. Writes come from the service role: a decision row is
-- minted by the server at the start of a turn, never by a browser.
CREATE POLICY "decisions_owner_read" ON public.decisions
  FOR SELECT USING (auth.uid() = user_id);

-- The correlation key on the two tables that already hold the evidence. Both
-- nullable: rows written outside a decision (an IAM change, a secret rotation)
-- have nothing to correlate to, and that is correct rather than missing.
ALTER TABLE public.audit_events ADD COLUMN IF NOT EXISTS decision_id uuid;
CREATE INDEX IF NOT EXISTS audit_events_decision_idx
  ON public.audit_events (decision_id) WHERE decision_id IS NOT NULL;

ALTER TABLE public.execution_traces ADD COLUMN IF NOT EXISTS decision_id uuid;
CREATE INDEX IF NOT EXISTS execution_traces_decision_idx
  ON public.execution_traces (decision_id) WHERE decision_id IS NOT NULL;
