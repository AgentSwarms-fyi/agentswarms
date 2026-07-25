-- Close the "client writes aren't audited" gap.
--
-- Server-side mutations already emit audit_events (auditEvent(), service role).
-- But writes made directly from the browser under RLS — creating/updating/
-- deleting dashboards, agents, knowledge bases, datasets, integrations,
-- secrets, MCP servers, prep flows, semantic models — bypassed that path and
-- left no trail. This DB trigger records them at the source, so the audit log
-- is complete regardless of whether a change came from the app server or the
-- client.
--
-- Design:
--   * Logs ONLY non-service-role writes. Server code uses the service role and
--     audits its own actions, so those are skipped here to avoid double
--     counting; anonymous writes have no user to attribute.
--   * Records only the column NAMES that changed on UPDATE, never values, so no
--     secret or row content ever leaks into the audit trail.
--   * Never blocks or alters the user's write (AFTER trigger; any logging error
--     is swallowed).

CREATE OR REPLACE FUNCTION public.audit_client_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _role text := COALESCE(auth.jwt() ->> 'role', '');
  _row jsonb := to_jsonb(COALESCE(NEW, OLD));
  _changed text[];
  _detail jsonb := jsonb_build_object('op', TG_OP);
BEGIN
  -- Service-role writes are audited in application code already; anonymous
  -- writes have no user to attribute. Skip both.
  IF _uid IS NULL OR _role = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(o.key ORDER BY o.key) INTO _changed
    FROM jsonb_each(to_jsonb(OLD)) o
    JOIN jsonb_each(to_jsonb(NEW)) n ON n.key = o.key
    WHERE o.value IS DISTINCT FROM n.value;
    IF _changed IS NOT NULL THEN
      _detail := _detail || jsonb_build_object('changed', to_jsonb(_changed));
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.audit_events
      (user_id, action, resource_type, resource_name, resource_id, detail)
    VALUES (
      _uid,
      TG_TABLE_NAME || '.' || lower(TG_OP),
      TG_TABLE_NAME,
      left(_row ->> 'name', 200),
      NULLIF(_row ->> 'id', '')::uuid,
      _detail
    );
  EXCEPTION WHEN OTHERS THEN
    -- Audit logging must never break the user's actual write.
    NULL;
  END;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Trigger functions fire as part of DML regardless of caller privileges; keep
-- direct EXECUTE off the client roles as hygiene.
REVOKE EXECUTE ON FUNCTION public.audit_client_write() FROM anon, authenticated;

-- Discrete-write tables: audit the full lifecycle.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agents', 'knowledge_bases', 'user_data_tables', 'integrations',
    'provider_credentials', 'user_secrets', 'mcp_servers', 'user_prep_flows',
    'semantic_models'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_client_write ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_client_write AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_client_write()', t);
  END LOOP;
END $$;

-- bi_dashboards: lifecycle only. The editor autosaves the whole dashboard every
-- ~700ms while editing, which would flood the trail with UPDATE rows; content
-- integrity is handled by optimistic versioning, and publish/reader-model
-- changes are audited server-side. So log creation and deletion only.
DROP TRIGGER IF EXISTS trg_audit_client_write ON public.bi_dashboards;
CREATE TRIGGER trg_audit_client_write AFTER INSERT OR DELETE ON public.bi_dashboards
  FOR EACH ROW EXECUTE FUNCTION public.audit_client_write();
