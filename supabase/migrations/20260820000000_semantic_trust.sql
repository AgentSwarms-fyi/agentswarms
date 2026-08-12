-- Semantic model trust: certification + version history.
--
-- CERTIFICATION. status ∈ draft/certified/deprecated (same vocabulary as
-- catalog assets). "Certified" is a measured claim, not a mood: the server fn
-- that sets it re-runs the full validation pipeline (field probes, join
-- measurement, grain uniqueness, assertions) and refuses on any issue, then
-- stamps who certified and when. The trigger below is the other half of that
-- promise: EDITING a certified model's definition drops it back to draft,
-- because the certificate applied to the definition that was validated, not
-- to whatever the row says now. Done in a trigger rather than app code so no
-- future write path — service role, psql, a new server fn — can carry a stale
-- certificate forward.
ALTER TABLE public.semantic_models
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'certified', 'deprecated')),
  ADD COLUMN IF NOT EXISTS certified_by uuid,
  ADD COLUMN IF NOT EXISTS certified_at timestamptz;

CREATE OR REPLACE FUNCTION public.semantic_model_decertify_on_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only a DEFINITION change invalidates a certificate. Status flips and
  -- metadata-only touches (label, description) keep it — renaming a display
  -- label does not change what "revenue" computes.
  IF OLD.status = 'certified' AND NEW.status = 'certified' AND (
       NEW.dimensions   IS DISTINCT FROM OLD.dimensions
    OR NEW.metrics      IS DISTINCT FROM OLD.metrics
    OR NEW.joins        IS DISTINCT FROM OLD.joins
    OR NEW.assertions   IS DISTINCT FROM OLD.assertions
    OR NEW.primary_key  IS DISTINCT FROM OLD.primary_key
    OR NEW.source_kind  IS DISTINCT FROM OLD.source_kind
    OR NEW.source_table IS DISTINCT FROM OLD.source_table
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.name         IS DISTINCT FROM OLD.name
  ) THEN
    NEW.status := 'draft';
    NEW.certified_by := NULL;
    NEW.certified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_semantic_decertify ON public.semantic_models;
CREATE TRIGGER trg_semantic_decertify
  BEFORE UPDATE ON public.semantic_models
  FOR EACH ROW EXECUTE FUNCTION public.semantic_model_decertify_on_edit();

-- VERSION HISTORY. Every UPDATE snapshots the PREVIOUS definition, written by
-- a trigger so no write path can skip it — the same reasoning as the audit
-- triggers (20260772000000): the versions you most need are the ones a
-- careless (or malicious) writer would omit. The audit trail already records
-- THAT a model changed and by whom; this records WHAT it said before, which
-- is the half "revenue changed on the 14th — from what?" actually needs.
CREATE TABLE IF NOT EXISTS public.semantic_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES public.semantic_models(id) ON DELETE CASCADE,
  -- The model OWNER — RLS scopes history to them, wherever the write came from.
  user_id uuid NOT NULL,
  -- auth.uid() when a person made the change; NULL for service-role writes.
  changed_by uuid,
  -- Full previous row as jsonb (definition + metadata + status at that time).
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_semantic_versions_model
  ON public.semantic_model_versions (model_id, created_at DESC);

ALTER TABLE public.semantic_model_versions ENABLE ROW LEVEL SECURITY;

-- Owner reads and prunes their history. No INSERT/UPDATE policy on purpose:
-- rows are written only by the trigger below, and history must not be
-- forgeable or editable from a client.
CREATE POLICY "Owners read their model versions"
  ON public.semantic_model_versions FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "Owners delete their model versions"
  ON public.semantic_model_versions FOR DELETE
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.semantic_model_capture_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Snapshot only when something actually changed; a no-op save must not
  -- spam history.
  IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    BEGIN
      INSERT INTO public.semantic_model_versions (model_id, user_id, changed_by, definition)
      VALUES (OLD.id, OLD.user_id, auth.uid(), to_jsonb(OLD));
      -- Retention: keep the newest 50 per model. Bounded history, no cron.
      DELETE FROM public.semantic_model_versions v
      WHERE v.model_id = OLD.id
        AND v.id NOT IN (
          SELECT v2.id FROM public.semantic_model_versions v2
          WHERE v2.model_id = OLD.id
          ORDER BY v2.created_at DESC, v2.id DESC
          LIMIT 50
        );
    EXCEPTION WHEN OTHERS THEN
      -- History must never break the user's save. The audit trail still has
      -- the THAT-it-changed record even if the WHAT-it-was snapshot failed.
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_semantic_capture_version ON public.semantic_models;
CREATE TRIGGER trg_semantic_capture_version
  AFTER UPDATE ON public.semantic_models
  FOR EACH ROW EXECUTE FUNCTION public.semantic_model_capture_version();

-- Row filters / column masks on semantic_model grants need no schema change —
-- iam_resource_grants already carries both columns (used by bi_dashboard and
-- data_table grants). Enforcement lives in runSemanticQuery, which compiles a
-- grantee's row filter into the governed query itself.
