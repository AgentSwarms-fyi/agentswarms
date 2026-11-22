// One Runs view (R520): every kind's words mapped to one set, and the reads
// behind it kept to the reader's own runs.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ALL_NAV_GROUPS } from "@/lib/appNav";
import {
  askAboutFailure,
  dayLabel,
  durationOf,
  filterRuns,
  mergeRuns,
  normalizeStatus,
  normalizeTrigger,
  oneLineError,
  RUN_KINDS,
  runCounts,
  type RunRow,
} from "@/lib/runs";
import { GO_TO_SHORTCUTS } from "@/lib/shortcuts";

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("one set of words for how a run went", () => {
  it.each([
    // pipelines, workflows, ML, notebooks
    ["succeeded", "succeeded"],
    ["queued", "queued"],
    ["retrying", "running"],
    ["cancelled", "cancelled"],
    // swarms
    ["success", "succeeded"],
    ["error", "failed"],
    ["waiting", "waiting"],
    ["suspended", "waiting"],
    // scheduled emails
    ["sent", "succeeded"],
    ["skipped", "skipped"],
    ["partial", "partial"],
    // monitors, schedules
    ["ok", "succeeded"],
    ["alert", "alert"],
    // evaluations, notebooks
    ["done", "succeeded"],
    ["starting", "queued"],
    ["stopped", "cancelled"],
  ])("%s → %s", (raw, want) => {
    expect(normalizeStatus(raw)).toBe(want);
  });

  it("calls a word nobody mapped a failure, not a success", () => {
    expect(normalizeStatus("exploded")).toBe("failed");
    expect(normalizeStatus(null)).toBe("failed");
  });

  it("names how it was started", () => {
    expect(normalizeTrigger("schedule")).toBe("schedule");
    expect(normalizeTrigger("api")).toBe("api");
    expect(normalizeTrigger("trigger")).toBe("api");
    expect(normalizeTrigger("chain")).toBe("chain");
    expect(normalizeTrigger("workflow")).toBe("chain");
    expect(normalizeTrigger("rerun")).toBe("retry");
    expect(normalizeTrigger("manual")).toBe("manual");
    expect(normalizeTrigger("")).toBeNull();
  });
});

describe("a failure in one line", () => {
  it("takes the exception from the end of a traceback", () => {
    const tb = [
      "Traceback (most recent call last):",
      '  File "x.py", line 3, in <module>',
      "    boto3.client('s3').get_object()",
      "PermissionError: Forbidden",
    ].join("\n");
    expect(oneLineError(tb)).toBe("PermissionError: Forbidden");
  });

  it("drops terminal colours, joins spaces, and cuts a long line", () => {
    expect(oneLineError("\u001b[31mboom\u001b[0m   happened")).toBe("boom happened");
    expect(oneLineError("x".repeat(300))!.length).toBe(200);
    expect(oneLineError("")).toBeNull();
    expect(oneLineError(null)).toBeNull();
  });
});

describe("the list", () => {
  const run = (over: Partial<RunRow>): RunRow => ({
    kind: "etl",
    id: "1",
    name: "n",
    status: "succeeded",
    startedAt: "2026-11-21T10:00:00Z",
    finishedAt: null,
    durationMs: null,
    trigger: null,
    error: null,
    costUsd: null,
    link: null,
    ...over,
  });

  it("puts the newest first across kinds", () => {
    const merged = mergeRuns(
      [run({ id: "a", startedAt: "2026-11-20T10:00:00Z" })],
      [run({ kind: "swarm", id: "b", startedAt: "2026-11-21T09:00:00Z" })],
      [run({ kind: "monitor", id: "c", startedAt: "2026-11-21T11:00:00Z" })],
    );
    expect(merged.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("filters to what needs a look, what is running, and chosen kinds", () => {
    const rows = [
      run({ id: "1", status: "failed" }),
      run({ id: "2", status: "partial" }),
      run({ id: "3", status: "alert", kind: "monitor" }),
      run({ id: "4", status: "running", kind: "swarm" }),
      run({ id: "5", status: "waiting", kind: "swarm" }),
      run({ id: "6" }),
    ];
    expect(filterRuns(rows, { show: "needs_a_look" }).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(filterRuns(rows, { show: "in_flight" }).map((r) => r.id)).toEqual(["4", "5"]);
    expect(filterRuns(rows, { kinds: new Set(["swarm"] as const) }).map((r) => r.id)).toEqual([
      "4",
      "5",
    ]);
    const c = runCounts(rows);
    expect([c.total, c.needsALook, c.inFlight, c.byKind.get("swarm")]).toEqual([6, 3, 2, 2]);
  });

  it("works out a duration, preferring the one recorded", () => {
    expect(durationOf("2026-11-21T10:00:00Z", "2026-11-21T10:01:30Z")).toBe(90_000);
    expect(durationOf("2026-11-21T10:00:00Z", "2026-11-21T10:01:30Z", 5)).toBe(5);
    expect(durationOf("2026-11-21T10:00:00Z", null)).toBeNull();
    expect(durationOf("2026-11-21T10:01:00Z", "2026-11-21T10:00:00Z")).toBeNull();
  });

  it("groups by day in words", () => {
    const now = new Date("2026-11-21T15:00:00");
    expect(dayLabel("2026-11-21T08:00:00", now)).toBe("Today");
    expect(dayLabel("2026-11-20T23:00:00", now)).toBe("Yesterday");
    expect(dayLabel("not a date", now)).toBe("Unknown day");
  });

  it("does not double the full stop of an error that has one", () => {
    expect(
      askAboutFailure({ kind: "monitor", name: "M", error: "Freshness needs a timestamp column." }),
    ).toBe(
      "My data monitor “M” failed with: Freshness needs a timestamp column. What usually causes this, and what should I check?",
    );
  });

  it("asks the assistant about a failure with its kind, name and error", () => {
    expect(
      askAboutFailure({ kind: "etl", name: "Orders", error: "PermissionError: Forbidden" }),
    ).toBe(
      "My pipeline “Orders” failed with: PermissionError: Forbidden. What usually causes this, and what should I check?",
    );
  });
});

describe("the reads behind it", () => {
  const fn = src("src/utils/runs.functions.ts");
  const reads = [...fn.matchAll(/read\("([a-z_]+)"/g)].map((m) => m[1]);

  it("reads every kind the page names, once", () => {
    expect(reads.sort()).toEqual(RUN_KINDS.map((k) => k.id).sort());
  });

  it("keeps every read to the reader's own runs, with their own token", () => {
    expect(fn).toMatch(/\.middleware\(\[requireSupabaseAuth\]\)/);
    expect(fn).not.toMatch(/supabaseAdmin|client\.server/);
    const own = fn.match(/\.eq\("user_id", uid\)/g) ?? [];
    expect(own.length).toBe(RUN_KINDS.length);
  });

  it("lets one kind fail without blanking the rest", () => {
    expect(fn).toMatch(/catch \{\s*unread\.push\(kind\);\s*return \[\];/);
  });

  it("is in the menu, with G then R", () => {
    const overview = ALL_NAV_GROUPS.find((g) => g.label === "Overview")!;
    expect(overview.items.map((i) => i.url)).toContain("/runs");
    expect(GO_TO_SHORTCUTS.find((s) => s.key === "r")?.url).toBe("/runs");
  });
});
