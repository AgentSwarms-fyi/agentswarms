// A refresh working from a stale row wrote over the result the sandbox had
// just stored.
//
// FOUND IN R292, FIXED IN R295. A node preview read only "Preview failed".
// The app's log had refreshSession "ended as error" while the result
// callback's teardown was already removing the container (409, "removal ...
// already in progress"). The preview poller read the session as "running",
// the sandbox posted its result and the callback stored it and removed the
// container, and then the poller's refreshSession - still holding the row it
// read - asked the orchestrator, heard "gone" or "exited", and wrote
// "stopped" or "error" with no error text over the stored result. It also
// returned that guess to the poller instead of what was stored.
//
// These run the real refreshSession against an in-memory table that honours
// the filters, with the orchestrator faked.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ rows: new Map<string, Row>() }));
const orch = vi.hoisted(() => ({
  state: { state: "gone" } as { state: string; message?: string },
  logs: "",
  stops: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      let patch: Row | null = null;
      let returning = false;
      const filters: [string, unknown][] = [];
      const matching = () =>
        [...db.rows.values()].filter((r) => filters.every(([k, v]) => r[k] === v));
      const run = () => {
        if (patch) {
          const hit = matching();
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        return { data: matching().map((r) => ({ ...r })), error: null };
      };
      const b: Record<string, unknown> = {
        select: () => {
          if (patch) returning = true;
          return b;
        },
        update: (p: Row) => {
          patch = p;
          return b;
        },
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return b;
        },
        maybeSingle: async () => {
          const r = run();
          return { data: (r.data as Row[] | null)?.[0] ?? null, error: null };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  },
}));

vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getRuntimeSettings: async () => ({}),
}));

vi.mock("@/utils/notebookRuntime/orchestrator", () => ({
  getOrchestrator: async () => ({
    status: async () => orch.state,
    logs: async () => orch.logs,
    stop: async () => {
      orch.stops++;
      return { removed: true };
    },
  }),
}));

vi.mock("@/utils/notebookRuntime/token.server", () => ({ signSessionToken: async () => "t" }));
vi.mock("@/utils/notebookRuntime/docker.server", () => ({ appInContainer: () => false }));

const { refreshSession } = await import("@/utils/notebookRuntime/service.server");
type SessionRow = Parameters<typeof refreshSession>[0];

/** What the result callback stores: the terminal row with the sandbox's own words. */
const STORED: Row = {
  id: "s1",
  kind: "batch",
  container_ref: "nb-s1",
  status: "error",
  error: "RuntimeError: raised token=***",
  logs: "printed token=***",
};

/** What the poller read a moment before the callback landed. */
const STALE = { ...STORED, status: "running", error: null, logs: null } as unknown as SessionRow;

beforeEach(() => {
  db.rows.clear();
  // Another session, live in the same status: no refresh of s1 may touch it.
  db.rows.set("s2", { ...STORED, id: "s2", container_ref: "nb-s2", status: "running" });
  orch.stops = 0;
  orch.logs = "";
});

describe("a refresh that read the session before its result landed", () => {
  it("leaves the stored result alone when the sandbox is already gone", async () => {
    db.rows.set("s1", { ...STORED });
    orch.state = { state: "gone" };
    const back = await refreshSession(STALE);
    expect(db.rows.get("s1")).toMatchObject({
      status: "error",
      error: "RuntimeError: raised token=***",
      logs: "printed token=***",
    });
    // ...and hands the poller what is stored, not its own guess.
    expect(back).toMatchObject({ status: "error", error: "RuntimeError: raised token=***" });
  });

  it("leaves it alone when the sandbox has exited with an error", async () => {
    db.rows.set("s1", { ...STORED });
    orch.state = { state: "error", message: "exited with code 1" };
    orch.logs = "";
    const back = await refreshSession(STALE);
    expect(db.rows.get("s1")).toMatchObject({ error: "RuntimeError: raised token=***" });
    expect(back).toMatchObject({
      error: "RuntimeError: raised token=***",
      logs: "printed token=***",
    });
  });
});

describe("a refresh whose row is still what it read", () => {
  it("still records a sandbox that went away", async () => {
    db.rows.set("s1", { ...STORED, status: "running", error: null, logs: null });
    orch.state = { state: "gone" };
    const back = await refreshSession(STALE);
    expect(db.rows.get("s1")).toMatchObject({ status: "stopped" });
    expect(back).toMatchObject({ status: "stopped" });
    expect(db.rows.get("s2")).toMatchObject({ status: "running" });
  });

  it("still records an exit with its reason and logs, and removes the sandbox", async () => {
    db.rows.set("s1", { ...STORED, status: "running", error: null, logs: null });
    orch.state = { state: "error", message: "exited with code 1" };
    orch.logs = "Traceback ...";
    const back = await refreshSession(STALE);
    expect(db.rows.get("s1")).toMatchObject({
      status: "error",
      error: "exited with code 1",
      logs: "Traceback ...",
    });
    expect(back).toMatchObject({ status: "error", error: "exited with code 1" });
    expect(orch.stops).toBe(1);
  });
});
