// What a swarm run records for a link: what the source node left.
//
// Nodes write to `outputVar`, and the code recording a link read `out_<source>`
// alone, so any source with a named output recorded an empty preview and 0
// bytes. On the canvas it went further: an unnamed node's default depends on
// its kind, so a link from an unnamed input, condition, router or evaluate node
// recorded nothing either.
//
// Both runners run for real here, so these fail if what a node writes and what
// the link reads ever drift apart. Links are caught where each runner hands
// them to its tracer, which is the last step that sees the text before it is
// stored.
import type { Edge, Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SwarmCheckpoint } from "@/lib/swarmCheckpoint";
import type { SwarmNodeData } from "@/lib/swarmRuntime";

type Link = {
  sourceNodeId: string;
  targetNodeId: string;
  payloadPreview?: string;
  bytes?: number;
};

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
  return {
    noRows,
    serverLinks: [] as Link[],
    checkpoint: null as unknown,
    edgeWrites: [] as { data: Record<string, unknown> }[],
  };
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
  saveCheckpoint: async (a: { checkpoint: unknown }) => {
    h.checkpoint = a.checkpoint;
  },
  loadCheckpoint: async () => h.checkpoint,
  clearCheckpoint: async () => {},
}));
vi.mock("@/utils/observability/serverTracer.server", () => ({
  createServerSwarmTracer: async () => ({
    runId: "11111111-1111-4111-8111-111111111111",
    startStep: async () => {},
    finishStep: async () => {},
    recordEdge: async (a: Link) => {
      h.serverLinks.push(a);
    },
    finish: async () => {},
  }),
}));
vi.mock("@/utils/observability/swarmTrace.functions", () => ({
  startSwarmRun: async () => ({ runId: "22222222-2222-4222-8222-222222222222" }),
  startSwarmStep: async () => ({ stepId: "33333333-3333-4333-8333-333333333333" }),
  finishSwarmStep: async () => ({ ok: true }),
  recordSwarmEdge: async (a: { data: Record<string, unknown> }) => {
    h.edgeWrites.push(a);
    return { ok: true };
  },
  finishSwarmRun: async () => ({ ok: true }),
}));

const { executeSwarmServer } = await import("@/utils/swarmExecute.server");
const { outputVarOf, runSwarm } = await import("@/lib/swarmRuntime");
const { createSwarmTracer } = await import("@/utils/observability/tracer");
const { recordEdgeSchema } = await import("@/utils/observability/swarmTraceStore.server");

const node = (id: string, data: Partial<SwarmNodeData>) =>
  ({ id, position: { x: 0, y: 0 }, data: { label: id, ...data } }) as Node<SwarmNodeData>;
const link = (source: string, target: string, label?: string) =>
  ({ id: `${source}-${target}`, source, target, ...(label ? { label } : {}) }) as Edge;

const INPUT = "Refund request #4821";

const server = (
  nodes: Node<SwarmNodeData>[],
  edges: Edge[],
  more: Partial<Parameters<typeof executeSwarmServer>[0]> = {},
) =>
  executeSwarmServer({
    swarm: { id: "s", name: "s", nodes, edges },
    userId: "u",
    origin: "http://localhost",
    input: INPUT,
    rejectApprovals: false,
    source: "api",
    ...more,
  });

/** A canvas run recording through a stand-in tracer. */
async function canvas(nodes: Node<SwarmNodeData>[], edges: Edge[], input = INPUT) {
  const links: Link[] = [];
  const tracer = {
    runId: "r",
    startStep: () => {},
    finishStep: () => {},
    recordEdge: (a: Link) => void links.push(a),
    finish: async () => {},
  };
  const errors: string[] = [];
  await runSwarm(nodes, edges, {
    initialInput: input,
    tracer,
    onEvent: (e) => {
      if (e.type === "run_error") errors.push(e.error);
    },
  });
  expect(errors).toEqual([]);
  return links;
}

/** The model's answer to every call, as /api/chat streams it. */
function modelSays(text: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
}

beforeEach(() => {
  h.serverLinks.length = 0;
  h.edgeWrites.length = 0;
  h.checkpoint = null;
  vi.unstubAllGlobals();
});

describe("a link on a server run", () => {
  it("records what a source with a named output left", async () => {
    await server(
      [
        node("in", { kind: "input", outputVar: "request" }),
        node("out", { kind: "output", inputs: ["request"] }),
      ],
      [link("in", "out")],
    );
    expect(h.serverLinks).toEqual([
      { sourceNodeId: "in", targetNodeId: "out", payloadPreview: INPUT, bytes: INPUT.length },
    ]);
  });

  it("still records a source with no name, from out_<id>", async () => {
    await server(
      [node("in", { kind: "input" }), node("out", { kind: "output", inputs: ["out_in"] })],
      [link("in", "out")],
    );
    expect(h.serverLinks[0]).toMatchObject({ payloadPreview: INPUT, bytes: INPUT.length });
  });

  it("records each link from its own source along a chain of named outputs", async () => {
    await server(
      [
        node("in", { kind: "input", outputVar: "request" }),
        node("vars", {
          kind: "set_var",
          outputVar: "written",
          stateAssignments: [{ key: "topic", value: "{{request}}" }],
        }),
        node("out", { kind: "output", inputs: ["written"] }),
      ],
      [link("in", "vars"), link("vars", "out")],
    );
    expect(h.serverLinks.map((l) => l.payloadPreview)).toEqual([
      INPUT,
      JSON.stringify({ topic: INPUT }),
    ]);
  });

  it("keeps 500 characters of a long output and counts the whole of it", async () => {
    await server(
      [
        node("in", { kind: "input", outputVar: "request" }),
        node("out", { kind: "output", inputs: ["request"] }),
      ],
      [link("in", "out")],
      { input: "x".repeat(5000) },
    );
    expect(h.serverLinks[0].payloadPreview).toHaveLength(500);
    expect(h.serverLinks[0].bytes).toBe(5000);
  });

  it("records a link past an approval from the state the run resumed with", async () => {
    const nodes = [
      node("in", { kind: "input", outputVar: "request" }),
      node("gate", {
        kind: "approval",
        label: "Approve",
        inputs: ["request"],
        outputVar: "approved_summary",
      }),
      node("out", { kind: "output", inputs: ["approved_summary"] }),
    ];
    const edges = [link("in", "gate"), link("gate", "out")];

    const parked = await server(nodes, edges);
    expect(parked.status).toBe("suspended");
    expect(h.serverLinks).toEqual([
      { sourceNodeId: "in", targetNodeId: "gate", payloadPreview: INPUT, bytes: INPUT.length },
    ]);

    h.serverLinks.length = 0;
    const done = await server(nodes, edges, {
      resume: {
        runId: parked.runId as string,
        checkpoint: h.checkpoint as SwarmCheckpoint,
        decision: { approved: true },
      },
    });
    expect(done.status).toBe("success");
    expect(h.serverLinks).toContainEqual({
      sourceNodeId: "gate",
      targetNodeId: "out",
      payloadPreview: INPUT,
      bytes: INPUT.length,
    });
  });
});

describe("a link on a canvas run", () => {
  it("records what a source with a named output left", async () => {
    const links = await canvas(
      [
        node("in", { kind: "input", outputVar: "request" }),
        node("out", { kind: "output", inputs: ["request"] }),
      ],
      [link("in", "out")],
    );
    expect(links).toEqual([
      { sourceNodeId: "in", targetNodeId: "out", payloadPreview: INPUT, bytes: INPUT.length },
    ]);
  });

  it("records an unnamed input, which writes to `input` rather than out_<id>", async () => {
    const links = await canvas(
      [node("in", { kind: "input" }), node("out", { kind: "output", inputs: ["input"] })],
      [link("in", "out")],
    );
    expect(links[0]).toMatchObject({ payloadPreview: INPUT, bytes: INPUT.length });
  });

  it("records an unnamed condition's decision", async () => {
    modelSays("YES");
    const links = await canvas(
      [
        node("in", { kind: "input" }),
        node("check", { kind: "condition", inputs: ["input"] }),
        node("out", { kind: "output" }),
      ],
      [link("in", "check"), link("check", "out", "yes")],
    );
    expect(links.find((l) => l.sourceNodeId === "check")).toMatchObject({
      payloadPreview: "YES",
      bytes: 3,
    });
  });

  it("records an unnamed router's pick", async () => {
    modelSays("refunds");
    const links = await canvas(
      [
        node("in", { kind: "input" }),
        node("route", { kind: "router", inputs: ["input"] }),
        node("a", { kind: "output" }),
        node("b", { kind: "output" }),
      ],
      [link("in", "route"), link("route", "a", "refunds"), link("route", "b", "other")],
    );
    expect(links.filter((l) => l.sourceNodeId === "route")).toEqual([
      { sourceNodeId: "route", targetNodeId: "a", payloadPreview: "refunds", bytes: 7 },
    ]);
  });

  const metric = { id: "m", name: "M", description: "d", weight: 1, enabled: true };

  it("records an unnamed evaluate's scorecard", async () => {
    modelSays('{"score":1}');
    const links = await canvas(
      [
        node("in", { kind: "input" }),
        node("judge", { kind: "evaluate", inputs: ["input"], evalMetrics: [metric] }),
        node("out", { kind: "output" }),
      ],
      [link("in", "judge"), link("judge", "out")],
    );
    expect(links.find((l) => l.sourceNodeId === "judge")?.payloadPreview).toContain('"score"');
  });

  it("records the fallback of an evaluate that failed and carried on", async () => {
    // Its fallback goes to out_<id>, not to the eval_<id> its result would.
    const links = await canvas(
      [
        node("in", { kind: "input" }),
        node("judge", {
          kind: "evaluate",
          inputs: ["input"],
          evalMetrics: [],
          onError: "continue",
          errorFallback: "not judged",
        }),
        node("out", { kind: "output" }),
      ],
      [link("in", "judge"), link("judge", "out")],
    );
    expect(links.find((l) => l.sourceNodeId === "judge")).toMatchObject({
      payloadPreview: "not judged",
      bytes: 10,
    });
  });

  it("names the variable each node kind really writes", () => {
    const of = (data: Partial<SwarmNodeData>) => outputVarOf(node("n", data));
    expect(of({ kind: "input" })).toBe("input");
    expect(of({ kind: "condition" })).toBe("cond_n");
    expect(of({ kind: "router" })).toBe("route_n");
    expect(of({ kind: "evaluate" })).toBe("eval_n");
    expect(of({ kind: "agent" })).toBe("out_n");
    expect(of({ kind: "condition", outputVar: "decision" })).toBe("decision");
  });
});

describe("the cap on what a link keeps", () => {
  it("reaches the server from a canvas run within it, through the real tracer", async () => {
    const tracer = await createSwarmTracer({ swarmName: "s" });
    await runSwarm(
      [
        node("in", { kind: "input", outputVar: "request" }),
        node("out", { kind: "output", inputs: ["request"] }),
      ],
      [link("in", "out")],
      { initialInput: "x".repeat(5000), tracer, onEvent: () => {} },
    );
    await tracer?.finish({ status: "success" });

    expect(h.edgeWrites).toHaveLength(1);
    const sent = h.edgeWrites[0].data;
    expect(sent.payloadPreview).toHaveLength(500);
    expect(sent.bytes).toBe(5000);
    expect(() => recordEdgeSchema.parse(sent)).not.toThrow();
  });

  it("is 2000 characters in the canvas tracer, whatever it is handed", async () => {
    const tracer = await createSwarmTracer({ swarmName: "s" });
    tracer?.recordEdge({
      sourceNodeId: "a",
      targetNodeId: "b",
      payloadPreview: "x".repeat(5000),
      bytes: 5000,
    });
    await tracer?.finish({ status: "success" });

    const sent = h.edgeWrites[0].data;
    expect(sent.payloadPreview).toHaveLength(2000);
    expect(() => recordEdgeSchema.parse(sent)).not.toThrow();
  });

  it("is refused past 2000 characters by the server, for a caller that skips the tracer", () => {
    const edge = {
      runId: "22222222-2222-4222-8222-222222222222",
      sourceNodeId: "a",
      targetNodeId: "b",
    };
    expect(() => recordEdgeSchema.parse({ ...edge, payloadPreview: "x".repeat(2001) })).toThrow();
  });
});
