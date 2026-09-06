// The metrics API's server side: a gateway key with the "metrics" scope
// lists the semantic models its owner may read and runs governed metric
// queries against them. Nothing here compiles or executes SQL of its own -
// every query goes through runSemanticQuery, the one chokepoint the runner
// UI, the dashboards and the metric_query agent tool already share, as the
// key's OWNER: the owner's models plus the ones IAM shares with them, a
// grantee's row filters and field masks rewritten into the query, the data
// read and billed as the model owner. The API adds the key's own allow-list
// on top of that access, never instead of it, and the audit row every
// metric read leaves.
import { MAX_LIMIT, type SemanticModel } from "@/lib/semanticLayer";
import { describePolicy, maskCatalogModel, policyIsRestrictive } from "@/lib/semanticPolicy";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { gatewayFail, gatewayJson, type GatewayKeyRow } from "@/utils/gateway/api.server";
import {
  describeModelForApi,
  findSemanticModelByRef,
  metricsResultBody,
  parseMetricsQueryRequest,
  semanticModelAllowedByKey,
  type ApiModelDescription,
} from "@/utils/gateway/metrics";
import { resolveGrantedResourceIds } from "@/utils/iam.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { resultDigest } from "@/utils/provenance/canonical";
import { clientIp } from "@/utils/requestMeta.server";
import { semanticPoliciesFor } from "@/utils/semantic/policy.server";
import { listSemanticModels, runSemanticQuery } from "@/utils/semantic/query.server";

/**
 * A key without the scope is refused before anything is listed or run, and
 * the refusal is audited like every other denial with the caller's address.
 */
export function requireMetricsScope(key: GatewayKeyRow, request: Request): Response | null {
  if (key.scopes.includes("metrics")) return null;
  auditEvent({
    userId: key.user_id,
    action: "gateway.access.denied",
    resourceType: "gateway_key",
    resourceId: key.id,
    resourceName: key.name,
    detail: { reason: "scope", scope: "metrics", ip: clientIp(request) ?? null },
  });
  return gatewayFail(403, "insufficient_scope", 'This key does not have the "metrics" scope');
}

/**
 * The semantic models a user may read: their own plus the ones IAM grants
 * them. A shared model whose grant carries a restriction is masked the way
 * the agent catalog masks it - a field the grantee may not see is not
 * advertised - and the restriction is described so a scoped view is never
 * mistaken for the whole. Shared with the key form, which offers these as
 * the allow-list.
 */
export async function accessibleSemanticModels(
  userId: string,
): Promise<{ models: SemanticModel[]; grantedIds: string[]; notes: Map<string, string> }> {
  const grantedIds = [
    ...(await resolveGrantedResourceIds(supabaseAdmin, userId, "semantic_model")),
  ];
  let models = await listSemanticModels(supabaseAdmin, {
    requesterId: userId,
    ownerId: userId,
    grantedIds,
  });
  const notes = new Map<string, string>();
  const sharedIds = models.filter((m) => m.id && m.ownerId !== userId).map((m) => m.id as string);
  if (sharedIds.length > 0) {
    const policies = await semanticPoliciesFor(userId, sharedIds);
    models = models.map((m) => {
      const p = m.id ? policies.get(m.id) : undefined;
      if (!p || !policyIsRestrictive(p)) return m;
      notes.set(m.id as string, describePolicy(p));
      return maskCatalogModel(m, p.maskedFields);
    });
  }
  return { models, grantedIds, notes };
}

/** GET /api/v1/metrics: the models this key may query, described for a client. */
export async function listGatewayMetrics(key: GatewayKeyRow): Promise<ApiModelDescription[]> {
  const { models, notes } = await accessibleSemanticModels(key.user_id);
  return models
    .filter((m) => semanticModelAllowedByKey(key.semantic_model_ids, m.id))
    .map((m) =>
      describeModelForApi(m, {
        requesterId: key.user_id,
        accessNote: m.id ? notes.get(m.id) : undefined,
      }),
    );
}

/** A failure that came from the data source rather than the request. */
const UPSTREAM_RE =
  /ECONN|ETIMEDOUT|ENOTFOUND|timed out|timeout|unavailable|connection|network|socket/i;

/** POST /api/v1/metrics/query. */
export async function runGatewayMetricsQuery(args: {
  request: Request;
  key: GatewayKeyRow;
  body: unknown;
}): Promise<Response> {
  const { key, request } = args;
  const parsed = parseMetricsQueryRequest(args.body);
  if (!parsed.ok) return gatewayFail(400, "invalid_request_error", parsed.error);
  const owner = key.user_id;
  const { models, grantedIds } = await accessibleSemanticModels(owner);
  const model = findSemanticModelByRef(models, parsed.query.model, owner);
  if (!model) {
    return gatewayFail(
      404,
      "model_not_found",
      `Semantic model "${parsed.query.model.slice(0, 80)}" is not among the models this key's owner may read; GET /api/v1/metrics lists them`,
    );
  }
  if (!semanticModelAllowedByKey(key.semantic_model_ids, model.id)) {
    return gatewayFail(
      403,
      "model_not_allowed",
      `This key may not query the semantic model "${model.name}"`,
    );
  }
  // The instance cap bounds every answer, under the compiler's own ceiling;
  // a smaller limit in the request wins. The compiled LIMIT is one past the
  // cap so `truncated` is a fact - the compiler would otherwise apply its
  // default LIMIT of 1000 and a full page would read as the whole result.
  // At the ceiling itself one more row cannot be asked for, so a full page
  // there is reported as truncated: reaching the ceiling is the fact.
  const instanceCap = (await getPlatformResources()).gatewayMetricsMaxRows;
  const ceiling = Math.min(instanceCap, MAX_LIMIT);
  const cap = Math.min(ceiling, parsed.query.limit ?? ceiling);
  const fetchRows = Math.min(cap + 1, MAX_LIMIT);
  try {
    const res = await runSemanticQuery({
      sb: supabaseAdmin,
      userId: owner,
      scopeUserId: owner,
      grantedModelIds: grantedIds,
      query: { ...parsed.query, model: model.name, limit: fetchRows },
      maxRows: fetchRows,
    });
    const body = metricsResultBody(res, cap);
    if (cap >= MAX_LIMIT && res.rows.length >= MAX_LIMIT) body.truncated = true;
    // The same audit row the agent tool leaves - a metric query IS a data
    // read - with the key that made it, the compiled SQL and a digest of the
    // result, so the read can be replayed and compared later.
    auditEvent({
      userId: owner,
      action: "metric.query",
      resourceType: "semantic_model",
      resourceId: model.id,
      resourceName: model.name.slice(0, 200),
      detail: {
        via: "gateway",
        gateway_key_id: key.id,
        gateway_key_name: key.name,
        metrics: parsed.query.metrics,
        dimensions: parsed.query.dimensions ?? [],
        row_count: body.row_count,
        truncated: body.truncated,
        sql: res.sql.slice(0, 4000),
        result_digest: resultDigest(res.columns, res.rows),
        ip: clientIp(request) ?? null,
      },
    });
    return gatewayJson(body, 200, { "X-Semantic-Model": model.name });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (UPSTREAM_RE.test(message)) {
      return gatewayFail(
        502,
        "upstream_error",
        `The model's data source did not answer: ${message.slice(0, 300)}`,
      );
    }
    // Everything else is the request's own mistake in the compiler's words:
    // an unknown metric, a grain on a non-time dimension, a missing parameter.
    return gatewayFail(400, "invalid_request_error", message.slice(0, 500));
  }
}
