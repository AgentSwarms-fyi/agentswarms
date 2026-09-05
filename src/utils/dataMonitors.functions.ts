// Server functions behind Data & BI -> Data monitors: what can be watched,
// the monitors and their incidents, create / edit / pause / delete / run now,
// run history, and acknowledging or resolving an incident by hand.
//
// Every write goes through the service role pinned to the caller's user id
// (the idiom the ML schedules use); the table's trigger audits definition
// changes, and the runner audits alerts and resolutions.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  MONITOR_KINDS,
  MONITOR_SCHEDULES,
  MONITOR_SEVERITIES,
  defaultMonitorName,
  validateMonitorConfig,
  type MonitorConfig,
} from "@/utils/dataMonitors/core";
import {
  nextMonitorRunAt,
  runDataMonitor,
  type DataIncidentRow,
  type DataMonitorRow,
  type DataMonitorRunRow,
} from "@/utils/dataMonitors/run.server";
import { listLakehouseTablesForUser } from "@/utils/lakehouse/tables.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

export type MonitorView = DataMonitorRow & {
  /** The last runs' values, oldest first, for the sparkline. */
  recent: { ran_at: string; status: string; value: number | null }[];
  open_incident: Pick<
    DataIncidentRow,
    "id" | "status" | "severity" | "opened_at" | "occurrences"
  > | null;
};

const configSchema = z.object({
  column: z.string().max(200).optional(),
  columns: z.array(z.string().min(1).max(200)).max(20).optional(),
  max_age_minutes: z
    .number()
    .positive()
    .max(60 * 24 * 365)
    .optional(),
  mode: z.enum(["delta", "total"]).optional(),
  min_rows: z.number().min(0).nullable().optional(),
  max_rows: z.number().min(0).nullable().optional(),
  anomaly: z.boolean().optional(),
  max_null_pct: z.number().min(0).max(100).optional(),
  sql: z.string().max(20000).optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
});

/** What the wizard may watch: lakehouse tables with their columns, and the caller's warehouses. */
export const dataMonitorSources = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          lakehouse: {
            enabled: boolean;
            tables: { schema: string; table: string; columns: { name: string; type: string }[] }[];
          };
          warehouses: { id: string; name: string; provider: string }[];
        }
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const lake = await listLakehouseTablesForUser(caller.userId).catch(() => ({
        enabled: false,
        tables: [],
        schemas: [],
      }));
      const { data: whs } = await supabaseAdmin
        .from("data_warehouse_connections")
        .select("id, name, provider")
        .eq("user_id", caller.userId)
        .eq("is_active", true)
        .order("name");
      return {
        ok: true,
        lakehouse: {
          enabled: lake.enabled,
          tables: lake.tables.map((t) => ({
            schema: t.schema,
            table: t.table,
            columns: t.columns,
          })),
        },
        warehouses: (whs ?? []).map((w) => ({
          id: w.id,
          name: w.name,
          provider: String(w.provider),
        })),
      };
    },
  );

export const dataMonitorsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; monitors: MonitorView[]; incidents: DataIncidentRow[] }> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const [{ data: monitors, error }, { data: incidents }] = await Promise.all([
        supabaseAdmin
          .from("data_monitors")
          .select("*")
          .eq("user_id", caller.userId)
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("data_incidents")
          .select("*")
          .eq("user_id", caller.userId)
          .order("opened_at", { ascending: false })
          .limit(200),
      ]);
      if (error) return { ok: false, error: error.message };
      const rows = (monitors ?? []) as DataMonitorRow[];
      const ids = rows.map((m) => m.id);
      const recentBy = new Map<
        string,
        { ran_at: string; status: string; value: number | null }[]
      >();
      if (ids.length) {
        const { data: runs } = await supabaseAdmin
          .from("data_monitor_runs")
          .select("monitor_id, ran_at, status, value")
          .in("monitor_id", ids)
          .order("ran_at", { ascending: false })
          .limit(ids.length * 20);
        for (const r of runs ?? []) {
          const list = recentBy.get(r.monitor_id) ?? [];
          if (list.length < 20) list.push({ ran_at: r.ran_at, status: r.status, value: r.value });
          recentBy.set(r.monitor_id, list);
        }
      }
      const openBy = new Map<string, DataIncidentRow>();
      for (const i of (incidents ?? []) as DataIncidentRow[]) {
        if (i.status !== "resolved" && !openBy.has(i.monitor_id)) openBy.set(i.monitor_id, i);
      }
      return {
        ok: true,
        monitors: rows.map((m) => {
          const inc = openBy.get(m.id);
          return {
            ...m,
            recent: (recentBy.get(m.id) ?? []).slice().reverse(),
            open_incident: inc
              ? {
                  id: inc.id,
                  status: inc.status,
                  severity: inc.severity,
                  opened_at: inc.opened_at,
                  occurrences: inc.occurrences,
                }
              : null,
          };
        }),
        incidents: (incidents ?? []) as DataIncidentRow[],
      };
    },
  );

const createSchema = z.object({
  access_token: z.string().min(1),
  name: z.string().max(120).optional(),
  source_kind: z.enum(["lakehouse", "warehouse"]),
  warehouse_id: z.string().uuid().nullable().optional(),
  schema_name: z.string().min(1).max(200),
  table_name: z.string().min(1).max(200),
  kind: z.enum(MONITOR_KINDS),
  config: configSchema.default({}),
  schedule: z.enum(MONITOR_SCHEDULES).default("hourly"),
  cron_expr: z.string().max(120).nullable().optional(),
  timezone: z.string().max(80).nullable().optional(),
  severity: z.enum(MONITOR_SEVERITIES).default("warning"),
  run_now: z.boolean().optional(),
});

export const dataMonitorCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      Fail | { ok: true; id: string; first_run: { status: string; message: string } | null }
    > => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      const config = data.config as MonitorConfig;
      const invalid = validateMonitorConfig(data.kind, config);
      if (invalid) return { ok: false, error: invalid };
      if (data.source_kind === "warehouse") {
        if (!data.warehouse_id) return { ok: false, error: "Pick a warehouse connection." };
        const { data: wh } = await supabaseAdmin
          .from("data_warehouse_connections")
          .select("id")
          .eq("id", data.warehouse_id)
          .eq("user_id", caller.userId)
          .maybeSingle();
        if (!wh) return { ok: false, error: "That warehouse connection is not yours." };
      }
      if (data.schedule === "cron" && !data.cron_expr?.trim()) {
        return { ok: false, error: "A cron schedule needs an expression." };
      }
      const name = data.name?.trim() || defaultMonitorName(data.kind, data.table_name, config);
      const nextRun = data.run_now
        ? new Date().toISOString()
        : nextMonitorRunAt(data.schedule, data.cron_expr ?? null, data.timezone ?? null);
      const { data: row, error } = await supabaseAdmin
        .from("data_monitors")
        .insert({
          user_id: caller.userId,
          name,
          source_kind: data.source_kind,
          warehouse_id: data.source_kind === "warehouse" ? data.warehouse_id : null,
          schema_name: data.schema_name,
          table_name: data.table_name,
          kind: data.kind,
          config: config as Json,
          schedule: data.schedule,
          cron_expr: data.schedule === "cron" ? (data.cron_expr ?? null) : null,
          timezone: data.timezone ?? null,
          severity: data.severity,
          next_run_at: nextRun,
        })
        .select("*")
        .single();
      if (error) return { ok: false, error: error.message };
      let first: { status: string; message: string } | null = null;
      if (data.run_now) {
        // The first run doubles as the wizard's "does this check even work"
        // answer, so it happens inline; the schedule takes over from here.
        await supabaseAdmin
          .from("data_monitors")
          .update({
            next_run_at: nextMonitorRunAt(
              data.schedule,
              data.cron_expr ?? null,
              data.timezone ?? null,
            ),
          })
          .eq("id", row.id);
        const res = await runDataMonitor(row as DataMonitorRow, "manual");
        first = { status: res.status, message: res.message };
      }
      return { ok: true, id: row.id, first_run: first };
    },
  );

export const dataMonitorUpdate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        name: z.string().min(1).max(120).optional(),
        config: configSchema.optional(),
        schedule: z.enum(MONITOR_SCHEDULES).optional(),
        cron_expr: z.string().max(120).nullable().optional(),
        timezone: z.string().max(80).nullable().optional(),
        severity: z.enum(MONITOR_SEVERITIES).optional(),
        is_active: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: current } = await supabaseAdmin
      .from("data_monitors")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", caller.userId)
      .maybeSingle();
    if (!current) return { ok: false, error: "Monitor not found" };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.config !== undefined) {
      const invalid = validateMonitorConfig(
        current.kind as (typeof MONITOR_KINDS)[number],
        data.config as MonitorConfig,
      );
      if (invalid) return { ok: false, error: invalid };
      patch.config = data.config as Json;
    }
    if (data.severity !== undefined) patch.severity = data.severity;
    if (data.is_active !== undefined) patch.is_active = data.is_active;
    const schedule = data.schedule ?? current.schedule;
    const cron = data.cron_expr !== undefined ? data.cron_expr : current.cron_expr;
    const tz = data.timezone !== undefined ? data.timezone : current.timezone;
    if (
      data.schedule !== undefined ||
      data.cron_expr !== undefined ||
      data.timezone !== undefined ||
      data.is_active === true
    ) {
      if (schedule === "cron" && !cron?.trim())
        return { ok: false, error: "A cron schedule needs an expression." };
      patch.schedule = schedule;
      patch.cron_expr = schedule === "cron" ? cron : null;
      patch.timezone = tz;
      patch.next_run_at = nextMonitorRunAt(schedule, cron, tz);
    }
    const { error } = await supabaseAdmin
      .from("data_monitors")
      .update(patch as never)
      .eq("id", data.id)
      .eq("user_id", caller.userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const dataMonitorDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { error, count } = await supabaseAdmin
      .from("data_monitors")
      .delete({ count: "exact" })
      .eq("id", data.id)
      .eq("user_id", caller.userId);
    if (error) return { ok: false, error: error.message };
    if (!count) return { ok: false, error: "Monitor not found" };
    return { ok: true };
  });

export const dataMonitorRunNow = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; status: string; message: string }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: m } = await supabaseAdmin
      .from("data_monitors")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", caller.userId)
      .maybeSingle();
    if (!m) return { ok: false, error: "Monitor not found" };
    const res = await runDataMonitor(m as DataMonitorRow, "manual");
    return { ok: true, status: res.status, message: res.message };
  });

export const dataMonitorRuns = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; runs: DataMonitorRunRow[] }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: runs, error } = await supabaseAdmin
      .from("data_monitor_runs")
      .select("*")
      .eq("monitor_id", data.id)
      .eq("user_id", caller.userId)
      .order("ran_at", { ascending: false })
      .limit(data.limit ?? 50);
    if (error) return { ok: false, error: error.message };
    return { ok: true, runs: (runs ?? []) as DataMonitorRunRow[] };
  });

export const dataIncidentUpdate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        action: z.enum(["acknowledge", "resolve"]),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const caller = await resolveCaller(data.access_token);
    if (!caller.ok) return caller;
    const { data: inc } = await supabaseAdmin
      .from("data_incidents")
      .select("id, monitor_id, status, title")
      .eq("id", data.id)
      .eq("user_id", caller.userId)
      .maybeSingle();
    if (!inc) return { ok: false, error: "Incident not found" };
    if (inc.status === "resolved") return { ok: false, error: "This incident is already resolved" };
    const patch =
      data.action === "acknowledge"
        ? {
            status: "acknowledged" as const,
            acknowledged_at: new Date().toISOString(),
            acknowledged_by: caller.userId,
          }
        : {
            status: "resolved" as const,
            resolved_at: new Date().toISOString(),
            resolved_by: "user" as const,
          };
    const { error } = await supabaseAdmin.from("data_incidents").update(patch).eq("id", inc.id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: caller.userId,
      action:
        data.action === "acknowledge" ? "data.incident.acknowledged" : "data.incident.resolved",
      resourceType: "data_monitor",
      resourceId: inc.monitor_id,
      resourceName: inc.title,
      detail: { incident_id: inc.id, by: "user" },
    });
    return { ok: true };
  });
