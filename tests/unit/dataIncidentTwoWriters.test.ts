// A data incident's status, written by two hands (R312).
//
// FOUND IN R312 (sweep 10). An incident has two writers: its owner, who
// acknowledges or resolves it, and the monitor's run, which extends it while
// the check fails and resolves it once the check passes. Each read the
// incident and then wrote without holding the write to what it had read, so:
// - Acknowledge pressed as a run resolved the incident opened it again;
// - a run that passed as its owner resolved it took the resolve over ("by
//   run") and told them "Recovered" about an incident they had closed;
// - a run that failed as its owner resolved it extended the closed incident
//   and stopped there: the new failure opened no incident and told nobody
//   until the next run.
// Each window is one database round trip, too narrow to stage in the UI, so
// both writers run here for real over an in-memory table store.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Verdict = { status: "ok" | "alert" | "error"; message: string; detail: Row };

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  /** Runs before a write is applied; the write then lands on what the row holds. */
  before: null as null | ((table: string, op: string, row: Row) => Promise<void>),
  audits: [] as { action: string; detail?: Row }[],
  notes: [] as { title: string }[],
  verdict: { status: "ok", message: "fine", detail: {} } as Verdict,
}));

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "insert" | "update" = "select";
  let payload: Row = {};
  let returning = false;
  const run = async (): Promise<{ data: unknown; error: null }> => {
    const rows = (db.tables[table] ??= []);
    if (op === "select") {
      return {
        data: rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })),
        error: null,
      };
    }
    if (db.before) await db.before(table, op, payload);
    if (op === "insert") {
      const row = { id: `${table}-${++db.seq}`, status: "open", occurrences: 1, ...payload };
      rows.push(row);
      return { data: returning ? [{ ...row }] : null, error: null };
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)));
    for (const r of hit) Object.assign(r, payload);
    return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
  };
  const first = async () => {
    const res = await run();
    return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
  };
  const b = {
    select: () => ((returning = op !== "select"), b),
    insert: (row: Row) => ((op = "insert"), (payload = row), b),
    update: (patch: Row) => ((op = "update"), (payload = patch), b),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
    order: () => b,
    limit: () => b,
    single: first,
    maybeSingle: first,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  return b;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      inputValidator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (t: string) => from(t),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  },
}));
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: { action: string; detail?: Row }) => db.audits.push(e),
}));
vi.mock("@/utils/notify.server", () => ({
  notifyUser: async (_userId: string, n: { title: string }) => {
    db.notes.push(n);
  },
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  runLakehouseStatement: async () => ({ rows: [[1]] }),
  lakehouseSnapshotId: async () => null,
}));
vi.mock("@/utils/lakehouse/tables.server", () => ({
  listLakehouseTablesForUser: async () => ({ tables: [] }),
}));
vi.mock("@/utils/etl/schedule.server", () => ({ nextEtlRunAt: () => null }));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getPlatformResources: async () => ({ dataMonitorAnomalySigma: 3 }),
}));
vi.mock("@/utils/callerLookup.server", () => ({ callerFailure: () => "Not signed in" }));
vi.mock("@/utils/dataMonitors/core", async (orig) => ({
  ...(await orig<typeof import("@/utils/dataMonitors/core")>()),
  validateMonitorConfig: () => null,
  buildMonitorSql: () => "select 1",
  evaluateMonitor: () => ({ ...db.verdict }),
}));

const { runDataMonitor } = await import("@/utils/dataMonitors/run.server");
const { dataIncidentUpdate } = await import("@/utils/dataMonitors.functions");

const INCIDENT = "6f1c2a4e-1d2b-4c3d-8e9f-0a1b2c3d4e5f";
const monitor = {
  id: "monitor-1",
  user_id: "user-1",
  name: "orders fresh",
  kind: "freshness",
  config: {},
  source_kind: "lakehouse",
  schema_name: "analytics",
  table_name: "orders",
  severity: "warning",
  consecutive_alerts: 1,
} as unknown as Parameters<typeof runDataMonitor>[0];

type Answer = { ok: true } | { ok: false; error: string };
const press = (action: "acknowledge" | "resolve") =>
  (dataIncidentUpdate as unknown as (o: { data: unknown }) => Promise<Answer>)({
    data: { access_token: "token", id: INCIDENT, action },
  });
const run = (status: Verdict["status"]) => {
  db.verdict = { status, message: status === "ok" ? "fresh again" : "stale for 3 h", detail: {} };
  return runDataMonitor(monitor, "manual");
};
const incidents = () => db.tables.data_incidents;
const resolves = () => db.audits.filter((a) => a.action === "data.incident.resolved");
/** Once, before the first write of this shape: the hook clears itself first. */
const beforeWrite = (when: (row: Row) => boolean, then: () => Promise<void>) => {
  db.before = async (table, op, row) => {
    if (table !== "data_incidents" || op !== "update" || !when(row)) return;
    db.before = null;
    await then();
  };
};

beforeEach(() => {
  db.seq = 0;
  db.before = null;
  db.audits = [];
  db.notes = [];
  db.tables = {
    data_monitors: [{ ...monitor }],
    data_monitor_runs: [],
    data_incidents: [
      {
        id: INCIDENT,
        monitor_id: "monitor-1",
        user_id: "user-1",
        status: "open",
        occurrences: 1,
        title: "orders fresh: stale for 2 h",
        detail: {},
      },
    ],
  };
});

describe("the owner pressing a button as the monitor's run resolves the incident", () => {
  it.each(["acknowledge", "resolve"] as const)(
    "%s leaves it resolved by the run, and says so",
    async (action) => {
      beforeWrite(
        (row) => row.status === (action === "acknowledge" ? "acknowledged" : "resolved"),
        async () => {
          await run("ok");
        },
      );
      const res = await press(action);
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toBe(
        "The monitor's run found the table healthy and resolved this incident a moment ago, so nothing was changed.",
      );
      expect(incidents()[0]).toMatchObject({ status: "resolved", resolved_by: "run" });
      expect(db.audits.map((a) => a.action)).toEqual(["data.incident.resolved"]);
      expect(resolves()[0].detail?.by).toBe("run");
    },
  );
});

describe("the monitor's run as the owner resolves the incident", () => {
  it("that passes keeps the owner's resolve, and neither records nor announces its own", async () => {
    beforeWrite(
      (row) => row.resolved_by === "run",
      async () => {
        expect(await press("resolve")).toEqual({ ok: true });
      },
    );
    await run("ok");
    expect(incidents()[0]).toMatchObject({ status: "resolved", resolved_by: "user" });
    expect(resolves().map((a) => a.detail?.by)).toEqual(["user"]);
    expect(db.notes).toEqual([]);
  });

  it("that fails opens a new incident and tells the owner", async () => {
    beforeWrite(
      (row) => "occurrences" in row,
      async () => {
        expect(await press("resolve")).toEqual({ ok: true });
      },
    );
    await run("alert");
    expect(incidents().map((i) => [i.status, i.occurrences])).toEqual([
      ["resolved", 1],
      ["open", 1],
    ]);
    expect(db.notes.map((n) => n.title)).toEqual(["orders fresh"]);
    expect(db.audits.map((a) => a.action)).toEqual([
      "data.incident.resolved",
      "data.monitor.alert",
    ]);
  });
});

describe("one writer at a time", () => {
  it("a failing run extends the open incident and says nothing new", async () => {
    await run("alert");
    expect(incidents().map((i) => [i.status, i.occurrences])).toEqual([["open", 2]]);
    expect(db.notes).toEqual([]);
  });

  it("a passing run resolves it and says Recovered", async () => {
    await run("ok");
    expect(incidents()[0]).toMatchObject({ status: "resolved", resolved_by: "run" });
    expect(db.notes.map((n) => n.title)).toEqual(["Recovered: orders fresh"]);
  });

  it("Acknowledge, then Resolve", async () => {
    expect(await press("acknowledge")).toEqual({ ok: true });
    expect(incidents()[0]).toMatchObject({ status: "acknowledged", acknowledged_by: "user-1" });
    expect(await press("resolve")).toEqual({ ok: true });
    expect(incidents()[0]).toMatchObject({ status: "resolved", resolved_by: "user" });
  });
});

describe("the page", () => {
  it("shows where things stand after a refused action, not what it showed before", () => {
    const page = readFileSync("src/routes/_authenticated/data-monitors.tsx", "utf8");
    const act = page.slice(page.indexOf("async function act("));
    const refused = act.slice(act.indexOf("if (!r.ok) {"), act.indexOf("done?.(r);"));
    expect(refused).toContain("toast.error(");
    expect(refused).toContain("await reload();");
  });
});
