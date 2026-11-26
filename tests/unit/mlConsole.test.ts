// The Data science pages that look across models (R538): what Model serving
// says about each endpoint and what ML operations puts in front of a person.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  attentionItems,
  copiesLine,
  duration,
  endpointState,
  errorLead,
  lastRunOutcome,
  nextRunLine,
  sortEndpoints,
  trafficLine,
  waitingReason,
  type EndpointView,
} from "@/lib/mlConsole";
import { ALL_NAV_GROUPS, NAV_GROUPS, navGroupForPath, navItemForPath } from "@/lib/appNav";

const rd = (p: string) => readFileSync(p, "utf8");
const NOW = new Date("2026-11-25T12:00:00Z").getTime();

const ep = (over: Partial<EndpointView> = {}): EndpointView => ({
  model: { id: "m1", name: "churn", task: "classification", shared: false, production_version: 3 },
  deployment_id: "d1",
  status: "ready",
  version: 3,
  stale: false,
  keep_warm: false,
  min_replicas: 1,
  max_replicas: 3,
  request_count: 120,
  last_used_at: "2026-11-25T11:00:00Z",
  last_error: null,
  candidate: { mode: "off", version: null, percent: null },
  rollback: null,
  copies: { ready: 1, starting: 0 },
  runs_on: { kind: "sandboxes" },
  ...over,
});

describe("an endpoint's state", () => {
  it("leads with what is wrong, then what it is doing", () => {
    expect(endpointState(ep(), NOW)).toEqual({ tone: "ok", label: "Serving", detail: null });
    expect(endpointState(ep({ status: "failed", last_error: "OOMKilled" }), NOW)).toMatchObject({
      tone: "bad",
      label: "Failed",
      detail: "OOMKilled",
    });
    expect(endpointState(ep({ stale: true, version: 2 }), NOW)).toMatchObject({
      tone: "warn",
      label: "Behind production",
      detail: "Serves v2; production is v3.",
    });
    expect(
      endpointState(
        ep({ rollback: { at: "2026-11-24T12:00:00Z", reason: "errors rose to 12%" } }),
        NOW,
      ),
    ).toMatchObject({
      tone: "warn",
      label: "Rolled back",
      detail: "A canary was rolled back: errors rose to 12%.",
    });
    // A rollback a fortnight ago is history, not something to look at now.
    expect(
      endpointState(ep({ rollback: { at: "2026-11-10T12:00:00Z", reason: null } }), NOW).label,
    ).toBe("Serving");
    expect(endpointState(ep({ copies: { ready: 0, starting: 0 } }), NOW)).toMatchObject({
      tone: "idle",
      label: "Asleep",
    });
    // KServe keeps its own pods; zero ready there is the cluster's to explain.
    expect(
      endpointState(
        ep({
          copies: { ready: 0, starting: 0 },
          runs_on: { kind: "kserve", namespace: "s", name: "x" },
        }),
        NOW,
      ).label,
    ).toBe("Serving");
    expect(endpointState(ep({ status: "starting" }), NOW).label).toBe("Starting");
  });

  it("says how traffic splits, and how many copies run", () => {
    expect(trafficLine(ep())).toBe("v3 takes every request");
    expect(trafficLine(ep({ candidate: { mode: "shadow", version: 4, percent: null } }))).toBe(
      "v3 answers; v4 sees every request as a shadow and answers none",
    );
    expect(trafficLine(ep({ candidate: { mode: "canary", version: 4, percent: 10 } }))).toBe(
      "v3 takes 90%; v4 takes 10% as a canary",
    );
    expect(copiesLine(ep({ copies: { ready: 2, starting: 1 } }))).toBe(
      "2 running, 1 starting (1 to 3)",
    );
    expect(copiesLine(ep({ copies: { ready: 0, starting: 0 } }))).toBe("Scaled to zero");
    expect(
      copiesLine(
        ep({
          copies: { ready: 2, starting: 0 },
          runs_on: { kind: "kserve", namespace: "s", name: "x" },
        }),
      ),
    ).toBe("2 running");
  });

  it("lists what needs a look first, then the busiest", () => {
    const rows = sortEndpoints(
      [
        ep({ deployment_id: "busy", request_count: 900 }),
        ep({ deployment_id: "quiet", request_count: 3 }),
        ep({ deployment_id: "failed", status: "failed" }),
        ep({ deployment_id: "stopped", status: "stopped", request_count: 10_000 }),
        ep({ deployment_id: "stale", stale: true, version: 1 }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.deployment_id)).toEqual([
      "failed",
      "stale",
      "busy",
      "quiet",
      "stopped",
    ]);
  });
});

describe("what ML operations puts first", () => {
  it("reads the reason off a stored error, which leads with it", () => {
    expect(
      errorLead(
        "The model file needs types this platform does not open: posix.system\n\nTraceback…",
      ),
    ).toBe("The model file needs types this platform does not open: posix.system");
    expect(errorLead(null)).toBe("It ended without saying why.");
    // A job that failed before R536 stored the bare traceback: its reason is
    // the last line (the R538 UI test showed "Traceback (most recent call last):").
    const tb = [
      "Traceback (most recent call last):",
      '  File "/opt/agentswarms/batch_runner.py", line 88, in main',
      "    result = entrypoint(inputs)",
      "RuntimeError: The model file needs types this platform does not open: posix.system",
    ].join("\n");
    expect(errorLead(tb)).toBe(
      "The model file needs types this platform does not open: posix.system",
    );
    expect(errorLead(tb.replace("RuntimeError", "ValueError"))).toBe(
      "ValueError: The model file needs types this platform does not open: posix.system",
    );
    expect(errorLead("x".repeat(500))).toHaveLength(240);
  });

  it("knows a job is waiting for a node until something after the wait is logged", () => {
    const wait =
      "── waiting to start: Waiting for a node with a free GPU: 0/3 nodes are available ──\n";
    expect(waitingReason(wait)).toBe("Waiting for a node with a free GPU: 0/3 nodes are available");
    expect(waitingReason(`${wait}[ml] job 1234: classification on main.accounts`)).toBeNull();
    expect(waitingReason(null)).toBeNull();
    // The writer and the reader agree on the marker.
    expect(rd("src/utils/ml/train.server.ts")).toContain(
      "── waiting to start: ${fresh.pending_reason} ──",
    );
  });

  it("puts failures before warnings, newest first, each pointing at the tab with the detail", () => {
    const items = attentionItems({
      names: new Map([
        ["m1", "churn"],
        ["m2", "demand"],
      ]),
      failedJobs: [
        {
          id: "j1",
          model_id: "m1",
          version: 7,
          status: "failed",
          trigger: "manual",
          error:
            "Only 12 rows have a value in churned; at least 20 are needed to train.\n\nTraceback",
          created_at: "2026-11-24T10:00:00Z",
          started_at: null,
          finished_at: "2026-11-24T10:01:00Z",
        },
      ],
      failedPredictions: [
        {
          id: "p1",
          model_id: "m2",
          status: "failed",
          error: "Table main.orders_new does not exist",
          drift_score: null,
          row_count: null,
          created_at: "2026-11-25T09:00:00Z",
          finished_at: "2026-11-25T09:00:30Z",
        },
      ],
      endpoints: [ep({ stale: true, version: 2 }), ep({ deployment_id: "d2", status: "stopped" })],
      schedules: [
        {
          id: "s1",
          model_id: "m2",
          name: "nightly",
          kind: "batch_predict",
          is_active: true,
          next_run_at: null,
          last_run_at: "2026-11-25T02:00:00Z",
          last_status: "failed",
          last_error: "lakehouse unreachable",
        },
      ],
      health: new Map([["m2", ["Inputs drifted: PSI 0.41 against a 0.25 alert line."]]]),
      now: NOW,
    });
    expect(items.map((i) => [i.severity, i.what, i.tab])).toEqual([
      ["bad", "Batch prediction failed", "predictions"],
      ["bad", "Training of v7 failed", "jobs"],
      // Newest first among the warnings: the endpoint was last called at
      // 11:00, the schedule last ran at 02:00.
      ["warn", "Endpoint behind production", "automation"],
      ["warn", 'Schedule "nightly" failed its last run', "automation"],
      ["warn", "Production version needs a look", "accuracy"],
    ]);
    expect(items[1].detail).toBe(
      "Only 12 rows have a value in churned; at least 20 are needed to train.",
    );
  });

  it("says when a schedule runs next, and what its last run did", () => {
    expect(nextRunLine("2026-11-25T11:59:50Z", NOW)).toBe("due now");
    expect(nextRunLine("2026-11-25T12:20:00Z", NOW)).toBe("in 20 min");
    expect(nextRunLine("2026-11-25T17:00:00Z", NOW)).toBe("in 5 h");
    expect(nextRunLine("2026-11-28T12:00:00Z", NOW)).toBe("in 3 days");
    expect(nextRunLine(null, NOW)).toBe("—");
    expect(lastRunOutcome("kept")).toBe("kept the production version");
    expect(lastRunOutcome("promoted")).toBe("promoted a better version");
    expect(lastRunOutcome("failed")).toBe("failed");
    expect(lastRunOutcome("awaiting_approval")).toBe(
      "trained a better version, waiting for approval",
    );
    // The values schedule.server.ts writes are the ones worded here.
    const writer = rd("src/utils/ml/schedule.server.ts");
    for (const value of ['"promoted"', '"awaiting_approval"', '"kept"', '"failed"']) {
      expect(writer).toContain(value);
    }
  });

  it("says how long a run took", () => {
    expect(duration("2026-11-25T10:00:00Z", "2026-11-25T10:00:42Z")).toBe("42 s");
    expect(duration("2026-11-25T10:00:00Z", "2026-11-25T10:03:00Z")).toBe("3 min");
    expect(duration("2026-11-25T10:00:00Z", "2026-11-25T11:35:00Z")).toBe("1 h 35 min");
    expect(duration(null, "2026-11-25T10:00:00Z")).toBeNull();
  });
});

describe("the Data science menu", () => {
  const ds = NAV_GROUPS.find((g) => g.label === "Data science")!;

  it("lists the work in the order it happens, as three named steps (R539)", () => {
    expect(ds.items.map((i) => [i.stage, i.title, i.url])).toEqual([
      ["Develop", "Developer workspace", "/notebooks"],
      ["Develop", "Feature views", "/ml/features"],
      ["Develop", "Experiments", "/ml/experiments"],
      ["Deploy", "ML Models", "/ml"],
      ["Deploy", "ML pipelines", "/ml/pipelines"],
      ["Deploy", "Model serving", "/ml/serving"],
      ["Monitor", "ML operations", "/ml/operations"],
    ]);
    // Every page of the group has a step, and each step is one run of pages:
    // a caption is printed where the step changes, so a step split in two
    // would be named twice.
    const stages = ds.items.map((i) => i.stage);
    expect(stages.every(Boolean)).toBe(true);
    expect(stages.filter((s, k) => s !== stages[k - 1])).toEqual(["Develop", "Deploy", "Monitor"]);
    // Only a group that is a sequence names steps.
    for (const g of NAV_GROUPS.filter((g) => g !== ds)) {
      expect(
        g.items.some((i) => i.stage),
        g.label,
      ).toBe(false);
    }
  });

  it("names each step once in the rail, and not when it is folded to icons", () => {
    const rail = rd("src/components/AppSidebar.tsx");
    expect(rail).toContain("item.stage && item.stage !== group.items[i - 1]?.stage");
    expect(rail).toContain("group-data-[collapsible=icon]:hidden");
    expect(rail).toContain('aria-hidden="true"');
  });

  it("starts a new endpoint from Model serving", () => {
    const page = rd("src/routes/_authenticated/ml_.serving.tsx");
    expect(page).toContain("Deploy a model");
    expect(page).toContain('"In production, never deployed"');
    expect(page).toContain('search: { tab: "automation" }');
  });

  it("marks the page you are on, and a model page under ML Models", () => {
    expect(navItemForPath("/ml/serving")?.title).toBe("Model serving");
    expect(navItemForPath("/ml/operations")?.title).toBe("ML operations");
    expect(navItemForPath("/ml/experiments")?.title).toBe("Experiments");
    expect(navItemForPath("/ml/features")?.title).toBe("Feature views");
    expect(navItemForPath("/ml/2316d0f3-0000-4000-8000-000000000000")?.title).toBe("ML Models");
    expect(navItemForPath("/ml/new")?.title).toBe("ML Models");
    expect(navGroupForPath("/ml/serving", ALL_NAV_GROUPS)?.label).toBe("Data science");
  });

  it("has a page behind every entry, and the old tab links still land", () => {
    for (const f of ["ml_.serving", "ml_.operations", "ml_.experiments", "ml_.features"]) {
      expect(rd(`src/routes/_authenticated/${f}.tsx`)).toContain(
        `createFileRoute("/_authenticated/${f.replace(".", "/")}")`,
      );
    }
    const ml = rd("src/routes/_authenticated/ml.tsx");
    expect(ml).toContain('throw redirect({ to: "/ml/experiments" })');
    expect(ml).toContain('throw redirect({ to: "/ml/features" })');
  });

  it("opens a model on the tab a row points at", () => {
    const page = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(page).toContain("validateSearch");
    expect(page).toContain('useState<string>(search.tab ?? "overview")');
  });

  it("reads only the models the caller may open", () => {
    const fns = rd("src/utils/mlConsole.functions.ts");
    // Both pages start from the model page's own access check, and every
    // query after it is scoped to those model ids.
    expect(fns.match(/await listModelsForUser\(userId\)/g)).toHaveLength(2);
    // Every read of an ml_ table, up to the next one, is narrowed to ids that
    // came from that list (or from rows read through it), or to the caller's
    // OWN rows, which is narrower still: R544's "when this model alerts" reads
    // the one model only when the caller owns it.
    const reads = fns.split('.from("ml_').slice(1);
    expect(reads.length).toBeGreaterThanOrEqual(9);
    for (const r of reads) {
      expect(r.slice(0, r.indexOf(";")), r.slice(0, 40)).toMatch(
        /\.in\(\s*"(model_id|id|deployment_id)"|\.eq\("user_id", userId\)/,
      );
    }
  });
});
