// A swarm node's model call is named after its swarm on its trace.
//
// The chat route names a turn "Playground" unless something names it, and
// neither swarm runner named one: a three-node swarm run from the canvas (or
// from the deployed API, or a schedule) listed each node's call in Traces as
// "Playground", beside and indistinguishable from the turns typed in Agent
// Chat. Analytics grouped them together the same way.
//
// Both runners run for real here and the request each sends to /api/chat is
// caught, so these fail if a runner stops saying what it is.
import { readFileSync } from "node:fs";
import type { Edge, Node } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SwarmNodeData } from "@/lib/swarmRuntime";

const h = vi.hoisted(() => {
  // The client answers everything with nothing: nothing here depends on a row.
  const noRows = (): unknown => {
    const chain: unknown = new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === "then"
          ? (ok: (v: unknown) => void) => ok({ data: null, error: null })
          : () => chain,
    });
    return chain;
  };
  return { noRows };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: h.noRows, rpc: h.noRows },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: h.noRows,
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  },
}));
vi.mock("@/utils/provenance/decision.server", () => ({ beginDecision: () => {} }));
vi.mock("@/utils/swarmCheckpoint.server", () => ({
  saveCheckpoint: async () => {},
  loadCheckpoint: async () => null,
  clearCheckpoint: async () => {},
}));
vi.mock("@/utils/observability/serverTracer.server", () => ({
  createServerSwarmTracer: async () => ({
    runId: "11111111-1111-4111-8111-111111111111",
    startStep: async () => {},
    finishStep: async () => {},
    recordEdge: async () => {},
    finish: async () => {},
  }),
}));

const { executeSwarmServer } = await import("@/utils/swarmExecute.server");
const { runSwarm } = await import("@/lib/swarmRuntime");
const { SWARM_TRACE_NAME, swarmTraceName, swarmTraceNameFor } =
  await import("@/lib/swarmTraceName");

const SWARM_ID = "5a5a5a5a-1111-4222-8333-444444444444";

const node = (id: string, data: Partial<SwarmNodeData>) =>
  ({ id, position: { x: 0, y: 0 }, data: { label: id, ...data } }) as Node<SwarmNodeData>;
const link = (source: string, target: string) =>
  ({ id: `${source}-${target}`, source, target }) as Edge;

// input → llm → output, the swarm this was found with.
const NODES = [
  node("in", { kind: "input" }),
  node("llm", { kind: "agent", inputs: ["input"], model: "openai/gpt-4o-mini" }),
  node("out", { kind: "output" }),
];
const EDGES = [link("in", "llm"), link("llm", "out")];

/** Every body sent to /api/chat; the model answers each one with "ok". */
let sent: Record<string, unknown>[] = [];
beforeEach(() => {
  sent = [];
  process.env.INTERNAL_RUN_SECRET = "test-internal-secret";
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
  delete process.env.INTERNAL_RUN_SECRET;
});

describe("the name", () => {
  it("is the swarm's, in the form Traces uses for what is not an agent", () => {
    expect(swarmTraceName("Refund triage")).toBe("Swarm: Refund triage");
    expect(swarmTraceName("  Refund triage  ")).toBe("Swarm: Refund triage");
  });

  it("is 'Swarm' without a name, never 'Playground'", () => {
    for (const none of [undefined, null, "", "   ", 42]) {
      expect(swarmTraceName(none)).toBe(SWARM_TRACE_NAME);
    }
    expect(SWARM_TRACE_NAME).toBe("Swarm");
  });

  it("holds 120 characters, like every other name, and is not cut through an emoji", () => {
    const long = swarmTraceName(`${"a".repeat(111)}🙂🙂🙂`);
    expect(Array.from(long)).toHaveLength(120);
    expect(long.endsWith("🙂")).toBe(true);
  });
});

describe("a canvas run's name, as the chat route reads it", () => {
  const reads: string[] = [];
  const readName = async (id: string) => {
    reads.push(id);
    return "Refund triage";
  };
  beforeEach(() => void (reads.length = 0));

  it("is the swarm's name, read by the id the canvas sent", async () => {
    expect(await swarmTraceNameFor(SWARM_ID, readName)).toBe("Swarm: Refund triage");
    expect(reads).toEqual([SWARM_ID]);
  });

  it("is 'Swarm' with no id, an id that is not one, or no reader, and reads nothing", async () => {
    for (const id of [undefined, "", "not-a-uuid", `${SWARM_ID}' or 1=1`, 7]) {
      expect(await swarmTraceNameFor(id, readName)).toBe("Swarm");
    }
    expect(await swarmTraceNameFor(SWARM_ID, null)).toBe("Swarm");
    expect(reads).toEqual([]);
  });

  it("is 'Swarm' when the swarm cannot be seen or the read fails, and never throws", async () => {
    expect(await swarmTraceNameFor(SWARM_ID, async () => undefined)).toBe("Swarm");
    expect(
      await swarmTraceNameFor(SWARM_ID, async () => {
        throw new Error("connection reset");
      }),
    ).toBe("Swarm");
  });

  it("is read in the chat route as the caller, never with the service role", () => {
    const chat = readFileSync("src/routes/api/chat.ts", "utf8");
    const at = chat.indexOf('} else if (!body.agentId && body.surface === "swarm") {');
    expect(at).toBeGreaterThan(-1);
    const branch = chat.slice(at, chat.indexOf("let agentRouteThroughGateway", at));
    expect(branch).toContain("getServerSupabase(authToken)");
    expect(branch).toContain('.from("swarms").select("name").eq("id", id)');
    expect(branch).toContain("swarmTraceNameFor(");
    expect(branch).not.toContain("supabaseAdmin");
    // The assistant's fixed name, and the internal channel's free one, stand.
    expect(chat).toMatch(/if \(isInternalRun && typeof body\.agentName === "string"/);
    expect(chat).toContain('body.surface === "assistant"');
  });
});

describe("what each runner sends to /api/chat", () => {
  it("a canvas run says it is a swarm and which one, and names nothing itself", async () => {
    await runSwarm(NODES, EDGES, { initialInput: "hi", swarmId: SWARM_ID, onEvent: () => {} });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ surface: "swarm", swarmId: SWARM_ID });
    expect(sent[0]).not.toHaveProperty("agentName");
  });

  it("a canvas swarm never saved still says it is a swarm", async () => {
    await runSwarm(NODES, EDGES, { initialInput: "hi", onEvent: () => {} });
    expect(sent[0]).toMatchObject({ surface: "swarm" });
    expect(sent[0].swarmId).toBeUndefined();
  });

  it("the run manager and the swarm chat pass their swarm's id", () => {
    const runOptions = (file: string) => {
      const text = readFileSync(file, "utf8");
      const at = text.indexOf("await runSwarm(nodes, edges, {");
      expect(at, file).toBeGreaterThan(-1);
      return text.slice(at, text.indexOf("onEvent:", at));
    };
    expect(runOptions("src/lib/swarmRunManager.ts")).toContain("swarmId: params.swarmId,");
    expect(runOptions("src/components/swarms/SwarmChatDialog.tsx")).toMatch(/\n\s*swarmId,\n/);
  });

  it("an Execute Swarm node's inner run names its calls after the inner swarm", () => {
    const rt = readFileSync("src/lib/swarmRuntime.ts", "utf8");
    const sub = rt.slice(rt.indexOf('if (node.data.kind === "subswarm")'));
    expect(sub.slice(0, sub.indexOf("onEvent:"))).toContain("swarmId: subId,");
  });

  it("a server run (deployed API, schedule) names each call after its swarm", async () => {
    const r = await executeSwarmServer({
      swarm: { id: SWARM_ID, name: "Refund triage", nodes: NODES, edges: EDGES },
      userId: "u",
      origin: "http://localhost",
      input: "hi",
      rejectApprovals: false,
      source: "api",
    });
    expect(r).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0].agentName).toBe("Swarm: Refund triage");
  });
});

describe("the Traces page", () => {
  const page = readFileSync("src/routes/_authenticated/traces.tsx", "utf8");

  it("calls the column and its filter Source, since most rows are not an agent's", () => {
    expect(page).toContain("<TableHead>Source</TableHead>");
    expect(page).toContain('<SelectValue placeholder="Source" />');
    expect(page).toContain('<SelectItem value="all">All sources</SelectItem>');
    expect(page).toContain('placeholder="Search prompt, source, model..."');
    expect(page).not.toMatch(/<TableHead>Agent<\/TableHead>|All agents/);
  });
});
