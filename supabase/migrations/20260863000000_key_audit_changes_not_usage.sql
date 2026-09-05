-- Audit a key's CHANGES, not its use.
--
-- Seen on the audit page after the gateway's first few calls: every call
-- produced a gateway_key.update row beside its gateway.chat row, because the
-- table's trigger fires on any UPDATE and each call touches use_count,
-- last_used_at and last_used_ip. Two rows per call, one of them saying
-- nothing, and the rows that matter - a scope widened, a chain edited, a key
-- revoked - buried among thousands of touches. The ML API keys have had the
-- same trigger since 20260858 and the same noise.
--
-- A call is already audited as what it is (gateway.chat, ml.api_key.denied,
-- ...). The row trigger now fires for inserts, deletes and updates of the
-- columns a person can change.
DROP TRIGGER IF EXISTS audit_gateway_keys ON public.gateway_keys;
CREATE TRIGGER audit_gateway_keys
  AFTER INSERT OR DELETE OR UPDATE OF
    name, scopes, agent_ids, model_allow, fallback_models, rate_limit_per_min,
    is_active, expires_at, revoked_at
  ON public.gateway_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('gateway_key');

DROP TRIGGER IF EXISTS audit_ml_api_keys ON public.ml_api_keys;
CREATE TRIGGER audit_ml_api_keys
  AFTER INSERT OR DELETE OR UPDATE OF
    name, scopes, is_active, expires_at, revoked_at
  ON public.ml_api_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('ml_api_key');
