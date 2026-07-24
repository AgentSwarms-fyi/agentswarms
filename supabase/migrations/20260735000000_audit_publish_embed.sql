-- Audit the two privileged actions the app performs as CLIENT-SIDE RLS writes,
-- which no server-side auditEvent() hook can observe:
--   * publishing / unpublishing a BI dashboard (bi_dashboards.published / public_slug)
--   * creating, revoking, or reconfiguring an embed key (embed_keys)
--
-- These are done with database triggers rather than by routing the writes
-- through server functions, so EVERY path is covered — the app, a future
-- refactor, and direct SQL alike — and the existing UI keeps working unchanged.
--
-- Safety properties (all deliberate):
--   * SECURITY DEFINER + SET search_path: the audit insert must bypass the
--     audit_events RLS WITH CHECK (auth.uid() = user_id), because on a
--     service-role write auth.uid() is NULL and the actor falls back to the
--     row owner. auth.uid() still returns the real caller inside a DEFINER
--     function (it reads JWT claims, which DEFINER does not change), so a
--     human client write is still attributed to that human.
--   * The insert is wrapped in EXCEPTION WHEN OTHERS THEN NULL: auditing must
--     never abort the write it observes. An AFTER trigger that raised would
--     roll back the user's publish/revoke.
--   * WHEN clauses keep the triggers off the hot paths: a dashboard widget
--     refresh (which rewrites bi_dashboards on every scheduled tick) and an
--     embed view (which bumps embed_keys.use_count on every page load) do NOT
--     touch the audited columns, so the function is never even called for them.

-- ── BI dashboard publish / unpublish / share-link change ─────────────────────
CREATE OR REPLACE FUNCTION public.audit_bi_dashboard_share()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor  uuid := COALESCE(auth.uid(), NEW.user_id);
  _action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only reached (via the WHEN clause) when a row is created already public.
    _action := 'bi.dashboard.publish';
  ELSIF NEW.published AND NOT OLD.published THEN
    _action := 'bi.dashboard.publish';
  ELSIF OLD.published AND NOT NEW.published THEN
    _action := 'bi.dashboard.unpublish';
  ELSE
    -- Public-link rotated / set / cleared while the published flag held steady.
    _action := 'bi.dashboard.share_update';
  END IF;

  BEGIN
    INSERT INTO public.audit_events (user_id, action, resource_type, resource_name, resource_id, detail)
    VALUES (
      _actor, _action, 'bi_dashboard', NEW.name, NEW.id,
      jsonb_build_object('published', NEW.published, 'has_public_link', NEW.public_slug IS NOT NULL)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- auditing is best-effort; never break the underlying write
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_bi_dashboard_publish_ins ON public.bi_dashboards;
CREATE TRIGGER trg_audit_bi_dashboard_publish_ins
  AFTER INSERT ON public.bi_dashboards
  FOR EACH ROW
  WHEN (NEW.published)
  EXECUTE FUNCTION public.audit_bi_dashboard_share();

DROP TRIGGER IF EXISTS trg_audit_bi_dashboard_publish_upd ON public.bi_dashboards;
CREATE TRIGGER trg_audit_bi_dashboard_publish_upd
  AFTER UPDATE ON public.bi_dashboards
  FOR EACH ROW
  WHEN (
    OLD.published   IS DISTINCT FROM NEW.published
    OR OLD.public_slug IS DISTINCT FROM NEW.public_slug
  )
  EXECUTE FUNCTION public.audit_bi_dashboard_share();

-- ── Embed key create / revoke / reconfigure ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_embed_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row    public.embed_keys;
  _actor  uuid;
  _action text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    _row := OLD; _action := 'embed.key.revoke';
  ELSIF TG_OP = 'INSERT' THEN
    _row := NEW; _action := 'embed.key.create';
  ELSE
    _row := NEW; _action := 'embed.key.update';
  END IF;
  _actor := COALESCE(auth.uid(), _row.user_id);

  BEGIN
    INSERT INTO public.audit_events (user_id, action, resource_type, resource_name, resource_id, detail)
    VALUES (
      _actor, _action, 'embed_key', _row.name, _row.id,
      jsonb_build_object(
        'embed_resource_type', _row.resource_type,
        'embed_resource_id',   _row.resource_id,
        'allow_ai',            _row.allow_ai,
        'is_active',           _row.is_active
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_embed_key_ins ON public.embed_keys;
CREATE TRIGGER trg_audit_embed_key_ins
  AFTER INSERT ON public.embed_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_embed_key();

DROP TRIGGER IF EXISTS trg_audit_embed_key_del ON public.embed_keys;
CREATE TRIGGER trg_audit_embed_key_del
  AFTER DELETE ON public.embed_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_embed_key();

-- UPDATE only when a GOVERNANCE column changes — explicitly NOT use_count /
-- last_used_at, which are bumped on every embed view.
DROP TRIGGER IF EXISTS trg_audit_embed_key_upd ON public.embed_keys;
CREATE TRIGGER trg_audit_embed_key_upd
  AFTER UPDATE ON public.embed_keys
  FOR EACH ROW
  WHEN (
    OLD.name            IS DISTINCT FROM NEW.name
    OR OLD.allowed_domains IS DISTINCT FROM NEW.allowed_domains
    OR OLD.allow_ai        IS DISTINCT FROM NEW.allow_ai
    OR OLD.is_active       IS DISTINCT FROM NEW.is_active
    OR OLD.resource_id     IS DISTINCT FROM NEW.resource_id
    OR OLD.resource_type   IS DISTINCT FROM NEW.resource_type
  )
  EXECUTE FUNCTION public.audit_embed_key();

-- ── Align retention with the P0 runtime default ──────────────────────────────
-- P0 raised the code fallback to 365 days, but the column still defaulted to 14
-- (the compliance-inadequate window this whole effort is about). Bring the
-- stored default up, and migrate rows still sitting on the old default of 14.
-- A deliberately-chosen 14 is not distinguishable from the default here; the
-- trade is intentional — erring toward keeping the trail longer.
ALTER TABLE public.iam_settings ALTER COLUMN audit_retention_days SET DEFAULT 365;
UPDATE public.iam_settings SET audit_retention_days = 365 WHERE audit_retention_days = 14;
