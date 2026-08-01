-- Audit the writes that never reached the trail.
--
-- 52 write operations run straight from the BROWSER to Postgres under RLS —
-- dashboards, workspaces, datasets, prep flows, catalog assets, semantic
-- models. They are safe (RLS enforces them) but invisible: "who deleted that
-- dashboard?" had no answer. The hash chain added in 20260762000000 proves the
-- trail was not altered, which is worth much less when events never arrived.
--
-- Done with TRIGGERS rather than by adding auditEvent() calls to client code,
-- for the reason that decides it: a trigger cannot be bypassed. A client-side
-- call can be forgotten by the next contributor, skipped by a direct API call,
-- or simply not made by a malicious caller — and the events you most want are
-- exactly the ones an attacker would omit. This also covers writes from psql,
-- server functions and future code paths for free.
--
-- Follows the pattern already established for embed_keys in 20260735000000.

-- One function for every table. `to_jsonb(row)` lets it read id/user_id/name
-- generically, so there is one implementation to keep correct rather than six
-- near-identical copies that drift.
--
-- TG_ARGV[0] is the resource_type, and the action becomes
-- "<resource_type>.<create|update|delete>", matching the existing taxonomy
-- (dashboard.view, secret.create, mcp_app.delete...).
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row    jsonb;
  _actor  uuid;
  _verb   text;
  _rtype  text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'DELETE' THEN
    _row := to_jsonb(OLD); _verb := 'delete';
  ELSIF TG_OP = 'INSERT' THEN
    _row := to_jsonb(NEW); _verb := 'create';
  ELSE
    _row := to_jsonb(NEW); _verb := 'update';
  END IF;

  -- auth.uid() is the acting user for a browser write. A service-role write
  -- has no JWT subject, so fall back to the row's owner: attributing a
  -- scheduled refresh to the dashboard's owner is far better than dropping the
  -- event, and the detail below records which path it came from.
  _actor := COALESCE(auth.uid(), NULLIF(_row->>'user_id', '')::uuid);
  IF _actor IS NULL THEN
    RETURN NULL;
  END IF;

  -- Audit failure must NEVER break the user's write. An audit trail that can
  -- take the product down is one an operator eventually disables.
  BEGIN
    INSERT INTO public.audit_events (
      user_id, action, resource_type, resource_name, resource_id, detail
    )
    VALUES (
      _actor,
      _rtype || '.' || _verb,
      _rtype,
      left(COALESCE(_row->>'name', ''), 200),
      NULLIF(_row->>'id', '')::uuid,
      jsonb_build_object(
        'op', TG_OP,
        -- Distinguishes a person acting in the app from a server-side job, so
        -- the fallback above is never mistaken for a user action.
        'actor', CASE WHEN auth.uid() IS NULL THEN 'service' ELSE 'user' END
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_row_change() FROM public, anon, authenticated;

-- ── Triggers ────────────────────────────────────────────────────────────────
--
-- INSERT and DELETE are always audited: creation and destruction are the
-- events a review actually asks about.
--
-- UPDATE is audited only when a GOVERNANCE-relevant column changes — a name, a
-- publish flag, an owner, a move between workspaces. Auditing every content
-- save instead would bury those under autosave noise and, because the hash
-- chain serialises audit inserts behind an advisory lock, would add contention
-- to the app's hottest write path. Content history already lives in the
-- per-resource version tables.

-- Dashboards: renames, publishing, and moves between workspaces/folders.
DROP TRIGGER IF EXISTS trg_audit_bi_dashboards_ins ON public.bi_dashboards;
CREATE TRIGGER trg_audit_bi_dashboards_ins
  AFTER INSERT OR DELETE ON public.bi_dashboards
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('dashboard');

DROP TRIGGER IF EXISTS trg_audit_bi_dashboards_upd ON public.bi_dashboards;
CREATE TRIGGER trg_audit_bi_dashboards_upd
  AFTER UPDATE ON public.bi_dashboards
  FOR EACH ROW
  WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.published IS DISTINCT FROM NEW.published
    OR OLD.public_slug IS DISTINCT FROM NEW.public_slug
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.folder_id IS DISTINCT FROM NEW.folder_id
  )
  EXECUTE FUNCTION public.audit_row_change('dashboard');

-- Datasets: the resource most likely to hold customer data.
DROP TRIGGER IF EXISTS trg_audit_user_data_tables_ins ON public.user_data_tables;
CREATE TRIGGER trg_audit_user_data_tables_ins
  AFTER INSERT OR DELETE ON public.user_data_tables
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('dataset');

DROP TRIGGER IF EXISTS trg_audit_user_data_tables_upd ON public.user_data_tables;
CREATE TRIGGER trg_audit_user_data_tables_upd
  AFTER UPDATE ON public.user_data_tables
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.audit_row_change('dataset');

-- Semantic models: governed metric definitions. A silent change here alters
-- every number the business reports.
DROP TRIGGER IF EXISTS trg_audit_semantic_models ON public.semantic_models;
CREATE TRIGGER trg_audit_semantic_models
  AFTER INSERT OR UPDATE OR DELETE ON public.semantic_models
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('semantic_model');

-- Workspaces and folders: where dashboards live and who can reach them.
DROP TRIGGER IF EXISTS trg_audit_bi_workspaces ON public.bi_workspaces;
CREATE TRIGGER trg_audit_bi_workspaces
  AFTER INSERT OR UPDATE OR DELETE ON public.bi_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('bi_workspace');

DROP TRIGGER IF EXISTS trg_audit_bi_folders ON public.bi_folders;
CREATE TRIGGER trg_audit_bi_folders
  AFTER INSERT OR DELETE ON public.bi_folders
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('bi_folder');

-- Prep flows: they rewrite datasets, so a change here changes data downstream.
DROP TRIGGER IF EXISTS trg_audit_user_prep_flows ON public.user_prep_flows;
CREATE TRIGGER trg_audit_user_prep_flows
  AFTER INSERT OR DELETE ON public.user_prep_flows
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('prep_flow');

DROP TRIGGER IF EXISTS trg_audit_user_prep_flows_upd ON public.user_prep_flows;
CREATE TRIGGER trg_audit_user_prep_flows_upd
  AFTER UPDATE ON public.user_prep_flows
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.audit_row_change('prep_flow');

-- Catalog sources: connection definitions pointing at real systems.
DROP TRIGGER IF EXISTS trg_audit_catalog_sources ON public.catalog_sources;
CREATE TRIGGER trg_audit_catalog_sources
  AFTER INSERT OR UPDATE OR DELETE ON public.catalog_sources
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('catalog_source');

-- Data quality tests: the definition of "is this data trustworthy". Editing a
-- test to make a red dataset look green is precisely a thing to record.
DROP TRIGGER IF EXISTS trg_audit_data_quality_tests ON public.data_quality_tests;
CREATE TRIGGER trg_audit_data_quality_tests
  AFTER INSERT OR UPDATE OR DELETE ON public.data_quality_tests
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('data_quality_test');
