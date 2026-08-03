// POST /api/bi/direct-query — live "Direct query" execution for a BI widget.
//
// The Import (SPICE) path renders a cached snapshot; a Direct-query widget
// re-runs its SQL live against the warehouse at view time for the full, current
// truth. Runs QuickSight-style AS THE DASHBOARD OWNER: a teammate with an IAM
// grant to the dashboard gets live data executed with the OWNER's warehouse
// credentials — they never need to own the connection themselves.
//
// SECURITY:
//   • Requires a real session; public embeds/shares have no session and render
//     from snapshots, so they can never trigger a live warehouse query here.
//   • Authorised only for the dashboard owner or a has_resource_access grantee.
//   • The connection is loaded with ownerUserId = the DASHBOARD OWNER (hard
//     user_id filter), never the caller.
//   • A grantee's row-level-security filter (BI dashboard grant row_filter) is
//     pushed into the query and FAILS CLOSED if it can't be enforced
//     (buildDirectQuerySql). Filter/value interpolation is injection-safe.
//   • A grantee's COLUMN MASK is applied to the result, and caller-supplied
//     filters naming a masked column are dropped before the SQL is built.
//     Without that second half the mask was only skin deep: the filter went
//     into the WHERE, the column was stripped from the rows, and the value came
//     back out by bisection — one yes/no answer per request.
//   • Per-owner rate limit so a shared dashboard can't hammer the owner's
//     warehouse. executeWarehouseQuery additionally enforces read-only SQL.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadWarehouseConnection } from "@/utils/warehouse/connections.server";
import { executeWarehouseQuery } from "@/utils/warehouse/drivers.server";
import { warehouseAbsMaxRows } from "@/utils/warehouse/governor.server";
import {
  buildDirectQuerySql,
  DIRECT_QUERY_MAX_ROWS,
  type DirectFilter,
  type DirectRowFilter,
} from "@/lib/biDirectQuery";
import { aggregationPlan } from "@/lib/biAggregate";
import { applyColumnMask, intersectColumnMasks, mergeGrantRowFilters } from "@/lib/biDashboards";
import type { ChartSpec } from "@/lib/biAgent";
import type { SqlDialect } from "@/lib/semanticLayer";
import { rateLimitedGlobal, envInt } from "@/utils/rateLimit.server";
import { auditEvent } from "@/utils/audit.server";

function getServerSupabase(authToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${authToken}` } },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type WidgetLike = {
  id?: string;
  kind?: string;
  sql?: string;
  query_mode?: string;
  columns?: unknown;
  source?: { kind?: string; connection_id?: string };
  chart?: unknown;
  agg_pushdown?: boolean;
};

export const Route = createFileRoute("/api/bi/direct-query")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        const sb = token ? getServerSupabase(token) : null;
        if (!token || !sb) return json(401, { error: "Sign in to run a live query" });
        const { data: claims } = await sb.auth.getClaims(token);
        const userId = claims?.claims?.sub;
        if (!userId) return json(401, { error: "Invalid session" });

        let body: { dashboard_id?: string; widget_id?: string; filters?: DirectFilter[] };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }
        if (!body.dashboard_id || !body.widget_id) {
          return json(400, { error: "dashboard_id and widget_id are required" });
        }

        // Load the dashboard (service role) to get the owner + widget.
        const { data: dash } = await supabaseAdmin
          .from("bi_dashboards")
          .select("id, user_id, widgets")
          .eq("id", body.dashboard_id)
          .maybeSingle();
        if (!dash) return json(404, { error: "Dashboard not found" });

        const ownerId = dash.user_id;
        const isOwner = ownerId === userId;
        if (!isOwner) {
          const { data: allowed } = await supabaseAdmin.rpc("has_resource_access", {
            rtype: "bi_dashboard",
            rid: body.dashboard_id,
            uid: userId,
          });
          if (!allowed) return json(403, { error: "You don't have access to this dashboard" });
        }

        const widgets = (Array.isArray(dash.widgets) ? dash.widgets : []) as WidgetLike[];
        const widget = widgets.find((w) => w?.id === body.widget_id);
        if (!widget) return json(404, { error: "Widget not found" });
        if (widget.query_mode !== "direct") {
          return json(400, { error: "Widget is not in direct-query mode" });
        }
        if (widget.source?.kind !== "warehouse" || !widget.source.connection_id || !widget.sql) {
          return json(400, { error: "Direct query requires a warehouse-backed widget" });
        }

        // Per-owner rate limit — a shared dashboard mustn't hammer the owner's
        // warehouse across many viewers.
        if (
          await rateLimitedGlobal(
            `bi-direct:${ownerId}`,
            envInt("BI_DIRECT_QUERY_RATE_PER_MIN", 120),
          )
        ) {
          return json(429, { error: "Too many live queries right now — try again shortly" });
        }

        // A grantee's restrictions must be enforced on live data too: row
        // filters narrow what comes back, and the column-mask intersection is
        // applied to the result below, before the response leaves the server.
        const rowFilters: DirectRowFilter[] = [];
        let maskedColumns: string[] = [];
        if (!isOwner) {
          const { data: gm } = await supabaseAdmin
            .from("iam_group_members")
            .select("group_id")
            .eq("user_id", userId);
          const groupIds = new Set((gm ?? []).map((g) => g.group_id));
          const { data: grants } = await supabaseAdmin
            .from("iam_resource_grants")
            .select("principal_type, principal_id, row_filter, column_mask")
            .eq("resource_type", "bi_dashboard")
            .eq("resource_id", body.dashboard_id);
          const mine = (grants ?? []).filter(
            (g) =>
              (g.principal_type === "user" && g.principal_id === userId) ||
              (g.principal_type === "group" && groupIds.has(g.principal_id)),
          );
          // An unfiltered grant admits every row, so it makes the filtered ones
          // irrelevant. This loop used to keep only the grants that HAD a
          // filter and silently drop the unrestricted one, so a user granted
          // full access through a group still saw a colleague's narrower slice.
          //
          // The merge itself lives in mergeGrantRowFilters, which is what the
          // dataset and snapshot paths call. Four private copies of one access
          // rule is what let the snapshot path fail open for months while the
          // other three failed closed.
          rowFilters.push(...(mergeGrantRowFilters(mine) ?? []));
          maskedColumns = intersectColumnMasks(mine.map((g) => g.column_mask));
        }

        // A COLUMN MASK IS NOT A MASK IF YOU CAN STILL FILTER ON IT.
        //
        // `filters` arrive in the request body, and the mask was applied only
        // to the RESULT. So a grantee whose grant hides `salary` could send
        //
        //   filters: [{ kind: "numrange", column: "salary", min: 100000 }]
        //
        // and the server issued
        //
        //   SELECT * FROM (…) AS _dq WHERE salary >= 100000
        //
        // then stripped `salary` from the rows it returned. The value never
        // appears in the payload and is recovered anyway: each request answers
        // one yes/no question about it, and bisection does the rest — roughly
        // 32 requests per row, under a rate limit of 120 a minute.
        //
        // Dropped rather than rejected, because a dashboard's own global filter
        // may legitimately name a column masked for one particular viewer, and
        // 400-ing would break their whole dashboard over someone else's config.
        // Reported in the response, because a filter that silently does nothing
        // is the other way to be wrong.
        const maskSet = new Set(maskedColumns.map((c) => c.toLowerCase()));
        const requestedFilters = body.filters ?? [];
        const usableFilters = maskSet.size
          ? requestedFilters.filter((f) => !maskSet.has(String(f?.column ?? "").toLowerCase()))
          : requestedFilters;
        const droppedFilters = requestedFilters
          .filter((f) => !usableFilters.includes(f))
          .map((f) => String(f?.column ?? ""));

        try {
          // Load the connection AS THE OWNER (hard user_id filter in the loader).
          const conn = await loadWarehouseConnection(
            supabaseAdmin,
            { connectionId: widget.source.connection_id },
            ownerId,
          );
          // Aggregate live too when the widget opted in: the filters above land
          // in the WHERE, so they still narrow the rows BEFORE they are grouped.
          const aggPlan = widget.agg_pushdown
            ? aggregationPlan(widget.chart as ChartSpec | undefined, {
                preserve: usableFilters.map((f) => f.column),
              })
            : null;
          // The driver clamps to the deployment's ceiling, so that — not the
          // module constant — is the real limit.
          const effectiveRowCap = Math.min(DIRECT_QUERY_MAX_ROWS, warehouseAbsMaxRows());
          const effectiveSql = buildDirectQuerySql({
            baseSql: widget.sql,
            columns: Array.isArray(widget.columns) ? (widget.columns as string[]) : [],
            filters: usableFilters,
            rowFilters,
            // Ask for no more than the driver will hand back. Requesting
            // 100k while the governor clamps to a few thousand made the
            // warehouse compute rows we then discarded, and made the LIMIT in
            // the generated SQL a claim we could not honour.
            rowCap: effectiveRowCap,
            agg: aggPlan ?? undefined,
            dialect: conn.config.provider as SqlDialect,
          });
          // Billed to the dashboard OWNER: a dashboard shared with fifty
          // people must not be able to spend fifty tenants' query slots.
          const result = await executeWarehouseQuery(conn.config, effectiveSql, effectiveRowCap, {
            userId: ownerId,
          });
          auditEvent({
            userId,
            action: "bi.direct_query",
            resourceType: "bi_dashboard",
            resourceId: body.dashboard_id,
            detail: {
              widget: body.widget_id,
              owner: ownerId,
              ran_as_owner: !isOwner,
              rows: result.row_count,
              duration_ms: result.duration_ms,
            },
          });
          // Column masks apply to live results exactly as to snapshots: drop
          // the columns server-side so a restricted grantee's browser never
          // receives them.
          if (maskedColumns.length > 0) {
            const masked = applyColumnMask(
              result.columns.map((c) => c.name),
              result.rows,
              maskedColumns,
            );
            return json(200, {
              columns: result.columns.filter((c) => masked.columns.includes(c.name)),
              rows: masked.rows,
              row_count: result.row_count,
              truncated: result.truncated,
              ...(droppedFilters.length ? { dropped_filters: droppedFilters } : {}),
            });
          }
          return json(200, {
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            // A live widget that hit the ceiling is showing a SUBSET. Dropping
            // this flag made that invisible, which is the same silent
            // wrongness the snapshot path grew a "Partial" badge to avoid.
            truncated: result.truncated,
          });
        } catch (e) {
          return json(400, {
            error: "query_failed",
            message: e instanceof Error ? e.message : "Query failed",
          });
        }
      },
    },
  },
});
