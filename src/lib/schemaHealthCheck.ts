// Lightweight Supabase schema-drift detector.
//
// THE PROBLEM: a contributor runs `git pull`, gets code that reads or writes
// a column/table a recent migration added, but never re-applies migrations
// against their local or linked Supabase project. PostgREST then rejects the
// query with `42703 undefined_column` for a missing column, or (against
// hosted Supabase specifically — see MISSING_TABLE_POSTGREST below)
// `PGRST205` for a missing table — which today shows up as a broken feature
// or an unhandled rejection, with nothing telling the contributor "run your
// migrations" is the fix.
//
// THE FIX has two layers, both defined here and wired together by
// SchemaHealthGuard.tsx:
//
//   1. A PROACTIVE startup check (`checkSchemaHealth`) against a short,
//      maintainer-curated list of "recently added, load-bearing" columns and
//      tables (`REQUIRED_SCHEMA_CHECKS` below) — catches the problem before
//      the contributor stumbles into a broken feature.
//   2. A REACTIVE fetch interceptor (`installSchemaHealthFetchInterceptor`)
//      that inspects every response from the Supabase REST endpoint for one
//      of those error codes, so *any* missing column/table surfaces the same
//      modal, even one nobody remembered to add to the curated list.
//
// Both report through the same `SchemaIssue` shape so the UI doesn't need to
// know which layer found the problem.

import { createClient } from "@supabase/supabase-js";

export type SchemaCheck = {
  /** Table to probe. */
  table: string;
  /** Omit to check that the table itself exists, rather than one column on it. */
  column?: string;
  /** Migration filename this shipped in — shown in the modal so a
   * contributor can see exactly how far behind their schema is. */
  migration: string;
  /** One line of human context, shown in the modal. */
  description: string;
};

// Maintainers: whenever you ship a migration that adds a column or table a
// page reads on first render (so a contributor hits it immediately, not
// three clicks in), add one entry here. Keep this list short and
// load-bearing — it's a deliberately curated "known landmines" list, not a
// mirror of all 170+ migrations. Anything not listed here still gets caught
// by the reactive fetch interceptor the moment it's actually queried; this
// list only exists to catch the *common* ones before that.
export const REQUIRED_SCHEMA_CHECKS: SchemaCheck[] = [
  {
    table: "user_data_tables",
    column: "storage_mode",
    migration: "20260828000000_dataset_storage_mode.sql",
    description: "Per-dataset storage mode (auto / import / direct) in the Data Catalog.",
  },
  {
    table: "user_data_tables",
    column: "saas_connection_id",
    migration: "20260832000000_dataset_saas_attribution.sql",
    description: "Groups connector-synced tables by their source connection.",
  },
  {
    table: "slack_workspaces",
    migration: "20260833000000_slack_workspace.sql",
    description: "Inbound Slack workspace installs for the AI Analyst.",
  },
];

export type SchemaIssue = {
  table: string;
  column?: string;
  kind: "missing_column" | "missing_table";
  /** Present when this came from the proactive check; absent when the
   * reactive interceptor caught a query that wasn't in the curated list. */
  check?: SchemaCheck;
};

const MISSING_COLUMN = "42703";
// Supabase's hosted PostgREST resolves table names against its own schema
// cache before a query ever reaches Postgres, so a missing table surfaces as
// PostgREST's own `PGRST205` ("Could not find the table ... in the schema
// cache"), not Postgres's `42P01`. Checking both is what makes this work
// against real Supabase rather than only a bare PostgREST/Postgres setup —
// verified against a live project rather than assumed.
const MISSING_TABLE = "42P01";
const MISSING_TABLE_POSTGREST = "PGRST205";

// Mirrors the resolution in src/integrations/supabase/client.ts (which is
// generated and shouldn't be hand-edited) rather than importing from it, so
// this module has no dependency on that file's internals.
function resolveSupabaseUrl(): string {
  return (
    import.meta.env.VITE_SUPABASE_URL ||
    (typeof process !== "undefined" && process.env.SUPABASE_URL) ||
    ""
  );
}
function resolveSupabaseKey(): string {
  return (
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    (typeof process !== "undefined" && process.env.SUPABASE_PUBLISHABLE_KEY) ||
    ""
  );
}

// Deliberately untyped: these checks exist specifically to probe for columns
// that might not be in the generated `Database` type yet — it's regenerated
// from the live schema, so it lags exactly the same migrations this tool is
// trying to detect as unapplied. Fighting the generic types here would
// defeat the point (see storage_mode/saas_connection_id/slack_workspaces
// above, none of which are in src/integrations/supabase/types.ts yet).
let probeClient: ReturnType<typeof createClient> | null | undefined;
function getProbeClient() {
  if (probeClient === undefined) {
    const url = resolveSupabaseUrl();
    const key = resolveSupabaseKey();
    probeClient = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  }
  return probeClient;
}

async function probe(check: SchemaCheck): Promise<SchemaIssue | null> {
  const client = getProbeClient();
  if (!client) return null; // env not configured yet — nothing to check

  // Deliberately not `head: true`: a HEAD response has no body by HTTP spec,
  // so PostgREST can't attach error details to it — that turns every failure
  // into a bodyless `{ message: "" }` with no `.code`, silently defeating
  // every check below (confirmed against a live project, not assumed).
  // `limit(0)` keeps it just as cheap — a real query plan still has to be
  // built (which is what surfaces the "column/table doesn't exist" error),
  // it just fetches zero rows back.
  const { error } = await client
    .from(check.table)
    .select(check.column ?? "*")
    .limit(0);
  if (!error) return null;

  if (error.code === MISSING_COLUMN) {
    return { table: check.table, column: check.column, kind: "missing_column", check };
  }
  if (error.code === MISSING_TABLE || error.code === MISSING_TABLE_POSTGREST) {
    return { table: check.table, kind: "missing_table", check };
  }
  // Anything else — permission denied, network error, RLS — isn't a schema
  // problem. Don't false-positive on it.
  return null;
}

/**
 * Runs every registered check in parallel and returns every issue found
 * (usually none). Each check fetches at most zero rows (`.limit(0)`), so
 * this is cheap enough to run on every app load.
 */
export async function checkSchemaHealth(
  checks: SchemaCheck[] = REQUIRED_SCHEMA_CHECKS,
): Promise<SchemaIssue[]> {
  const results = await Promise.all(checks.map(probe));
  return results.filter((r): r is SchemaIssue => r !== null);
}

let interceptorInstalled = false;

/**
 * Patches `window.fetch` to inspect — never alter — every response from the
 * Supabase REST endpoint. When one is a missing-column/table error, `onIssue` fires
 * with the details; the original response is returned untouched to whatever
 * code made the request, so every existing `if (error) ...` call site keeps
 * working exactly as it does today.
 *
 * Idempotent: safe to call more than once (React StrictMode's double effect
 * invocation, Vite HMR) — only the first call actually patches `fetch`.
 */
export function installSchemaHealthFetchInterceptor(onIssue: (issue: SchemaIssue) => void) {
  if (interceptorInstalled || typeof window === "undefined") return;
  interceptorInstalled = true;

  const restUrl = resolveSupabaseUrl();
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    if (!restUrl || response.ok) return response;

    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${restUrl}/rest/v1/`)) return response;

    // Clone before reading: the body stream can only be consumed once, and
    // the actual supabase-js client that made this request still needs to
    // read it to build the `error` it hands back to its caller.
    response
      .clone()
      .json()
      .then((body: { code?: string; message?: string }) => {
        const isMissingTable =
          body?.code === MISSING_TABLE || body?.code === MISSING_TABLE_POSTGREST;
        if (body?.code !== MISSING_COLUMN && !isMissingTable) return;
        const table = url.split("/rest/v1/")[1]?.split("?")[0] || "unknown table";
        onIssue({ table, kind: isMissingTable ? "missing_table" : "missing_column" });
      })
      .catch(() => {
        // Not JSON, or a body some other interceptor already consumed —
        // not our concern either way.
      });

    return response;
  };
}
