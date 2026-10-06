// Three late writers left from the sweep's census (R320).
//
// - stopSession wrote "stopped" over the result the callback had already
//   written ("succeeded", "failed"), so a finished session's own label read
//   "stopped" once its sandbox was cleaned up.
// - An MCP app's deploy wrote "ready" (or "error") over whatever the app held.
//   A Stop that landed after the server answered and before that write was
//   undone: MCP Builder read Running over a server the Stop had removed.
// - Registering a run that was still open closed it as "finished" over
//   whatever it held, so a run its notebook had just ended as "failed" read
//   "finished".
//
// stopSession runs here for real over an in-memory table; the deploy and the
// register are pinned at the writes.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ sessions: [] as Row[], stopped: [] as string[] }));

function sessions() {
  const filters: ((r: Row) => boolean)[] = [];
  let payload: Row | null = null;
  const run = async () => {
    const hit = db.sessions.filter((r) => filters.every((f) => f(r)));
    if (payload) for (const r of hit) Object.assign(r, payload);
    return { data: hit.map((r) => ({ ...r })), error: null };
  };
  const b = {
    update: (p: Row) => ((payload = p), b),
    select: () => b,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
  };
  return b;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => sessions() },
}));
vi.mock("@/utils/notebookRuntime/config.server", () => ({
  getRuntimeSettings: async () => ({}),
}));
vi.mock("@/utils/notebookRuntime/orchestrator", () => ({
  getOrchestrator: async () => ({
    stop: async (ref: string) => (db.stopped.push(ref), { removed: true }),
  }),
}));
vi.mock("@/utils/notebookRuntime/token.server", () => ({ signSessionToken: () => "t" }));
vi.mock("@/utils/notebookRuntime/docker.server", () => ({ appInContainer: () => false }));

const { stopSession } = await import("@/utils/notebookRuntime/service.server");
type Session = Parameters<typeof stopSession>[0];

beforeEach(() => {
  db.stopped = [];
  db.sessions = [];
});
const session = (status: string) => {
  const row = { id: `s-${status}`, status, container_ref: `c-${status}`, inputs: null };
  db.sessions.push(row);
  return row as unknown as Session;
};

describe("stopping a session's sandbox", () => {
  it("marks a live session stopped", async () => {
    await stopSession(session("ready"));
    expect(db.sessions[0].status).toBe("stopped");
    expect(db.stopped).toEqual(["c-ready"]);
  });

  it.each(["succeeded", "failed"])(
    "removes the sandbox of a session that %s, and keeps its result",
    async (status) => {
      await stopSession(session(status));
      expect(db.stopped).toEqual([`c-${status}`]);
      expect(db.sessions[0].status).toBe(status);
    },
  );
});

describe("an MCP app's deploy", () => {
  const src = readFileSync("src/utils/mcpApps/service.server.ts", "utf8");

  it("writes ready only over its own start, and stops what it started when a Stop won", () => {
    const at = src.indexOf('await setAppStatus(app.id, "ready", null, "deploying")');
    expect(at).toBeGreaterThan(0);
    const after = src.slice(at, at + 300);
    expect(after).toMatch(
      /await stopSession\(outcome\.row\)[\s\S]*return fail\(409, "stopped", STOPPED_WHILE_DEPLOYING\);/,
    );
  });

  it("writes its failures only over its own start, so a Stop meanwhile stays stopped", () => {
    expect(src.match(/setAppStatus\(app\.id, "error", [^;]+, "deploying"\)/g)).toHaveLength(3);
  });

  it("holds the write when asked, and says whether it landed", () => {
    const fn = src.slice(
      src.indexOf("async function setAppStatus("),
      src.indexOf("export async function ensure"),
    );
    expect(fn).toContain('if (heldTo) q = q.eq("status", heldTo);');
    expect(fn).toContain("return (data ?? []).length > 0;");
  });

  it("a Stop is the person's word, and is not held", () => {
    const stop = src.slice(src.indexOf("export async function stopApp("));
    expect(stop).toContain('await setAppStatus(appId, "stopped");');
  });
});

describe("registering a run that is still open", () => {
  const src = readFileSync("src/utils/ml/experimentArtifacts.server.ts", "utf8");

  it("closes it only if it is still open, and otherwise reads what it ended as", () => {
    const at = src.indexOf('if (run.status === "running") {');
    const block = src.slice(at, src.indexOf("checkRegistrable(run)", at));
    expect(block).toMatch(
      /\.eq\("user_id", input\.userId\)\s*\.eq\("status", "running"\)\s*\.select\("id"\);/,
    );
    expect(block).toContain("run.status = now?.status ?? run.status;");
  });
});
