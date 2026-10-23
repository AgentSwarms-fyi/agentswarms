// A decision resumes its swarm run once (R317).
//
// FOUND IN R317. The approvals inbox wrote a decision over whatever the
// approval held, and every decision then called the resume. Two tabs (or two
// approvers) pressing Approve on one approval both resumed the run, and
// everything after the approval ran twice. Separately, a resume whose run
// could not be reopened, because it had been cancelled after the resume read
// it, was recorded as a NEW run and ran anyway.
//
// Now the inbox decides only a pending approval; the resume claims the
// approval (`resumed_at`) before it runs, and releases the claim when nothing
// ran; and the tracer reopens only a parked run, refusing otherwise.
//
// resumeApprovedSwarmRun and createServerSwarmTracer run here for real over an
// in-memory table store; the executor itself is faked where it is called.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  resumes: 0,
  /** Holds a resume open until released, so a second can arrive meanwhile. */
  hold: null as null | Promise<void>,
  result: null as unknown,
  throws: false,
}));

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" | "insert" = "select";
  let payload: Row = {};
  let returning = false;
  const run = async () => {
    const rows = (db.tables[table] ??= []);
    const hit = () => rows.filter((r) => filters.every((f) => f(r)));
    if (op === "select") return { data: hit().map((r) => ({ ...r })), error: null };
    if (op === "update") {
      const h = hit();
      for (const r of h) Object.assign(r, payload);
      return { data: returning ? h.map((r) => ({ ...r })) : null, error: null };
    }
    const row = { id: `${table}-new-${rows.length + 1}`, ...payload };
    rows.push(row);
    return { data: returning ? [{ ...row }] : null, error: null };
  };
  const b = {
    select: () => ((returning = op !== "select"), b),
    update: (p: Row) => ((op = "update"), (payload = p), b),
    insert: (p: Row) => ((op = "insert"), (payload = p), b),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
    maybeSingle: async () => {
      const res = await run();
      return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
    },
    single: async () => {
      const res = await run();
      return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  return b;
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "approver-1" } }, error: null }) },
    from: (t: string) => from(t),
  }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => from(t) },
}));
vi.mock("@/utils/swarmCheckpoint.server", () => ({
  loadCheckpoint: async () => ({ ctx: {}, done: [] }),
}));
vi.mock("@/utils/internalOrigin.server", () => ({ resolveInternalOrigin: () => "http://app" }));
vi.mock("@/utils/swarmExecute.server", () => ({
  RESUME_NOT_REOPENED: "The run could not be reopened, so nothing of it ran.",
  resumeSwarmRun: async () => {
    db.resumes++;
    if (db.hold) await db.hold;
    if (db.throws) throw new Error("checkpoint unreadable");
    return db.result;
  },
}));

process.env.SUPABASE_URL = "http://supabase";
process.env.SUPABASE_PUBLISHABLE_KEY = "pk";

const { resumeApprovedSwarmRun } = await import("@/utils/swarmResume.functions");

const APPROVAL = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const RUN = "run-1";
const resume = () =>
  (
    resumeApprovedSwarmRun as unknown as (o: {
      data: { access_token: string; approval_id: string };
    }) => Promise<{ ok: boolean; error?: string; status?: string }>
  )({ data: { access_token: "t", approval_id: APPROVAL } });
const approval = () => db.tables.approvals[0];
const until = async (done: () => boolean) => {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
};

beforeEach(() => {
  db.resumes = 0;
  db.hold = null;
  db.throws = false;
  db.result = { status: "success", output: "refund sent", error: null, runId: RUN };
  db.tables = {
    approvals: [
      { id: APPROVAL, status: "approved", swarm_run_id: RUN, user_id: "owner-1", resumed_at: null },
    ],
    swarm_runs: [{ id: RUN, user_id: "owner-1", status: "suspended" }],
  };
});

describe("two resumes of one decision", () => {
  it("run the rest of the swarm once", async () => {
    let release = () => {};
    db.hold = new Promise<void>((r) => (release = r));
    const first = resume();
    await until(() => db.resumes === 1);

    const second = await resume();
    expect(second.ok).toBe(true);
    expect(db.resumes).toBe(1);

    release();
    expect(await first).toMatchObject({ ok: true, status: "success" });
    expect(db.resumes).toBe(1);
    expect(approval().resumed_at).not.toBeNull();
  });
});

describe("a claim whose resume ran nothing", () => {
  it("is released when the run could not be reopened, and the caller is told", async () => {
    db.result = {
      status: "error",
      output: "",
      error: "The run could not be reopened, so nothing of it ran.",
      runId: RUN,
    };
    expect(await resume()).toEqual({
      ok: false,
      error: "The run could not be reopened, so nothing of it ran.",
    });
    expect(approval().resumed_at).toBeNull();
  });

  it("is released when there was nothing to resume", async () => {
    db.result = null;
    expect(await resume()).toEqual({ ok: false, error: "This run can no longer be resumed" });
    expect(approval().resumed_at).toBeNull();
  });

  it("is released when the resume throws", async () => {
    db.throws = true;
    expect(await resume()).toEqual({ ok: false, error: "checkpoint unreadable" });
    expect(approval().resumed_at).toBeNull();
  });

  it("but a resume that ran and failed keeps it: the failure is the run's result", async () => {
    db.result = { status: "error", output: "", error: "provider down", runId: RUN };
    expect(await resume()).toMatchObject({ ok: true, status: "error" });
    expect(approval().resumed_at).not.toBeNull();
  });
});

describe("reopening the run", async () => {
  const { createServerSwarmTracer } = await import("@/utils/observability/serverTracer.server");
  const open = () =>
    createServerSwarmTracer({ userId: "owner-1", swarmId: "s-1", resumeRunId: RUN });

  it("reopens a parked run under its own id", async () => {
    const t = await open();
    expect(t?.runId).toBe(RUN);
    expect(db.tables.swarm_runs).toHaveLength(1);
    expect(db.tables.swarm_runs[0].status).toBe("running");
  });

  it("reopens one whose park stamp did not land (R90)", async () => {
    db.tables.swarm_runs[0].status = "running";
    expect((await open())?.runId).toBe(RUN);
  });

  it("does not bring back a run cancelled after the resume read it, and records no new run", async () => {
    db.tables.swarm_runs[0].status = "cancelled";
    expect(await open()).toBeNull();
    expect(db.tables.swarm_runs).toEqual([{ id: RUN, user_id: "owner-1", status: "cancelled" }]);
  });

  it("nor one that finished", async () => {
    db.tables.swarm_runs[0].status = "success";
    expect(await open()).toBeNull();
    expect(db.tables.swarm_runs).toHaveLength(1);
  });
});

describe("the executor and the inbox", () => {
  const ex = readFileSync("src/utils/swarmExecute.server.ts", "utf8");
  const inbox = readFileSync("src/components/ApprovalInbox.tsx", "utf8");

  it("the executor runs no node of a resume whose run was not reopened", () => {
    const refuse = ex.indexOf("if (opts.resume && depth === 0 && !tracer) {");
    expect(refuse).toBeGreaterThan(0);
    expect(ex.slice(refuse, refuse + 200)).toContain("error: RESUME_NOT_REOPENED");
    // Before anything is recorded or run.
    expect(refuse).toBeLessThan(ex.indexOf("beginDecision({ userId: opts.userId"));
    expect(refuse).toBeLessThan(ex.indexOf("const resumed = opts.resume?.checkpoint ?? null;"));
  });

  it("the inbox decides only a pending approval, and resumes only what it decided", () => {
    const decide = inbox.slice(inbox.indexOf("const decide = async"));
    expect(decide).toMatch(
      /\.update\(\{ status, decided_at: [^}]+\}\)\s*\.eq\("id", id\)\s*\.eq\("status", "pending"\)\s*\.select\("id"\);/,
    );
    const lost = decide.indexOf("if ((decided ?? []).length === 0) {");
    expect(lost).toBeGreaterThan(0);
    expect(decide.slice(lost, lost + 400)).toContain("return;");
    expect(lost).toBeLessThan(decide.indexOf("await resumeRunFn("));
    expect(lost).toBeLessThan(decide.indexOf("await applyPromotionFn("));
  });
});
