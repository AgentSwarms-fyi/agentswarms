// Access policy for SHARED semantic models.
//
// Sharing a model used to mean sharing everything it computes: "the metric is
// the access boundary — it runs as the model owner", so granting `revenue` to
// a regional manager granted GLOBAL revenue. This module closes that: a grant
// of type semantic_model can carry a row filter (dimension ∈ values) and a
// field mask, and a GRANTEE's query gets both enforced BEFORE compilation —
// the filter becomes a governed IN-filter inside the compiled SQL itself, so
// enforcement rides the same literal-escaping and name validation as every
// other semantic filter and works identically on DuckDB and every warehouse.
//
// The merge semantics are deliberately NOT reinvented: mergeGrantRowFilters
// and intersectColumnMasks are the exact functions BI dashboard sharing uses.
// Four private copies of one access rule is how the dashboard snapshot path
// once failed open for months; semantic models start with the shared one.
import type { Json } from "@/integrations/supabase/types";
import { mergeGrantRowFilters, intersectColumnMasks, type BiRowFilter } from "@/lib/biDashboards";
import type { SemanticModel, SemanticQuery } from "@/lib/semanticLayer";

export type GrantRow = {
  principal_type: string;
  principal_id: string;
  row_filter: Json | null;
  column_mask: unknown;
};

/** The grants that apply to a user directly or through their groups. */
export function applicableGrants<G extends GrantRow>(
  grants: G[],
  userId: string,
  groupIds: Iterable<string>,
): G[] {
  const groups = new Set(groupIds);
  return grants.filter(
    (g) =>
      (g.principal_type === "user" && g.principal_id === userId) ||
      (g.principal_type === "group" && groups.has(g.principal_id)),
  );
}

// ── Attribute-driven row filters ───────────────────────────────────────────
//
// A grant's row-filter VALUES may be the token {{user.<key>}} instead of a
// literal. At enforcement time the token resolves to the CALLING user's
// values for <key> from iam_user_attributes — one grant on a group can scope
// every member to their own region. Resolution happens per grant, BEFORE the
// permissive-union merge, so two grants resolving to different values union
// exactly like two literal grants would.
//
// FAIL CLOSED, with the attribute named: a token whose attribute the user
// does not have (or has empty) REFUSES the query rather than compiling an
// empty filter — silent zero rows would read as "there is no data", and an
// unresolved token passed through as a literal would match nothing while
// LOOKING like a value. Both are the quiet failure this layer refuses.

/** Matches a whole-value attribute token: {{user.region}} (trimmed). */
export const USER_ATTR_TOKEN_RE = /^\{\{\s*user\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/;

/**
 * The refusal an unresolvable attribute token raises. A distinct class so
 * surfaces with a swallow-everything fallback (shared datasets fail closed to
 * EMPTY on unexpected errors) can rethrow THIS one — an attribute refusal
 * shown as silently-empty data would read as "there is no data", the exact
 * quiet failure the token contract exists to prevent.
 */
export class AttributeRefusalError extends Error {
  override name = "AttributeRefusalError";
}

/** The attribute keys any of these grants' row filters reference. */
export function attributeKeysInGrants(grants: GrantRow[]): string[] {
  const keys = new Set<string>();
  for (const g of grants) {
    const rf = g.row_filter as { values?: unknown } | null;
    if (!rf || !Array.isArray(rf.values)) continue;
    for (const v of rf.values) {
      const m = typeof v === "string" ? USER_ATTR_TOKEN_RE.exec(v.trim()) : null;
      if (m) keys.add(m[1]);
    }
  }
  return [...keys];
}

/**
 * Substitute every {{user.<key>}} token in these grants' row filters with the
 * caller's attribute values. Literal values pass through untouched; a token
 * expands to ALL of the user's values for that key (an attribute is a list —
 * a manager may hold two regions). Throws — refusing the query — when a
 * referenced attribute is missing or empty for this user.
 */
export function resolveAttributeGrants<G extends GrantRow>(
  grants: G[],
  attributes: Map<string, string[]>,
): G[] {
  return grants.map((g) => {
    const rf = g.row_filter as { column?: unknown; values?: unknown } | null;
    if (!rf || !Array.isArray(rf.values)) return g;
    let touched = false;
    const values: string[] = [];
    for (const v of rf.values) {
      const m = typeof v === "string" ? USER_ATTR_TOKEN_RE.exec(v.trim()) : null;
      if (!m) {
        if (typeof v === "string") values.push(v);
        continue;
      }
      touched = true;
      const mine = attributes.get(m[1]) ?? [];
      if (mine.length === 0) {
        throw new AttributeRefusalError(
          `Your access is filtered by the attribute "${m[1]}" ({{user.${m[1]}}}), but your ` +
            `account has no value for it. Ask an admin to set it under IAM → Attributes.`,
        );
      }
      values.push(...mine);
    }
    if (!touched) return g;
    return { ...g, row_filter: { ...rf, values } as G["row_filter"] };
  });
}

export type SemanticAccessPolicy = {
  /** null = unrestricted (at least one grant carries no filter). */
  rowFilters: BiRowFilter[] | null;
  /** Field names (lowercased) the grantee may not reference. */
  maskedFields: string[];
};

/** Merge a grantee's applicable grants into one enforced policy. */
export function policyFromGrants(mine: GrantRow[]): SemanticAccessPolicy {
  return {
    rowFilters: mergeGrantRowFilters(mine),
    maskedFields: intersectColumnMasks(mine.map((g) => g.column_mask)),
  };
}

/** Is there anything to enforce or disclose? */
export function policyIsRestrictive(p: SemanticAccessPolicy | null): p is SemanticAccessPolicy {
  return !!p && (p.rowFilters !== null || p.maskedFields.length > 0);
}

/**
 * Enforce a grantee's policy on a semantic query BEFORE compilation.
 *
 * Masked fields are REFUSED wherever they appear — metrics, dimensions,
 * filters, grains, order — not silently dropped: a query that quietly ignores
 * part of what it was asked is the "right-looking wrong answer" failure this
 * layer exists to prevent. A row filter must name a dimension that exists on
 * the model; if it doesn't, the query FAILS CLOSED with a message pointing at
 * the grant, because "filter didn't apply" must never degrade to "grantee saw
 * everything". An empty values list compiles to `1 = 0` (the compiler's own
 * unsatisfiable IN), which is the correct reading of an unusable filter.
 */
export function applyAccessPolicy(
  model: SemanticModel,
  q: SemanticQuery,
  policy: SemanticAccessPolicy,
): SemanticQuery {
  // ── Field mask ──────────────────────────────────────────────────────────
  if (policy.maskedFields.length > 0) {
    const masked = new Set(policy.maskedFields.map((f) => f.toLowerCase()));
    const referenced = [
      ...(q.metrics ?? []),
      ...(q.dimensions ?? []),
      ...(q.filters ?? []).map((f) => f.field),
      ...(q.orderBy ?? []).map((o) => o.field),
      ...Object.keys(q.grains ?? {}),
    ];
    const hit = referenced.find((f) => masked.has(String(f).toLowerCase()));
    if (hit) {
      throw new Error(
        `"${hit}" is not included in your access to "${model.name}" — it was masked by the ` +
          `share grant. Ask the owner to widen the grant if you need it.`,
      );
    }
  }

  // ── Row filters ─────────────────────────────────────────────────────────
  if (policy.rowFilters === null || policy.rowFilters.length === 0) return q;

  const dimByLower = new Map(model.dimensions.map((d) => [d.name.toLowerCase(), d.name]));
  const extra = policy.rowFilters.map((rf) => {
    const canonical = dimByLower.get(rf.column.trim().toLowerCase());
    if (!canonical) {
      // FAIL CLOSED. The grant restricts rows by a dimension this model does
      // not define (typo, or the model was edited after the grant was
      // written). Running unfiltered would silently hand the grantee the
      // owner's full data — the exact hole this policy exists to close.
      throw new Error(
        `Your access to "${model.name}" is filtered by "${rf.column}", which is not a ` +
          `dimension on the model — the share grant and the model no longer agree. ` +
          `Ask the owner to update the grant.`,
      );
    }
    // Numeric-looking values are sent as numbers so the IN-list compares
    // cleanly against numeric columns on strict engines (BigQuery refuses
    // STRING vs INT64 outright).
    const values = rf.values.map((v) => {
      const n = Number(v);
      return v.trim() !== "" && Number.isFinite(n) ? n : v;
    });
    return { field: canonical, op: "in" as const, value: values };
  });

  return { ...q, filters: [...(q.filters ?? []), ...extra] };
}

/**
 * A model as a restricted viewer should SEE it: masked fields removed from
 * dimensions and metrics. Used for the agent catalog and the read-only editor,
 * so a grantee is never offered a name the query path would refuse.
 */
export function maskCatalogModel(model: SemanticModel, maskedFields: string[]): SemanticModel {
  if (maskedFields.length === 0) return model;
  const masked = new Set(maskedFields.map((f) => f.toLowerCase()));
  return {
    ...model,
    dimensions: model.dimensions.filter((d) => !masked.has(d.name.toLowerCase())),
    metrics: model.metrics.filter((m) => !masked.has(m.name.toLowerCase())),
  };
}

/**
 * One human/agent-readable line describing a policy — trust through
 * visibility: a grantee (and their agent) should KNOW their numbers are a
 * scoped view, not the global truth.
 */
export function describePolicy(p: SemanticAccessPolicy): string {
  const parts: string[] = [];
  for (const rf of p.rowFilters ?? []) {
    parts.push(
      `rows limited to ${rf.column} ∈ [${rf.values.slice(0, 5).join(", ")}${rf.values.length > 5 ? ", …" : ""}]`,
    );
  }
  if (p.maskedFields.length > 0) parts.push(`hidden fields: ${p.maskedFields.join(", ")}`);
  return parts.join("; ");
}
