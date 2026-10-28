-- Enterprise Ontology, under Data & BI.
--
-- An ontology is the business described in its own words — object types,
-- properties, links, metrics, rules and actions — with every object type
-- bound to a lakehouse table. The model is ONE document (spec jsonb, shape in
-- src/lib/ontology/spec.ts), so it versions, diffs, exports to Apache Ossie
-- and is reviewed as a unit. Rows of data are never copied here: object sets,
-- metrics and rule checks are compiled to SQL and run through the governed
-- lakehouse path as the person asking.
--
-- Who may do what (enforced in the server functions, mirrored by RLS for any
-- direct read):
--   - the OWNER edits the draft, publishes versions, runs rules, decides
--     proposals and approves actions;
--   - a GRANTEE (an IAM grant of type 'ontology') reads the published model,
--     explores objects, asks questions, proposes changes and requests actions.

CREATE TABLE IF NOT EXISTS public.ontologies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 8000),
  -- The working draft.
  spec jsonb NOT NULL,
  -- Bumped on every save; a save names the revision it read, so two editors
  -- (or two tabs) cannot silently undo each other.
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- The newest published version, NULL until the first publish. Grantees
  -- read that version, not the draft.
  published_version integer CHECK (published_version IS NULL OR published_version >= 1),
  -- The last rule run and validation, summarised for the gallery card.
  health jsonb,
  -- Set when the ontology was created from the sample: the lakehouse schema
  -- its tables live in, so deleting the sample can offer to drop them too.
  sample_schema text CHECK (sample_schema IS NULL OR sample_schema ~ '^[a-z][a-z0-9_]{0,62}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ontologies_user_idx ON public.ontologies (user_id, updated_at DESC);

-- A published version is a snapshot: written once, never changed.
CREATE TABLE IF NOT EXISTS public.ontology_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id uuid NOT NULL REFERENCES public.ontologies(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  spec jsonb NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 4000),
  -- What changed against the version before, as computed at publish
  -- (src/lib/ontology/diff.ts): counts and the breaking changes.
  diff jsonb,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ontology_id, version)
);

-- A change someone proposes, reviewed by the owner before it reaches the draft.
CREATE TABLE IF NOT EXISTS public.ontology_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id uuid NOT NULL REFERENCES public.ontologies(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  note text CHECK (note IS NULL OR length(note) <= 4000),
  -- The draft revision the proposal was made against; merging a proposal
  -- whose base is stale is refused rather than overwriting newer work.
  base_revision integer NOT NULL,
  spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'merged', 'rejected', 'withdrawn')),
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS ontology_proposals_idx
  ON public.ontology_proposals (ontology_id, status, created_at DESC);

-- One run of an ontology's rules against the data.
CREATE TABLE IF NOT EXISTS public.ontology_rule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id uuid NOT NULL REFERENCES public.ontologies(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revision integer NOT NULL,
  -- Per rule: id, checked, violations, a few offending keys, or an error.
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules_run integer NOT NULL DEFAULT 0,
  passed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  errored integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS ontology_rule_runs_idx
  ON public.ontology_rule_runs (ontology_id, started_at DESC);

-- Every action requested on an object: proposed, applied, rejected or failed.
-- This is the edit log: what changed, from what to what, who asked, who
-- approved, and whether a person or an agent asked.
CREATE TABLE IF NOT EXISTS public.ontology_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id uuid NOT NULL REFERENCES public.ontologies(id) ON DELETE CASCADE,
  action_name text NOT NULL CHECK (action_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  object_type text NOT NULL CHECK (object_type ~ '^[A-Z][A-Za-z0-9]{0,63}$'),
  object_key jsonb,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  before jsonb,
  after jsonb,
  status text NOT NULL CHECK (status IN ('proposed', 'applied', 'rejected', 'failed')),
  via text NOT NULL DEFAULT 'ui' CHECK (via IN ('ui', 'agent', 'api')),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  error text CHECK (error IS NULL OR length(error) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS ontology_actions_idx
  ON public.ontology_actions (ontology_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ontology_actions_pending_idx
  ON public.ontology_actions (ontology_id) WHERE status = 'proposed';

-- Verified questions: a question, the ontology query that answers it, and
-- what it returned when someone checked it. Re-run as an evaluation suite.
CREATE TABLE IF NOT EXISTS public.ontology_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id uuid NOT NULL REFERENCES public.ontologies(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 1000),
  query jsonb NOT NULL,
  expected jsonb,
  verified_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ontology_questions_idx
  ON public.ontology_questions (ontology_id, created_at DESC);

-- ── Row level security ──────────────────────────────────────────────────────
-- The server functions use the service role after checking access in code;
-- these policies make a direct read through the anon key equally strict.

ALTER TABLE public.ontologies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ontology_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ontology_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ontology_rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ontology_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ontology_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners manage their ontologies" ON public.ontologies;
CREATE POLICY "Owners manage their ontologies" ON public.ontologies FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Shared ontologies are readable" ON public.ontologies;
CREATE POLICY "Shared ontologies are readable" ON public.ontologies FOR SELECT
  USING (public.has_resource_access('ontology', id, auth.uid()));

-- Versions: read by owner and grantees; written only by the server. No
-- UPDATE or DELETE policy, so a published snapshot cannot be edited.
DROP POLICY IF EXISTS "Ontology versions are readable" ON public.ontology_versions;
CREATE POLICY "Ontology versions are readable" ON public.ontology_versions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.ontologies o WHERE o.id = ontology_id AND o.user_id = auth.uid())
    OR public.has_resource_access('ontology', ontology_id, auth.uid())
  );

DROP POLICY IF EXISTS "Ontology proposals are readable" ON public.ontology_proposals;
CREATE POLICY "Ontology proposals are readable" ON public.ontology_proposals FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.ontologies o WHERE o.id = ontology_id AND o.user_id = auth.uid())
    OR public.has_resource_access('ontology', ontology_id, auth.uid())
  );

DROP POLICY IF EXISTS "Ontology rule runs are readable" ON public.ontology_rule_runs;
CREATE POLICY "Ontology rule runs are readable" ON public.ontology_rule_runs FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.ontologies o WHERE o.id = ontology_id AND o.user_id = auth.uid())
    OR public.has_resource_access('ontology', ontology_id, auth.uid())
  );

DROP POLICY IF EXISTS "Ontology actions are readable" ON public.ontology_actions;
CREATE POLICY "Ontology actions are readable" ON public.ontology_actions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.ontologies o WHERE o.id = ontology_id AND o.user_id = auth.uid())
    OR requested_by = auth.uid()
  );

DROP POLICY IF EXISTS "Ontology questions are readable" ON public.ontology_questions;
CREATE POLICY "Ontology questions are readable" ON public.ontology_questions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.ontologies o WHERE o.id = ontology_id AND o.user_id = auth.uid())
    OR public.has_resource_access('ontology', ontology_id, auth.uid())
  );

-- ── Timestamps and audit ────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS ontologies_updated_at ON public.ontologies;
CREATE TRIGGER ontologies_updated_at
  BEFORE UPDATE ON public.ontologies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS ontology_questions_updated_at ON public.ontology_questions;
CREATE TRIGGER ontology_questions_updated_at
  BEFORE UPDATE ON public.ontology_questions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A draft save is not governance (it happens on every edit); creating,
-- renaming, publishing and deleting are. Versions, proposals, rule runs and
-- actions are written by the server, which audits each with its detail (the
-- trigger would have no actor for them: they carry no user_id).
DROP TRIGGER IF EXISTS audit_ontologies ON public.ontologies;
CREATE TRIGGER audit_ontologies
  AFTER INSERT OR DELETE OR UPDATE OF name, description, published_version
  ON public.ontologies
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('ontology');

-- ── Sharing ─────────────────────────────────────────────────────────────────
-- The CHECK is REPLACED, not extended, so this list must be the full current
-- set — every type any earlier migration added, plus the new one.
-- tests/unit/iamGrantTypes.test.ts compares this against the app's own list.
ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT IF EXISTS iam_resource_grants_resource_type_check;

ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (
    resource_type IN (
      'knowledge_base',
      'data_table',
      'secret',
      'bi_dashboard',
      'semantic_model',
      'catalog_source',
      'integration',
      'provider_credential',
      'warehouse_connection',
      'saas_connection',
      'ai_analyst',
      'lakehouse_schema',
      'ml_model',
      -- New: an ontology. Sharing conveys reading its published model,
      -- exploring its objects as the grantee, so their own lakehouse access
      -- and policies still apply, asking it questions, proposing changes and
      -- requesting actions. Editing, publishing and approving stay with the
      -- owner. No parentheses in here: tests read this list up to its first
      -- closing one.
      'ontology'
    )
  );

-- ── Instance limits; NULL = env (ONTOLOGY_MAX_ROWS, ONTOLOGY_MAX_SPEC_KB) ──
ALTER TABLE public.notebook_runtime_settings
  ADD COLUMN IF NOT EXISTS ontology_max_rows integer CHECK (ontology_max_rows IS NULL OR ontology_max_rows > 0),
  ADD COLUMN IF NOT EXISTS ontology_max_spec_kb integer CHECK (ontology_max_spec_kb IS NULL OR ontology_max_spec_kb > 0);
COMMENT ON COLUMN public.notebook_runtime_settings.ontology_max_rows IS
  'Most rows one ontology query returns; NULL = env ONTOLOGY_MAX_ROWS, then 5000.';
COMMENT ON COLUMN public.notebook_runtime_settings.ontology_max_spec_kb IS
  'Largest ontology document saved, in KB; NULL = env ONTOLOGY_MAX_SPEC_KB, then 4096.';
