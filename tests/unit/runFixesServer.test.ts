// Applying a fix to something that keeps failing, and asking first (R525).
//
// The server module runs against an in-memory stand-in for the service-role
// client (select, eq, is, in, contains as a recursive subset like jsonb @>,
// update, insert, single). What is held: only the owner changes their check
// or pipeline, an approval row proves nothing by itself, an approved fix is
// carried out once and checked against the table as it is now, and the
// sweep asks once per change.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  audit: [] as Array<Record<string, unknown>>,
  notified: [] as Array<{ userId: string; title: string }>,
  lakeColumns: [] as Array<{ name: string; type: string }>,
  statements: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const subset = (have: unknown, want: unknown): boolean => {
    if (want === null || typeof want !== "object") return have === want;
    if (!have || typeof have !== "object") return false;
    return Object.entries(want as Row).every(([k, v]) => subset((have as Row)[k], v));
  };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let values: Row | null = null;
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "range"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
    b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
    b.in = (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b);
    b.contains = (c: string, v: Row) => (filters.push((r) => subset(r[c], v)), b);
    b.update = (v: Row) => ((op = "update"), (values = v), b);
    b.insert = (v: Row) => ((op = "insert"), (values = v), b);
    b.single = b.maybeSingle = () => ((single = true), b);
    b.then = (resolve: (v: unknown) => void) => {
      const list = (db.tables[table] ??= []);
      let data: Row[];
      if (op === "insert") {
        const row = { id: `${table}-${list.length + 1}`, status: "pending", ...values };
        list.push(row);
        data = [row];
      } else {
        data = list.filter((r) => filters.every((f) => f(r)));
        if (op === "update") for (const r of data) Object.assign(r, values);
      }
      resolve(single ? { data: data[0] ?? null, error: null } : { data, error: null });
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => db.audit.push(e),
}));
vi.mock("@/utils/notify.server", () => ({
  notifyUser: async (userId: string, n: { title: string }) =>
    void db.notified.push({ userId, title: n.title }),
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  // One statement against the one table: its columns, or the engine's refusal.
  runLakehouseStatement: async (_user: string, sql: string) => {
    db.statements.push(sql);
    if (!sql.includes('"analytics"."revenue_facts"')) throw new Error("no such table");
    return { columns: db.lakeColumns, rows: [] };
  },
}));

const { applyRunFix, applyApprovedRunFix, diagnoseRun, sweepRunFixes } =
  await import("@/utils/runFixes.server");
const { RUN_FIX_ACTION } = await import("@/lib/runFixes");

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MON = "11111111-1111-1111-1111-111111111111";
const PIPE = "22222222-2222-2222-2222-222222222222";
const NOT_A_TIME =
  "The newest value in this column is not a date or time: EMEA. Freshness needs a timestamp column.";
const monitor = () => db.tables.data_monitors[0];

beforeEach(() => {
  db.audit = [];
  db.notified = [];
  db.lakeColumns = [
    { name: "region", type: "VARCHAR" },
    { name: "updated_at", type: "TIMESTAMP" },
  ];
  db.tables = {
    data_monitors: [
      {
        id: MON,
        name: "R238 freshness on a text column",
        user_id: OWNER,
        kind: "freshness",
        config: { column: "region", max_age_minutes: 1440 },
        is_active: true,
        source_kind: "lakehouse",
        schema_name: "analytics",
        table_name: "revenue_facts",
        last_status: "alert",
        last_message: NOT_A_TIME,
        consecutive_alerts: 12,
      },
    ],
    data_monitor_runs: Array.from({ length: 5 }, () => ({
      monitor_id: MON,
      status: "alert",
      message: NOT_A_TIME,
    })),
    etl_pipelines: [
      {
        id: PIPE,
        name: "nightly load",
        user_id: OWNER,
        is_active: true,
        last_run_status: "failed",
      },
    ],
    etl_runs: Array.from({ length: 3 }, () => ({
      pipeline_id: PIPE,
      status: "failed",
      error: 'Catalog Error: Table with name "raw.orders" does not exist',
    })),
    approvals: [],
  };
});

const mon = { type: "data_monitor" as const, id: MON };
const pipe = { type: "etl_pipeline" as const, id: PIPE };

describe("diagnosing a run: for its owner only", () => {
  it("reads the check, its runs and its table's columns", async () => {
    const v = await diagnoseRun(mon, OWNER);
    expect(v?.proposal?.fix).toEqual({
      fix: "timestamp_column",
      column: "updated_at",
      from: "region",
    });
    expect(v?.proposal?.evidence).toBe("The last 5 runs failed the same way.");
  });

  it("reads one table's columns with one statement, not the whole lakehouse", async () => {
    db.statements = [];
    await diagnoseRun(mon, OWNER);
    expect(db.statements).toEqual(['SELECT * FROM "analytics"."revenue_facts" LIMIT 0']);
  });

  it("a table the engine cannot read leaves the columns unread, and says so", async () => {
    monitor().table_name = "gone";
    const v = await diagnoseRun(mon, OWNER);
    expect(v?.proposal).toBeNull();
    expect(v?.diagnosis).toMatch(/could not be read/);
  });

  it("someone else gets nothing, as if it were not there", async () => {
    expect(await diagnoseRun(mon, OTHER)).toBeNull();
    expect(await diagnoseRun(pipe, OTHER)).toBeNull();
  });
});

describe("applying a fix: only its owner, checked against the table now", () => {
  it("points the check at the new column and clears the old result", async () => {
    const res = await applyRunFix(
      mon,
      { fix: "timestamp_column", column: "updated_at", from: "region" },
      OWNER,
    );
    expect(res.ok).toBe(true);
    expect(monitor().config).toEqual({ column: "updated_at", max_age_minutes: 1440 });
    expect(monitor()).toMatchObject({
      last_status: null,
      last_message: null,
      consecutive_alerts: 0,
    });
    expect(typeof monitor().next_run_at).toBe("string");
    expect(db.audit).toMatchObject([{ action: "run.fix.applied", resourceId: MON, userId: OWNER }]);
  });

  it("refuses a column that is not a date or time column of the table now", async () => {
    for (const column of ["region", "no_such_column"]) {
      const res = await applyRunFix(mon, { fix: "timestamp_column", column, from: null }, OWNER);
      expect(res.ok).toBe(false);
    }
    expect(monitor().config).toEqual({ column: "region", max_age_minutes: 1440 });
  });

  it("refuses someone else, changing nothing", async () => {
    expect(await applyRunFix(mon, { fix: "pause" }, OTHER)).toEqual({
      ok: false,
      error: "Only its owner can change it",
    });
    expect(await applyRunFix(pipe, { fix: "pause" }, OTHER)).toMatchObject({ ok: false });
    expect(monitor().is_active).toBe(true);
    expect(db.tables.etl_pipelines[0].is_active).toBe(true);
  });

  it("withdraws a suggestion still waiting for the same thing once a fix is applied", async () => {
    db.tables.approvals.push(
      {
        id: "waiting",
        user_id: OWNER,
        action_type: RUN_FIX_ACTION,
        status: "pending",
        payload: { target: mon, fix: { fix: "pause" } },
      },
      {
        id: "elsewhere",
        user_id: OWNER,
        action_type: RUN_FIX_ACTION,
        status: "pending",
        payload: { target: pipe, fix: { fix: "pause" } },
      },
    );
    await applyRunFix(
      mon,
      { fix: "timestamp_column", column: "updated_at", from: "region" },
      OWNER,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(db.tables.approvals.find((a) => a.id === "waiting")?.status).toBe("cancelled");
    expect(db.tables.approvals.find((a) => a.id === "elsewhere")?.status).toBe("pending");
  });

  it("pauses a check or a pipeline", async () => {
    expect((await applyRunFix(mon, { fix: "pause" }, OWNER)).ok).toBe(true);
    expect((await applyRunFix(pipe, { fix: "pause" }, OWNER)).ok).toBe(true);
    expect(monitor().is_active).toBe(false);
    expect(db.tables.etl_pipelines[0].is_active).toBe(false);
  });
});

const approval = (over: Row = {}) =>
  db.tables.approvals.push({
    id: "ap1",
    user_id: OWNER,
    action_type: RUN_FIX_ACTION,
    status: "approved",
    resumed_at: null,
    payload: { target: mon, fix: { fix: "pause" } },
    ...over,
  });

describe("an approved fix: carried out once, against the thing itself", () => {
  it("is applied, and a second press finds it done", async () => {
    approval();
    expect((await applyApprovedRunFix("ap1", OWNER)).ok).toBe(true);
    expect(monitor().is_active).toBe(false);
    expect(await applyApprovedRunFix("ap1", OWNER)).toEqual({
      ok: false,
      error: "It has already been carried out",
    });
    expect(db.audit).toHaveLength(1);
  });

  it("a forged row naming someone else's check changes nothing, and gives its claim back", async () => {
    approval({ user_id: OTHER });
    expect(await applyApprovedRunFix("ap1", OTHER)).toEqual({
      ok: false,
      error: "Only its owner can change it",
    });
    expect(monitor().is_active).toBe(true);
    expect(db.tables.approvals[0].resumed_at).toBeNull();
  });

  it("refuses another's approval, an unapproved one, and a payload that names no fix", async () => {
    approval();
    expect((await applyApprovedRunFix("ap1", OTHER)).ok).toBe(false);
    db.tables.approvals = [];
    approval({ status: "pending" });
    expect((await applyApprovedRunFix("ap1", OWNER)).ok).toBe(false);
    db.tables.approvals = [];
    approval({ payload: { target: mon, fix: { fix: "delete" } } });
    expect(await applyApprovedRunFix("ap1", OWNER)).toEqual({
      ok: false,
      error: "That approval does not name a fix",
    });
    expect(monitor().is_active).toBe(true);
  });
});

describe("the sweep asks each owner once per change", () => {
  it("suggests the column fix and the pipeline pause, and tells the owner", async () => {
    expect(await sweepRunFixes(true)).toBe(2);
    const [a, b] = db.tables.approvals;
    expect(a).toMatchObject({
      user_id: OWNER,
      action_type: RUN_FIX_ACTION,
      action_title: 'Check "updated_at" instead of "region"',
      status: "pending",
      payload: { target: mon, fix: { fix: "timestamp_column", column: "updated_at" } },
    });
    expect(b).toMatchObject({
      action_title: "Pause this pipeline",
      payload: { target: pipe, fix: { fix: "pause" } },
    });
    // Un-routed, so its owner may decide it.
    expect(a.approver_user_ids ?? []).toEqual([]);
    expect(db.notified.map((n) => n.title)).toEqual([
      "R238 freshness on a text column keeps failing",
      "nightly load keeps failing",
    ]);
  });

  it("not again while one waits, nor after a no", async () => {
    await sweepRunFixes(true);
    expect(await sweepRunFixes(true)).toBe(0);
    for (const a of db.tables.approvals) a.status = "rejected";
    expect(await sweepRunFixes(true)).toBe(0);
    expect(db.tables.approvals).toHaveLength(2);
  });

  it("not a second, different change while one for the same thing waits", async () => {
    // A pause is waiting for the check; the sweep would now propose the column.
    db.tables.approvals.push({
      id: "ap0",
      user_id: OWNER,
      action_type: RUN_FIX_ACTION,
      status: "pending",
      payload: { target: mon, fix: { fix: "pause" } },
    });
    db.tables.etl_pipelines = [];
    expect(await sweepRunFixes(true)).toBe(0);
    expect(db.tables.approvals).toHaveLength(1);
  });

  it("asks nothing about an outage", async () => {
    db.tables.etl_runs = Array.from({ length: 5 }, () => ({
      pipeline_id: PIPE,
      status: "failed",
      error: "Cannot reach the Docker socket-proxy, so no kernel can be started.",
    }));
    db.tables.data_monitors = [];
    expect(await sweepRunFixes(true)).toBe(0);
  });

  it("runs on the scheduler's pass, and the inbox carries a yes out through the server", () => {
    const pass = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
    expect(pass).toContain('"run-fixes"');
    expect(pass).toContain("m.sweepRunFixes(force)");
    const inbox = readFileSync("src/components/ApprovalInbox.tsx", "utf8");
    expect(inbox).toContain("useServerFn(applyApprovedRunFixFn)");
    expect(inbox).toContain("item?.action_type === RUN_FIX_ACTION");
  });
});
