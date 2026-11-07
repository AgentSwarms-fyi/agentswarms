// Who may copy a lakehouse table out of the lakehouse, into a catalog the
// lakehouse's policies do not reach (R223).
import { accessibleSchemas } from "./core.server";
import { loadPolicies } from "./policies.server";

/**
 * Why this caller may not publish this table, or null when they may. The
 * source must be readable by the caller: their own schema, or one shared
 * with them.
 *
 * FOUND IN R223: publishing checked only that the caller could see the
 * schema, then copied the raw table with INSERT ... SELECT. A schema shared
 * with someone is read by them through its owner's row filter and column
 * masks; the copy carried neither, into a catalog the reader owns. Owners
 * publish their own tables whole. Anyone else is refused a table under a
 * policy, as Spark refuses one: an Iceberg table cannot carry the policy.
 */
export async function icebergPublishRefusal(
  userId: string,
  schema: string,
  table: string,
): Promise<string | null> {
  const row = (await accessibleSchemas(userId)).find((s) => s.name === schema);
  if (!row) return `No access to schema "${schema}"`;
  if (row.user_id === userId) return null;
  const policies = await loadPolicies([row.user_id], [{ schema, table }]);
  if (!policies.size) return null;
  return `"${schema}.${table}" has a security policy set by its owner, which an Iceberg copy cannot carry — only the owner can publish it.`;
}

/**
 * Why this caller may not read this table outside the policy rewrite, or
 * null when they may (R457). Time travel on an Iceberg mount and a table's
 * change feed are reads the rewrite cannot reach: a time-travel clause does
 * not apply through the policy's subquery, and a change feed returns rows as
 * they were, including the before-image of an update. So, as for Spark and
 * for publishing, the owner reads them whole and anyone else is refused a
 * table under a policy rather than shown it unfiltered.
 */
export async function policedReadRefusal(
  userId: string,
  schema: string,
  table: string,
  what: string,
): Promise<string | null> {
  const row = (await accessibleSchemas(userId)).find((s) => s.name === schema);
  if (!row) return `No access to schema "${schema}"`;
  if (row.user_id === userId) return null;
  const policies = await loadPolicies([row.user_id], [{ schema, table }]);
  if (!policies.size) return null;
  return `"${schema}.${table}" has a security policy set by its owner, which ${what} cannot apply, so only the owner can see it.`;
}
