// Which steps of a tutorial are done, from what the person really made.
//
// The server reads the person's own rows, made since they started the
// tutorial (src/utils/tutorials/progress.server.ts), and these functions say
// what those rows amount to. They are pure so a test can hand them the stored
// shapes: a dashboard whose only widget is on page 2, an analyst that reads
// every dataset, a run that never reached its approval step.
//
// A step is done when the thing it asks for exists, never because an earlier
// step was. Where a step works on what an earlier one made (the dashboard of
// step 1, the table of step 1), it reads only those: a KPI on some other
// dashboard does not count.
import { allDashboardWidgets } from "@/lib/biDashboards";
import { STAGING_PREFIX } from "@/lib/datasetParse";
import { dashboardsUsingTable } from "@/lib/datasetDependents";
import { objectKind, type ObjectKindId, type ObjectLink } from "@/lib/objectKinds";
import { SALES_TABLE, SHIPMENTS_TABLE, type TutorialId } from "@/lib/tutorials";

/** Something a tutorial made, to name and link at the end. */
export type TutorialMade = { label: string; name: string; link: ObjectLink };

/**
 * A sentence about one step: how it is going, or what stands in its way. Only
 * a problem is drawn as a warning; a step under way is not one.
 */
export type TutorialNote = { text: string; tone: "progress" | "problem" };
const progress = (text: string): TutorialNote => ({ text, tone: "progress" });
const problem = (text: string): TutorialNote => ({ text, tone: "problem" });

export type TutorialProgress = {
  done: boolean[];
  /** By step: a step under way or in trouble says so. */
  notes: (TutorialNote | null)[];
  /** Where a step is best done now, when it works on something already made. */
  links: (ObjectLink | null)[];
  made: TutorialMade[];
};

// ── Stored shapes, as far as the checks read them ─────────────────────────

export type AnalystRow = { id: string; name: string; source: unknown };
export type AnalystThreadRow = { id: string; analyst_id: string; title: string; turns: unknown };
export type AnalystScheduleRow = { thread_id: string; enabled: boolean };
export type DashboardRow = { id: string; name: string; widgets: unknown; pages?: unknown };
export type DashboardScheduleRow = {
  dashboard_id: string;
  enabled: boolean;
  email_report: boolean;
};
export type RestSourceRow = {
  id: string;
  name: string;
  sync_schedule: string;
  last_sync_status: string | null;
  last_sync_error: string | null;
};
export type SyncedDatasetRow = { id: string; name: string; saas_connection_id: string | null };
/** A dataset brought into the lakehouse (from the audit trail). */
export type LakeImportRow = { table: string; source: string };
export type MonitorRow = {
  id: string;
  name: string;
  source_kind: string;
  schema_name: string | null;
  table_name: string;
};
export type MonitorRunRow = { monitor_id: string };
export type ModelRow = {
  id: string;
  name: string;
  task: string;
  source: unknown;
  production_version_id: string | null;
};
export type ModelVersionRow = { model_id: string; status: string };
export type SwarmRow = { id: string; name: string; nodes: unknown };
export type SwarmRunRow = {
  id: string;
  swarm_id: string | null;
  swarm_snapshot: unknown;
  status: string;
};
export type ApprovalRow = { swarm_run_id: string | null; decided_at: string | null };

export type TutorialRows =
  | {
      tutorial: "ask_analyst";
      analysts: AnalystRow[];
      threads: AnalystThreadRow[];
      schedules: AnalystScheduleRow[];
    }
  | { tutorial: "dashboard"; dashboards: DashboardRow[]; schedules: DashboardScheduleRow[] }
  | {
      tutorial: "rest_api";
      sources: RestSourceRow[];
      datasets: SyncedDatasetRow[];
      dashboards: DashboardRow[];
    }
  | {
      tutorial: "lake_watch";
      imports: LakeImportRow[];
      monitors: MonitorRow[];
      runs: MonitorRunRow[];
    }
  | {
      tutorial: "forecast";
      /** Lakehouse tables made from the sample shipments that still exist, at any time. */
      tables: string[];
      models: ModelRow[];
      versions: ModelVersionRow[];
    }
  | {
      tutorial: "swarm_approval";
      swarms: SwarmRow[];
      runs: SwarmRunRow[];
      approvals: ApprovalRow[];
    };

// ── Helpers ───────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function made(kind: ObjectKindId, row: { id: string; name: string; parentId?: string }) {
  const k = objectKind(kind);
  return { label: k.label, name: row.name, link: k.open(row) } satisfies TutorialMade;
}

/** An analyst over the local datasets that can read `table`. */
export function analystReads(source: unknown, table: string): boolean {
  if (!isObj(source) || source.kind !== "local") return false;
  const tables = Array.isArray(source.tables) ? source.tables : [];
  // No tables named means every local dataset, the samples among them.
  return tables.length === 0 || tables.some((t) => typeof t === "string" && same(t, table));
}

/** A conversation in which at least one question got an answer. */
export function threadAnswered(turns: unknown): boolean {
  return (
    Array.isArray(turns) &&
    turns.some((t) => isObj(t) && typeof t.answer === "string" && t.answer.trim() !== "")
  );
}

/** A dashboard with a KPI card and at least one other chart, on any page. */
export function hasKpiAndChart(row: { widgets: unknown; pages?: unknown }): boolean {
  let kpi = false;
  let chart = false;
  for (const w of allDashboardWidgets(row)) {
    if (!isObj(w) || w.kind !== "chart" || !isObj(w.chart)) continue;
    if (w.chart.type === "kpi") kpi = true;
    else if (typeof w.chart.type === "string") chart = true;
  }
  return kpi && chart;
}

/** schema.table, as the lakehouse names a table. */
export function lakeTable(schema: string | null, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

/** A model's lakehouse table as schema.table, or null. */
export function modelTable(source: unknown): string | null {
  if (!isObj(source) || source.kind !== "lakehouse") return null;
  if (typeof source.schema !== "string" || typeof source.table !== "string") return null;
  return `${source.schema}.${source.table}`;
}

/** A swarm, or a run's copy of one, with a step that waits for a person. */
export function hasApprovalStep(nodes: unknown): boolean {
  return (
    Array.isArray(nodes) &&
    nodes.some(
      (n) => isObj(n) && (n.type === "approval" || (isObj(n.data) && n.data.kind === "approval")),
    )
  );
}

function snapshotNodes(snapshot: unknown): unknown {
  return isObj(snapshot) ? snapshot.nodes : undefined;
}

const NONE = <T>(n: number, v: T) => Array.from({ length: n }, () => v);

// ── One check per tutorial ────────────────────────────────────────────────

function askAnalyst(r: Extract<TutorialRows, { tutorial: "ask_analyst" }>): TutorialProgress {
  const readers = r.analysts.filter((a) => analystReads(a.source, SALES_TABLE));
  const readerIds = new Set(readers.map((a) => a.id));
  const ofReaders = r.threads.filter((t) => readerIds.has(t.analyst_id));
  const answered = ofReaders.filter((t) => threadAnswered(t.turns));
  const answeredIds = new Set(answered.map((t) => t.id));
  const scheduled = r.schedules.filter((s) => s.enabled && answeredIds.has(s.thread_id));

  const notes = NONE<TutorialNote | null>(3, null);
  if (!answered.length && ofReaders.length) {
    notes[1] = progress("A conversation was started, but no question in it has an answer yet.");
  }
  const links = NONE<ObjectLink | null>(3, null);
  if (readers[0]) links[1] = objectKind("ai_analyst").open(readers[0]);
  if (answered[0]) {
    links[2] = objectKind("analysis").open({
      ...answered[0],
      name: answered[0].title,
      parentId: answered[0].analyst_id,
    });
  }
  return {
    done: [readers.length > 0, answered.length > 0, scheduled.length > 0],
    notes,
    links,
    made: [
      ...readers.map((a) => made("ai_analyst", a)),
      ...answered.map((t) => made("analysis", { id: t.id, name: t.title, parentId: t.analyst_id })),
    ],
  };
}

function dashboard(r: Extract<TutorialRows, { tutorial: "dashboard" }>): TutorialProgress {
  const readIds = new Set(dashboardsUsingTable(r.dashboards, SALES_TABLE).map((d) => d.id));
  const onSales = r.dashboards.filter((d) => readIds.has(d.id));
  const onSalesIds = new Set(onSales.map((d) => d.id));
  const withVisuals = onSales.filter(hasKpiAndChart);
  const emailed = r.schedules.filter(
    (s) => s.enabled && s.email_report && onSalesIds.has(s.dashboard_id),
  );
  const notes = NONE<TutorialNote | null>(3, null);
  if (
    !emailed.length &&
    r.schedules.some((s) => onSalesIds.has(s.dashboard_id) && s.enabled && !s.email_report)
  ) {
    notes[2] = problem("The dashboard is scheduled, but the email is off.");
  }
  const first = withVisuals[0] ?? onSales[0];
  const open = first ? objectKind("dashboard").open(first) : null;
  const links: (ObjectLink | null)[] = [null, open, open];
  // A project made but not yet charted: back to it, not to a second new one.
  const started = startedDashboard(r.dashboards, onSales.length > 0);
  if (started) {
    links[0] = started;
    notes[0] = progress(`The project is made. It counts once a chart on it reads ${SALES_TABLE}.`);
  }
  return {
    done: [onSales.length > 0, withVisuals.length > 0, emailed.length > 0],
    notes,
    links,
    made: onSales.map((d) => made("dashboard", d)),
  };
}

/**
 * The newest project made since the start, while none counts yet. The rows
 * come newest first; without this the guide offers New BI project again to
 * someone already inside the one they just made.
 */
function startedDashboard(dashboards: DashboardRow[], counted: boolean): ObjectLink | null {
  if (counted || !dashboards[0]) return null;
  return objectKind("dashboard").open(dashboards[0]);
}

function restApi(r: Extract<TutorialRows, { tutorial: "rest_api" }>): TutorialProgress {
  const ids = new Set(r.sources.map((s) => s.id));
  // A sync writes into a staging dataset first and renames it when the whole
  // stream is in, so a `__upload_` row is a sync still running, not a dataset.
  const synced = r.datasets.filter(
    (d) =>
      d.saas_connection_id && ids.has(d.saas_connection_id) && !d.name.startsWith(STAGING_PREFIX),
  );
  const syncedFrom = new Set(synced.map((d) => d.saas_connection_id));
  const kept = r.sources.filter((s) => s.sync_schedule !== "manual" && syncedFrom.has(s.id));
  const keptIds = new Set(kept.map((s) => s.id));
  const keptSets = synced.filter((d) => keptIds.has(d.saas_connection_id!));
  const charted = new Map<string, { id: string; name: string }>();
  for (const d of keptSets) {
    for (const dash of dashboardsUsingTable(r.dashboards, d.name)) charted.set(dash.id, dash);
  }

  const notes = NONE<TutorialNote | null>(3, null);
  if (r.sources.length && !kept.length) {
    const failed = r.sources.find((s) => s.last_sync_status && s.last_sync_status !== "ok");
    if (synced.length) {
      notes[1] = problem(
        "It synced, but only syncs when asked. Edit the source and set Sync automatically to Every day.",
      );
    } else if (failed?.last_sync_error) {
      notes[1] = problem(`The sync did not finish: ${failed.last_sync_error.slice(0, 160)}`);
    } else {
      notes[1] = progress("Syncing. This ticks when the releases are in.");
    }
  }
  const links = NONE<ObjectLink | null>(3, null);
  const started = kept.length ? startedDashboard(r.dashboards, charted.size > 0) : null;
  if (started) {
    links[2] = started;
    notes[2] = progress(
      "The project is made. It counts once a chart on it reads the releases dataset.",
    );
  }
  const apps: ObjectLink = { to: "/integrations", search: { tab: "apps" } };
  return {
    done: [r.sources.length > 0, kept.length > 0, charted.size > 0],
    notes,
    links,
    made: [
      ...r.sources.map((s) => ({ label: "App source", name: s.name, link: apps })),
      ...synced.map((d) => made("dataset", d)),
      ...[...charted.values()].map((d) => made("dashboard", d)),
    ],
  };
}

function lakeWatch(r: Extract<TutorialRows, { tutorial: "lake_watch" }>): TutorialProgress {
  const tables = [
    ...new Set(r.imports.filter((i) => same(i.source, SHIPMENTS_TABLE)).map((i) => i.table)),
  ];
  const watching = r.monitors.filter(
    (m) =>
      m.source_kind === "lakehouse" &&
      tables.some((t) => same(t, lakeTable(m.schema_name, m.table_name))),
  );
  const watchingIds = new Set(watching.map((m) => m.id));
  const ran = r.runs.some((run) => watchingIds.has(run.monitor_id));
  const links = NONE<ObjectLink | null>(3, null);
  if (watching[0]) links[2] = objectKind("data_monitor").open(watching[0]);
  return {
    done: [tables.length > 0, watching.length > 0, ran],
    notes: NONE(3, null),
    links,
    made: [
      ...tables.map((t) => made("lakehouse_table", { id: t, name: t })),
      ...watching.map((m) => made("data_monitor", m)),
    ],
  };
}

function forecast(r: Extract<TutorialRows, { tutorial: "forecast" }>): TutorialProgress {
  const models = r.models.filter((m) => {
    const t = m.task === "forecast" ? modelTable(m.source) : null;
    return t !== null && r.tables.some((x) => same(x, t));
  });
  const versionsOf = (id: string) => r.versions.filter((v) => v.model_id === id);
  const ready = models.filter((m) => versionsOf(m.id).some((v) => v.status === "ready"));
  const live = models.filter((m) => m.production_version_id);

  const notes = NONE<TutorialNote | null>(3, null);
  if (!ready.length && models.length) {
    const all = models.flatMap((m) => versionsOf(m.id));
    notes[1] = all.some((v) => v.status === "training")
      ? progress(
          "Training has started. This ticks when a version is ready, usually within a few minutes.",
        )
      : problem(
          "Its training did not finish. The log is on the model's Jobs tab; train it again from there.",
        );
  }
  const first = live[0] ?? ready[0] ?? models[0];
  const open = first ? objectKind("ml_model").open(first) : null;
  return {
    done: [r.tables.length > 0, ready.length > 0, live.length > 0],
    notes,
    links: [null, ready.length ? null : open, open],
    made: [
      ...r.tables.map((t) => made("lakehouse_table", { id: t, name: t })),
      ...models.map((m) => made("ml_model", m)),
    ],
  };
}

function swarmApproval(r: Extract<TutorialRows, { tutorial: "swarm_approval" }>): TutorialProgress {
  const copies = r.swarms.filter((s) => hasApprovalStep(s.nodes));
  const copyIds = new Set(copies.map((s) => s.id));
  // A run counts when it is of a copy, or carries an approval step of its own:
  // a run from the unsaved sample is still a run of it.
  const runs = r.runs.filter(
    (run) =>
      (run.swarm_id !== null && copyIds.has(run.swarm_id)) ||
      hasApprovalStep(snapshotNodes(run.swarm_snapshot)),
  );
  const runIds = new Set(runs.map((run) => run.id));
  const asked = r.approvals.filter((a) => a.swarm_run_id && runIds.has(a.swarm_run_id));
  const answered = asked.filter((a) => a.decided_at);

  const notes = NONE<TutorialNote | null>(3, null);
  if (!answered.length && asked.length) {
    notes[2] = progress("It is waiting for you in the approvals inbox.");
  } else if (!asked.length && runs.some((run) => run.status !== "running")) {
    notes[2] = problem(
      "The run finished without reaching its approval step. A billing question takes the route that asks first.",
    );
  }
  const links = NONE<ObjectLink | null>(3, null);
  if (copies[0]) links[1] = objectKind("swarm").open(copies[0]);
  return {
    done: [copies.length > 0, runs.length > 0, answered.length > 0],
    notes,
    links,
    made: copies.map((s) => made("swarm", s)),
  };
}

/** What the person's rows amount to, for the tutorial they belong to. */
export function tutorialProgress(rows: TutorialRows): TutorialProgress {
  switch (rows.tutorial) {
    case "ask_analyst":
      return askAnalyst(rows);
    case "dashboard":
      return dashboard(rows);
    case "rest_api":
      return restApi(rows);
    case "lake_watch":
      return lakeWatch(rows);
    case "forecast":
      return forecast(rows);
    case "swarm_approval":
      return swarmApproval(rows);
  }
}

/** Every tutorial has a check: a compile-time list the tests also walk. */
export const CHECKED_TUTORIALS: Record<TutorialId, true> = {
  ask_analyst: true,
  dashboard: true,
  rest_api: true,
  lake_watch: true,
  forecast: true,
  swarm_approval: true,
};
