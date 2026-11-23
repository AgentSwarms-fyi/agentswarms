// Which tutorial steps are done (R529), from stored row shapes: each step
// ticks for the thing it asks for and nothing near it.
import { describe, expect, it } from "vitest";

import {
  analystReads,
  hasApprovalStep,
  hasKpiAndChart,
  tutorialProgress,
  type TutorialRows,
} from "@/lib/tutorialChecks";

const kpi = (sql: string) => ({
  id: "k",
  kind: "chart",
  title: "Total",
  sql,
  chart: { type: "kpi" },
});
const bar = (sql: string) => ({
  id: "b",
  kind: "chart",
  title: "By region",
  sql,
  chart: { type: "bar" },
});
const SALES_SQL = 'SELECT "Region", SUM("Sales") FROM saas_sales GROUP BY 1';

describe("Ask your data a question", () => {
  const base = (over: Partial<Extract<TutorialRows, { tutorial: "ask_analyst" }>> = {}) =>
    tutorialProgress({
      tutorial: "ask_analyst",
      analysts: [{ id: "a1", name: "Sales", source: { kind: "local", tables: ["saas_sales"] } }],
      threads: [],
      schedules: [],
      ...over,
    });

  it("counts an analyst on the sales, or on every dataset, and no other", () => {
    expect(analystReads({ kind: "local", tables: [] }, "saas_sales")).toBe(true);
    expect(analystReads({ kind: "local", tables: ["SAAS_SALES"] }, "saas_sales")).toBe(true);
    expect(analystReads({ kind: "local", tables: ["siem_alerts"] }, "saas_sales")).toBe(false);
    expect(analystReads({ kind: "warehouse", connection_id: "w" }, "saas_sales")).toBe(false);
    expect(base().done).toEqual([true, false, false]);
  });

  it("ticks the question only once it has an answer, and says so meanwhile", () => {
    const unanswered = base({
      threads: [{ id: "t1", analyst_id: "a1", title: "Q", turns: [{ answer: null }] }],
    });
    expect(unanswered.done).toEqual([true, false, false]);
    expect(unanswered.notes[1]?.text).toMatch(/no question in it has an answer/);
    const answered = base({
      threads: [{ id: "t1", analyst_id: "a1", title: "Q", turns: [{ answer: "EMEA, by 12%." }] }],
    });
    expect(answered.done).toEqual([true, true, false]);
    expect(answered.links[2]).toEqual({ to: "/ai-analyst", search: { thread: "t1", open: "a1" } });
  });

  it("does not count a question asked of another analyst", () => {
    const other = base({
      threads: [{ id: "t1", analyst_id: "zz", title: "Q", turns: [{ answer: "x" }] }],
    });
    expect(other.done[1]).toBe(false);
  });

  it("ticks the schedule only when it is on, on the answered conversation", () => {
    const threads = [{ id: "t1", analyst_id: "a1", title: "Q", turns: [{ answer: "x" }] }];
    expect(base({ threads, schedules: [{ thread_id: "t1", enabled: false }] }).done[2]).toBe(false);
    expect(base({ threads, schedules: [{ thread_id: "t9", enabled: true }] }).done[2]).toBe(false);
    expect(base({ threads, schedules: [{ thread_id: "t1", enabled: true }] }).done).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("Build a dashboard that comes to you", () => {
  const dash = (widgets: unknown[], pages?: unknown) => ({
    id: "d1",
    name: "Sales",
    widgets,
    pages,
  });

  it("counts a dashboard reading the sales on any page, and not a table with a longer name", () => {
    const onPage2 = dash(
      [],
      [
        { id: "p1", widgets: [] },
        { id: "p2", widgets: [kpi(SALES_SQL)] },
      ],
    );
    expect(
      tutorialProgress({ tutorial: "dashboard", dashboards: [onPage2], schedules: [] }).done[0],
    ).toBe(true);
    const archive = dash([kpi("SELECT count(*) FROM saas_sales_archive")]);
    expect(
      tutorialProgress({ tutorial: "dashboard", dashboards: [archive], schedules: [] }).done[0],
    ).toBe(false);
  });

  it("needs a KPI and another chart on that dashboard", () => {
    expect(hasKpiAndChart(dash([kpi(SALES_SQL)]))).toBe(false);
    expect(hasKpiAndChart(dash([bar(SALES_SQL), bar(SALES_SQL)]))).toBe(false);
    expect(hasKpiAndChart(dash([kpi(SALES_SQL), bar(SALES_SQL)]))).toBe(true);
    // A KPI on some other dashboard does not count.
    const p = tutorialProgress({
      tutorial: "dashboard",
      dashboards: [
        dash([bar(SALES_SQL)]),
        { id: "d2", name: "Other", widgets: [kpi("SELECT 1 FROM x"), bar("SELECT 1 FROM x")] },
      ],
      schedules: [],
    });
    expect(p.done).toEqual([true, false, false]);
    expect(p.links[1]).toEqual({ to: "/bi/d1" });
  });

  it("ticks the email only when the schedule is on and sends it, and says when it does not", () => {
    const d = dash([kpi(SALES_SQL), bar(SALES_SQL)]);
    const off = tutorialProgress({
      tutorial: "dashboard",
      dashboards: [d],
      schedules: [{ dashboard_id: "d1", enabled: true, email_report: false }],
    });
    expect(off.done).toEqual([true, true, false]);
    expect(off.notes[2]?.text).toMatch(/email is off/);
    const on = tutorialProgress({
      tutorial: "dashboard",
      dashboards: [d],
      schedules: [{ dashboard_id: "d1", enabled: true, email_report: true }],
    });
    expect(on.done).toEqual([true, true, true]);
    expect(on.made).toEqual([{ label: "Dashboard", name: "Sales", link: { to: "/bi/d1" } }]);
  });

  it("points back to a project made but not charted yet, not to a second new one", () => {
    // Seen in the R529 browser test: inside the new project, the guide still
    // offered New BI project.
    const empty = tutorialProgress({
      tutorial: "dashboard",
      dashboards: [
        { id: "d9", name: "Newest", widgets: [] },
        { id: "d8", name: "Older", widgets: [] },
      ],
      schedules: [],
    });
    expect(empty.done).toEqual([false, false, false]);
    expect(empty.links[0]).toEqual({ to: "/bi/d9" });
    expect(empty.notes[0]?.text).toMatch(/counts once a chart on it reads saas_sales/);
    const counted = tutorialProgress({
      tutorial: "dashboard",
      dashboards: [dash([bar(SALES_SQL)])],
      schedules: [],
    });
    expect(counted.links[0]).toBeNull();
    expect(counted.notes[0]).toBeNull();
  });
});

describe("Bring in data from an API", () => {
  const src = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    name: "GitHub cli",
    sync_schedule: "daily",
    last_sync_status: null,
    last_sync_error: null,
    ...over,
  });
  const releases = { id: "ds1", name: "github_cli_releases", saas_connection_id: "s1" };
  const RELEASES_SQL =
    "SELECT substr(published_at, 1, 7) AS m, COUNT(*) FROM github_cli_releases GROUP BY 1";
  const base = (over: Partial<Extract<TutorialRows, { tutorial: "rest_api" }>> = {}) =>
    tutorialProgress({
      tutorial: "rest_api",
      sources: [src()],
      datasets: [],
      dashboards: [],
      ...over,
    });

  it("counts the source, then a dataset synced from it that keeps syncing, then a chart of it", () => {
    const syncing = base();
    expect(syncing.done).toEqual([true, false, false]);
    expect(syncing.notes[1]).toEqual({
      text: "Syncing. This ticks when the releases are in.",
      tone: "progress",
    });

    const synced = base({
      datasets: [{ id: "x", name: "other_rows", saas_connection_id: "s9" }, releases],
    });
    expect(synced.done).toEqual([true, true, false]);

    const charted = base({
      datasets: [releases],
      dashboards: [
        { id: "d0", name: "Sales", widgets: [bar(SALES_SQL)] },
        { id: "d1", name: "Releases", widgets: [bar(RELEASES_SQL)] },
      ],
    });
    expect(charted.done).toEqual([true, true, true]);
    expect(charted.made.map((m) => m.name)).toEqual([
      "GitHub cli",
      "github_cli_releases",
      "Releases",
    ]);
  });

  it("does not count a sync still writing into its staging dataset", () => {
    // Seen in the R529 browser test: the guide named `__upload_…` as the dataset.
    const p = base({
      datasets: [{ id: "st", name: "__upload_b7935da466f54bbfb65cde1b", saas_connection_id: "s1" }],
    });
    expect(p.done).toEqual([true, false, false]);
    expect(p.made.map((m) => m.label)).toEqual(["App source"]);
  });

  it("asks for a schedule when the source syncs only by hand, and says why a sync failed", () => {
    const manual = base({ sources: [src({ sync_schedule: "manual" })], datasets: [releases] });
    expect(manual.done).toEqual([true, false, false]);
    expect(manual.notes[1]?.text).toMatch(/Every day/);
    expect(manual.notes[1]?.tone).toBe("problem");

    const failed = base({
      sources: [src({ last_sync_status: "partial", last_sync_error: "releases: HTTP 404" })],
    });
    expect(failed.done[1]).toBe(false);
    expect(failed.notes[1]).toEqual({
      text: "The sync did not finish: releases: HTTP 404",
      tone: "problem",
    });
  });

  it("does not tick the chart for a dashboard on some other table", () => {
    const p = base({
      sources: [src({ sync_schedule: "manual" })],
      datasets: [releases],
      dashboards: [{ id: "d1", name: "Releases", widgets: [bar(RELEASES_SQL)] }],
    });
    // A chart of a dataset that is not kept current is not the outcome promised.
    expect(p.done[2]).toBe(false);
    const elsewhere = base({
      datasets: [releases],
      dashboards: [{ id: "d0", name: "Sales", widgets: [bar(SALES_SQL)] }],
    });
    expect(elsewhere.done[2]).toBe(false);
    // ...but it is the project to go back to and chart the releases on.
    expect(elsewhere.links[2]).toEqual({ to: "/bi/d0" });
    expect(elsewhere.notes[2]?.text).toMatch(/reads the releases dataset/);
  });
});

describe("Watch a table for problems", () => {
  const monitor = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    name: "Shipments volume",
    source_kind: "lakehouse",
    schema_name: "learn",
    table_name: "shipments",
    ...over,
  });

  it("counts only the shipments brought in, and a check on that table", () => {
    const other = tutorialProgress({
      tutorial: "lake_watch",
      imports: [{ table: "learn.sales", source: "saas_sales" }],
      monitors: [monitor({ table_name: "sales" })],
      runs: [{ monitor_id: "m1" }],
    });
    expect(other.done).toEqual([false, false, false]);
    const p = tutorialProgress({
      tutorial: "lake_watch",
      imports: [{ table: "learn.Shipments", source: "supply_shipments" }],
      monitors: [monitor(), monitor({ id: "m2", source_kind: "warehouse" })],
      runs: [],
    });
    expect(p.done).toEqual([true, true, false]);
    expect(p.links[2]).toEqual({ to: "/data-monitors", search: { open: "m1" } });
  });

  it("ticks the run only for that check", () => {
    const rows = {
      imports: [{ table: "learn.shipments", source: "supply_shipments" }],
      monitors: [monitor()],
    };
    expect(
      tutorialProgress({ tutorial: "lake_watch", ...rows, runs: [{ monitor_id: "m9" }] }).done[2],
    ).toBe(false);
    expect(
      tutorialProgress({ tutorial: "lake_watch", ...rows, runs: [{ monitor_id: "m1" }] }).done,
    ).toEqual([true, true, true]);
  });
});

describe("Forecast next quarter's orders", () => {
  const model = (over: Record<string, unknown> = {}) => ({
    id: "f1",
    name: "Weekly orders",
    task: "forecast",
    source: { kind: "lakehouse", schema: "learn", table: "shipments" },
    production_version_id: null,
    ...over,
  });

  it("counts a forecast of the shipments table only", () => {
    const wrong = tutorialProgress({
      tutorial: "forecast",
      tables: ["learn.shipments"],
      models: [
        model({ source: { kind: "lakehouse", schema: "learn", table: "other" } }),
        model({ id: "c1", task: "classification" }),
      ],
      versions: [
        { model_id: "f1", status: "ready" },
        { model_id: "c1", status: "ready" },
      ],
    });
    expect(wrong.done).toEqual([true, false, false]);
    expect(
      tutorialProgress({ tutorial: "forecast", tables: [], models: [model()], versions: [] })
        .done[0],
    ).toBe(false);
  });

  it("says training is under way, or did not finish, until a version is ready", () => {
    const training = tutorialProgress({
      tutorial: "forecast",
      tables: ["learn.shipments"],
      models: [model()],
      versions: [{ model_id: "f1", status: "training" }],
    });
    expect(training.done).toEqual([true, false, false]);
    expect(training.notes[1]?.text).toMatch(/Training has started/);
    expect(training.links[1]).toEqual({ to: "/ml/f1" });
    const failed = tutorialProgress({
      tutorial: "forecast",
      tables: ["learn.shipments"],
      models: [model()],
      versions: [{ model_id: "f1", status: "failed" }],
    });
    expect(failed.notes[1]?.text).toMatch(/did not finish/);
  });

  it("ticks production when a version is promoted", () => {
    const live = tutorialProgress({
      tutorial: "forecast",
      tables: ["learn.shipments"],
      models: [model({ production_version_id: "v1" })],
      versions: [{ model_id: "f1", status: "ready" }],
    });
    expect(live.done).toEqual([true, true, true]);
  });
});

describe("Run a swarm that asks before it acts", () => {
  const approvalNode = { id: "approval", type: "approval", data: { kind: "approval" } };
  const swarm = {
    id: "s1",
    name: "Support Copilot",
    nodes: [{ id: "in", type: "input" }, approvalNode],
  };

  it("counts a swarm with a step that waits for a person, and no other", () => {
    expect(hasApprovalStep(swarm.nodes)).toBe(true);
    expect(hasApprovalStep([{ id: "a", type: "agent", data: { kind: "agent" } }])).toBe(false);
    expect(hasApprovalStep(null)).toBe(false);
    const plain = tutorialProgress({
      tutorial: "swarm_approval",
      swarms: [{ id: "s2", name: "Plain", nodes: [{ id: "a", type: "agent" }] }],
      runs: [],
      approvals: [],
    });
    expect(plain.done).toEqual([false, false, false]);
  });

  it("counts a run of the unsaved sample, and says when it is waiting", () => {
    const p = tutorialProgress({
      tutorial: "swarm_approval",
      swarms: [],
      runs: [
        { id: "r1", swarm_id: null, swarm_snapshot: { nodes: [approvalNode] }, status: "waiting" },
      ],
      approvals: [{ swarm_run_id: "r1", decided_at: null }],
    });
    expect(p.done).toEqual([false, true, false]);
    expect(p.notes[2]?.text).toMatch(/waiting for you/);
  });

  it("says when a finished run never reached its approval step", () => {
    const p = tutorialProgress({
      tutorial: "swarm_approval",
      swarms: [swarm],
      runs: [{ id: "r1", swarm_id: "s1", swarm_snapshot: {}, status: "completed" }],
      approvals: [],
    });
    expect(p.done).toEqual([true, true, false]);
    expect(p.notes[2]?.text).toMatch(/billing question/);
  });

  it("ticks the answer once the approval is decided, either way", () => {
    const p = tutorialProgress({
      tutorial: "swarm_approval",
      swarms: [swarm],
      runs: [{ id: "r1", swarm_id: "s1", swarm_snapshot: {}, status: "completed" }],
      approvals: [
        { swarm_run_id: "other", decided_at: "2026-11-23T10:00:00Z" },
        { swarm_run_id: "r1", decided_at: "2026-11-23T10:05:00Z" },
      ],
    });
    expect(p.done).toEqual([true, true, true]);
    expect(p.made).toEqual([
      {
        label: "Swarm",
        name: "Support Copilot",
        link: { to: "/swarms", search: { swarm: "s1", view: "canvas" } },
      },
    ]);
  });
});
