// A canvas swarm run is one decision, and every node's model call joins it.
//
// A server run (deployed API, schedule) begins a "swarm_run" decision with the
// run's id and passes that id with each node's call, so Traces opens any of its
// calls on the whole run: "swarm run · 3 model turns", the data its tools read,
// a passport for all of it. A canvas run did neither. Each node's call began a
// decision of its own, so the same three-node swarm read as three unrelated
// "chat turn · 1 model turn" entries, with nothing tying them to the run on the
// Runs page.
//
// The canvas run's row now begins the decision (startRun), and the canvas sends
// the run's id with each call; the chat route already adopts a uuid it is given
// (that is how the server runner joins its calls).
import { readFileSync } from "node:fs";
import type { Edge, Node } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SwarmNodeData } from "@/lib/swarmRuntime";

const ME = "00000000-0000-4000-8000-0000000000a1";
const RUN_ID = "7e7e7e7e-1111-4222-8333-444444444444";

const h = vi.hoisted(() => {
  // The browser client answers everything with nothing.
  const noRows = (): unknown => {
    const chain: unknown = new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === "then"
          ? (ok: (v: unknown) => void) => ok({ data: null, error: null })
          : () => chain,
    });
    return chain;
  };
  return { noRows, db: null as null | { from: (t: string) => unknown } };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => h.db!.from(t) },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: h.noRows,
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));

import { __setKeyHierarchyForTests } from "@/utils/providers/crypto.server";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore } from "../fixtures/keyStores";

const { runSwarm } = await import("@/lib/swarmRuntime");
const { startRun } = await import("@/utils/observability/swarmTraceStore.server");

const node = (id: string, data: Partial<SwarmNodeData>) =>
  ({ id, position: { x: 0, y: 0 }, data: { label: id, ...data } }) as Node<SwarmNodeData>;
const link = (source: string, target: string) =>
  ({ id: `${source}-${target}`, source, target }) as Edge;

// input → writer → checker → output: two model calls in one run.
const NODES = [
  node("in", { kind: "input" }),
  node("writer", { kind: "agent", inputs: ["input"], outputVar: "draft" }),
  node("checker", { kind: "agent", inputs: ["draft"] }),
  node("out", { kind: "output" }),
];
const EDGES = [link("in", "writer"), link("writer", "checker"), link("checker", "out")];

let fake: FakeDb;
let sent: Record<string, unknown>[] = [];
beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "f".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest({ swarm_runs: [], decisions: [] });
  h.db = fake.client as never;
  __setKeyHierarchyForTests(memoryKeyStore().store);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
});

describe("a recorded canvas run", () => {
  it("sends its run id as the decision of every node's call", async () => {
    await runSwarm(NODES, EDGES, { initialInput: "hi", dbRunId: RUN_ID, onEvent: () => {} });
    expect(sent).toHaveLength(2);
    expect(sent.map((b) => b.decisionId)).toEqual([RUN_ID, RUN_ID]);
  });

  it("is begun as a 'swarm_run' decision with the run's own id, owned by its user", async () => {
    const { runId } = await startRun(ME, { swarmName: "Refund triage", inputPrompt: "hi" });
    await vi.waitFor(() => expect(fake.tables.decisions).toHaveLength(1));
    expect(fake.tables.decisions[0]).toMatchObject({
      id: runId,
      user_id: ME,
      kind: "swarm_run",
      root_ref: runId,
    });
  });

  it("is the run the canvas records: the run manager passes the tracer's run id", () => {
    const manager = readFileSync("src/lib/swarmRunManager.ts", "utf8");
    expect(manager).toContain("dbRunId: tracer?.runId,");
  });

  it("is adopted by the chat route, which joins a uuid it is given rather than begin a new one", () => {
    const chat = readFileSync("src/routes/api/chat.ts", "utf8");
    expect(chat).toMatch(
      /const decisionId =\s*body\.decisionId && DECISION_ID_RE\.test\(body\.decisionId\)\s*\? body\.decisionId/,
    );
  });
});

describe("an unrecorded canvas run (tracing off, swarm chat, a node's test run)", () => {
  it("sends no decision, so each call stays a decision of its own as before", async () => {
    await runSwarm(NODES, EDGES, { initialInput: "hi", onEvent: () => {} });
    expect(sent).toHaveLength(2);
    for (const b of sent) expect(b).not.toHaveProperty("decisionId");
  });
});
