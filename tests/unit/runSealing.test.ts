// Swarm run traces under their owner's user key (R449).
//
// A run's input and output, each step's text and tool calls, what passed along a
// link, a parked run's flow state and the reply kept for an Idempotency-Key are
// sealed under the owner's key. Both writers go through here: the canvas's
// (swarmTraceStore) and the server's (serverTracer). A key that cannot be had
// costs a row its text and never the row, except a checkpoint, which is not
// written at all. Swarm Traces and Quality trends read through the server, and a
// pass seals what was kept before.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";

const h = vi.hoisted(() => ({
  db: null as null | { from: (t: string) => unknown },
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) =>
        token === "alice-token"
          ? { data: { user: { id: "00000000-0000-4000-8000-00000000a11c" } }, error: null }
          : token === "bob-token"
            ? { data: { user: { id: "00000000-0000-4000-8000-000000000b0b" } }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT" } },
    },
    from: (t: string) => h.db!.from(t),
  },
}));

import { __setKeyHierarchyForTests, keyHierarchy } from "@/utils/providers/crypto.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import {
  openCheckpoint,
  openEdgeRow,
  openIdempotentReply,
  openRunInput,
  openRunRow,
  openStepRow,
  sealCheckpoint,
  sealEdgePreview,
  sealIdempotentReply,
  sealOlderRuns,
  sealRunInput,
  sealRunOutput,
  sealStepInput,
  sealStepResult,
} from "@/utils/observability/sealedRuns.server";
import { runPassDetail } from "@/utils/observability/tracePass";
import {
  finishRun,
  finishStep,
  recordEdge,
  startRun,
  startStep,
} from "@/utils/observability/swarmTraceStore.server";
import { createServerSwarmTracer } from "@/utils/observability/serverTracer.server";
import { loadCheckpoint, saveCheckpoint } from "@/utils/swarmCheckpoint.server";
import {
  getSwarmRun,
  listEvalScorecards,
  listSwarmRunEdges,
  listSwarmRunSteps,
} from "@/utils/swarmRuns.functions";
import { storedFilesPassLine } from "@/utils/storage/storedFiles";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore, missingKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const ID4 = "44444444-4444-4444-8444-444444444444";

let fake: FakeDb;
let mem: MemoryKeyStore;

const TABLES = () => ({
  swarm_runs: [],
  swarm_run_steps: [],
  swarm_run_edges: [],
  swarm_run_checkpoints: [],
});

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "f".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest(TABLES());
  h.db = fake.client as never;
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store);
});
afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
  delete process.env.PERSIST_PROMPT_BODIES;
  vi.restoreAllMocks();
});

const ok = <T>(r: T): Exclude<T, { ok: false }> => {
  const v = r as { ok: boolean; error?: string };
  if (!v.ok) throw new Error(`expected ok: ${v.error}`);
  return r as Exclude<T, { ok: false }>;
};

const noText = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(/Halvard/);

/** A key that cannot be had, for writing: the service is down. */
const refuseKeys = (who?: string) => {
  __setKeyHierarchyForTests({
    ...mem.store,
    activeUserKey: async (u: string) => {
      if (!who || u === who) throw new DataKeyUnavailableError("revoked", "denied");
      return mem.store.activeUserKey(u);
    },
  });
  keyHierarchy().forgetAll();
};

const TOOLS = [{ type: "tool_call", name: "search_kb", args: { q: "Halvard" } }];
const RESULT = {
  output: "Halvard earned 4.2m",
  thinking: "Look up Halvard",
  tool_calls: TOOLS,
  memory_used: [{ content: "Halvard is a customer" }],
  rag_chunks: [{ text: "Halvard's contract" }],
  data_extractions: [{ customer: "Halvard" }],
};

const stepRow = (over: Record<string, unknown> = {}) => ({
  id: ID1,
  run_id: ID2,
  user_id: ALICE,
  node_id: "n1",
  node_kind: "agent",
  status: "success",
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  latency_ms: 10,
  tokens_in: 5,
  tokens_out: 6,
  cost_usd: 0.25,
  error_message: null as string | null,
  input: { prompt: "About Halvard" } as unknown,
  ...RESULT,
  ...over,
});
const runRow = (over: Record<string, unknown> = {}) => ({
  id: ID2,
  user_id: ALICE,
  swarm_name: "Payroll",
  status: "success",
  input_prompt: "About Halvard" as string | null,
  final_output: "Halvard earned 4.2m" as string | null,
  total_cost_usd: 0.25,
  swarm_snapshot: { nodes: [{ id: "n1" }], edges: [] },
  ...over,
});
const edgeRow = (over: Record<string, unknown> = {}) => ({
  id: ID3,
  run_id: ID2,
  user_id: ALICE,
  source_node_id: "n1",
  target_node_id: "n2",
  payload_preview: "Halvard earned" as string | null,
  bytes: 14,
  ...over,
});

const sealedStep = async (over: Record<string, unknown> = {}) => {
  const row = stepRow(over);
  return {
    ...row,
    input: await sealStepInput(row.user_id, row.id, row.input),
    ...(await sealStepResult(row.user_id, row.id, RESULT)),
  };
};
const sealedRun = async (over: Record<string, unknown> = {}) => {
  const row = runRow(over);
  return {
    ...row,
    input_prompt: await sealRunInput(row.user_id, row.id, row.input_prompt),
    final_output: await sealRunOutput(row.user_id, row.id, row.final_output),
  };
};

describe("a step, as it is stored", () => {
  it("holds none of what was said, and opens to what it was", async () => {
    const stored = await sealedStep();
    noText(stored);
    expect(stored.input).toMatchObject({ body_sealed: true });
    expect(stored.output).toMatch(/^ck1:/);
    expect(stored.thinking).toMatch(/^ck1:/);
    const opened = await openStepRow(stored);
    expect(opened).toMatchObject({
      input: stepRow().input,
      ...RESULT,
      cost_usd: 0.25,
      body_sealed: true,
      body_dropped: false,
      body_unreadable: null,
    });
  });

  it("does not open on another row, each column alone", async () => {
    const a = await sealedStep();
    const b = await sealedStep({ id: ID3 });
    for (const column of [
      "input",
      "output",
      "thinking",
      "tool_calls",
      "memory_used",
      "rag_chunks",
      "data_extractions",
    ] as const) {
      const moved = await openStepRow({ ...b, [column]: a[column] });
      expect(moved.body_unreadable, column).toMatch(/It did not open/);
      noText(moved);
    }
  });

  it("as it was before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    const input = { prompt: "About Halvard" };
    expect(await sealStepInput(ALICE, ID1, input)).toEqual(input);
    expect(await sealStepResult(ALICE, ID1, RESULT)).toEqual(RESULT);
  });

  it("with its bodies not kept, is marked, and what it has left is still sealed", async () => {
    const input = await sealStepInput(ALICE, ID1, { redacted: true });
    expect(input).toEqual({ redacted: true, body_sealed: true });
    const opened = await openStepRow({ ...stepRow({ output: null, thinking: null }), input });
    expect(opened.input).toEqual({ redacted: true });
  });
});

describe("every value is bound to its own row and column, each moved alone", () => {
  const notOpened = /It did not open/;

  it("a run's input and output", async () => {
    const a = await sealedRun();
    const b = await sealedRun({ id: ID3 });
    for (const column of ["input_prompt", "final_output"] as const) {
      const moved = await openRunRow({ ...b, [column]: a[column] });
      expect(moved.body_unreadable, column).toMatch(notOpened);
      noText(moved);
    }
  });

  it("a run's input and output, in each other's place", async () => {
    const a = await sealedRun();
    const swapped = await openRunRow({ ...a, final_output: a.input_prompt });
    expect(swapped.body_unreadable).toMatch(notOpened);
  });

  it.each([
    ["output", "thinking"],
    ["tool_calls", "memory_used"],
    ["rag_chunks", "data_extractions"],
  ] as const)("a step's %s and %s, in each other's place", async (x, y) => {
    const a = await sealedStep();
    const swapped = await openStepRow({ ...a, [x]: a[y] });
    expect(swapped.body_unreadable).toMatch(notOpened);
  });

  it("a link", async () => {
    const value = await sealEdgePreview(ALICE, ID3, "Halvard earned");
    const moved = await openEdgeRow(edgeRow({ id: ID4, payload_preview: value }));
    expect(moved.body_unreadable).toMatch(notOpened);
    expect(moved.payload_preview).toBeNull();
  });

  it("a checkpoint's flow state and last output", async () => {
    const a = await sealCheckpoint(ALICE, ID2, { ctx: { a: "b" }, last_output: "x" });
    const b = await sealCheckpoint(ALICE, ID3, { ctx: { c: "d" }, last_output: "y" });
    await expect(openCheckpoint(ID3, { ...b, ctx: a.ctx })).rejects.toThrow(/did not open/);
    await expect(openCheckpoint(ID3, { ...b, last_output: a.last_output })).rejects.toThrow(
      /did not open/,
    );
  });
});

describe("a key that cannot be had when a run is written", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("costs a step its text, marks it, and leaves nothing under another key", async () => {
    refuseKeys();
    const input = await sealStepInput(ALICE, ID1, { prompt: "About Halvard" });
    expect(input).toEqual({ body_sealed: true, body_dropped: true });
    const result = await sealStepResult(ALICE, ID1, RESULT);
    noText(result);
    expect(JSON.stringify(result)).not.toMatch(/ck1:/);
    expect(result).toEqual({
      output: null,
      thinking: null,
      tool_calls: [],
      memory_used: [],
      rag_chunks: [],
      data_extractions: [],
      input: { body_sealed: true, body_dropped: true },
    });
    const opened = await openStepRow({ ...stepRow(), ...result });
    expect(opened).toMatchObject({ body_dropped: true, body_unreadable: null, input: {} });
  });

  it("costs a run and a link their text", async () => {
    refuseKeys();
    expect(await sealRunInput(ALICE, ID2, "About Halvard")).toBeNull();
    expect(await sealRunOutput(ALICE, ID2, "About Halvard")).toBeNull();
    expect(await sealEdgePreview(ALICE, ID3, "About Halvard")).toBeNull();
  });

  it("does not stop a canvas run, and its figures are kept", async () => {
    refuseKeys();
    const { runId } = await startRun(ALICE, { inputPrompt: "About Halvard" });
    const { stepId } = await startStep(ALICE, { runId, nodeId: "n1", input: { q: "Halvard" } });
    await finishStep(ALICE, {
      stepId,
      status: "success",
      output: "Halvard",
      tokensIn: 3,
      costUsd: 0.5,
    });
    await finishRun(ALICE, { runId, status: "success", finalOutput: "Halvard" });
    noText(fake.tables);
    expect(fake.tables.swarm_run_steps[0]).toMatchObject({
      status: "success",
      tokens_in: 3,
      cost_usd: 0.5,
      input: { body_sealed: true, body_dropped: true },
    });
    expect(fake.tables.swarm_runs[0]).toMatchObject({ status: "success", total_cost_usd: 0.5 });
  });

  it("keeps no checkpoint at all: a run must not resume from a state with its text gone", async () => {
    refuseKeys();
    await saveCheckpoint({
      runId: ID2,
      userId: ALICE,
      source: "api",
      depth: 0,
      checkpoint: {
        ctx: { answer: "Halvard" },
        lastOutput: "Halvard",
        completedNodeIds: [],
        skippedNodeIds: [],
        deadEdgeIds: [],
        levelIndex: 0,
      },
    });
    expect(fake.tables.swarm_run_checkpoints).toEqual([]);
  });

  it("keeps no reply for an Idempotency-Key, and leaves the record for a retry", async () => {
    refuseKeys();
    expect(await sealIdempotentReply(ALICE, ID1, "k", "completed", { out: "Halvard" })).toEqual({
      status: "failed",
      response: null,
    });
  });
});

describe("a canvas run", () => {
  it("is sealed by every write, bound to the ids the rows are stored under", async () => {
    const { runId } = await startRun(ALICE, {
      inputPrompt: "About Halvard",
      swarmName: "Payroll",
    });
    const { stepId } = await startStep(ALICE, {
      runId,
      nodeId: "n1",
      input: { prompt: "About Halvard" },
    });
    await recordEdge(ALICE, {
      runId,
      sourceNodeId: "n1",
      targetNodeId: "n2",
      payloadPreview: "Halvard earned",
    });
    await finishStep(ALICE, {
      stepId,
      status: "success",
      output: RESULT.output,
      thinking: RESULT.thinking,
      toolCalls: TOOLS,
      memoryUsed: RESULT.memory_used,
      ragChunks: RESULT.rag_chunks,
      dataExtractions: RESULT.data_extractions,
      costUsd: 0.25,
    });
    await finishRun(ALICE, { runId, status: "success", finalOutput: "Halvard earned 4.2m" });

    noText(fake.tables);
    const run = fake.tables.swarm_runs[0] as ReturnType<typeof runRow>;
    expect(run.id).toBe(runId);
    expect(run.total_cost_usd).toBe(0.25);
    expect(await openRunRow(run)).toMatchObject({
      input_prompt: "About Halvard",
      final_output: "Halvard earned 4.2m",
      body_unreadable: null,
    });
    const step = fake.tables.swarm_run_steps[0] as ReturnType<typeof stepRow>;
    expect(step.id).toBe(stepId);
    expect(await openStepRow(step)).toMatchObject({ ...RESULT, body_unreadable: null });
    const edge = fake.tables.swarm_run_edges[0] as ReturnType<typeof edgeRow>;
    expect(edge.id).toMatch(/^[0-9a-f]{8}-/);
    expect(await openEdgeRow(edge)).toMatchObject({ payload_preview: "Halvard earned" });
  });

  it("keeps the graph snapshot readable: it is the swarm's own definition", async () => {
    await startRun(ALICE, { swarmSnapshot: { nodes: [{ id: "n1" }], edges: [] } });
    expect(fake.tables.swarm_runs[0]!.swarm_snapshot).toEqual({ nodes: [{ id: "n1" }], edges: [] });
  });

  it("drops its bodies, as ever, with PERSIST_PROMPT_BODIES=false", async () => {
    process.env.PERSIST_PROMPT_BODIES = "false";
    const { runId } = await startRun(ALICE, { inputPrompt: "About Halvard" });
    const { stepId } = await startStep(ALICE, { runId, nodeId: "n1", input: { q: "Halvard" } });
    await finishStep(ALICE, { stepId, status: "success", output: "Halvard" });
    noText(fake.tables);
    expect(fake.tables.swarm_runs[0]!.input_prompt).toBeNull();
    expect(fake.tables.swarm_run_steps[0]).toMatchObject({
      input: { redacted: true, body_sealed: true },
      output: null,
    });
  });
});

describe("a server run", () => {
  const trace = (over = {}) =>
    createServerSwarmTracer({
      userId: ALICE,
      swarmName: "Payroll",
      inputPrompt: "About Halvard",
      ...over,
    });

  it("is sealed by every write, bound to the ids the rows are stored under", async () => {
    const tracer = (await trace())!;
    await tracer.startStep({ nodeId: "n1", input: { prompt: "About Halvard" } });
    await tracer.startStep({ nodeId: "n2" });
    await tracer.recordEdge({
      sourceNodeId: "n1",
      targetNodeId: "n2",
      payloadPreview: "Halvard earned",
    });
    await tracer.finishStep("n1", {
      status: "success",
      output: RESULT.output,
      toolCalls: TOOLS,
      costUsd: 0.25,
    });
    await tracer.finish({ status: "success", finalOutput: "Halvard earned 4.2m" });

    noText(fake.tables);
    const run = fake.tables.swarm_runs[0] as ReturnType<typeof runRow>;
    expect(run.id).toBe(tracer.runId);
    expect(await openRunRow(run)).toMatchObject({
      input_prompt: "About Halvard",
      final_output: "Halvard earned 4.2m",
      total_cost_usd: 0.25,
    });
    const step = fake.tables.swarm_run_steps[0] as ReturnType<typeof stepRow>;
    expect(step.id).toMatch(/^[0-9a-f]{8}-/);
    expect(await openStepRow({ ...stepRow(), ...step })).toMatchObject({
      input: { prompt: "About Halvard" },
      output: RESULT.output,
      tool_calls: TOOLS,
      body_unreadable: null,
    });
    const edge = fake.tables.swarm_run_edges[0] as ReturnType<typeof edgeRow>;
    expect(await openEdgeRow(edge)).toMatchObject({ payload_preview: "Halvard earned" });
  });

  it("keeps no link preview with PERSIST_PROMPT_BODIES=false, which it used to", async () => {
    process.env.PERSIST_PROMPT_BODIES = "false";
    const tracer = (await trace())!;
    await tracer.startStep({ nodeId: "n1" });
    await tracer.startStep({ nodeId: "n2" });
    await tracer.recordEdge({
      sourceNodeId: "n1",
      targetNodeId: "n2",
      payloadPreview: "Halvard earned",
    });
    expect(fake.tables.swarm_run_edges[0]!.payload_preview).toBeNull();
  });

  it("is not stopped by a key that cannot be had, and records its cost", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    refuseKeys();
    const tracer = (await trace())!;
    await tracer.startStep({ nodeId: "n1", input: { q: "Halvard" } });
    await tracer.finishStep("n1", { status: "success", output: "Halvard", costUsd: 0.5 });
    await tracer.finish({ status: "success", finalOutput: "Halvard" });
    noText(fake.tables);
    expect(fake.tables.swarm_runs[0]).toMatchObject({ status: "success", total_cost_usd: 0.5 });
  });
});

describe("a checkpoint", () => {
  const CP = {
    ctx: { answer: "Halvard" },
    lastOutput: "Halvard earned",
    completedNodeIds: ["n1"],
    skippedNodeIds: [],
    deadEdgeIds: [],
    levelIndex: 2,
    suspendedNodeId: "n3",
  };
  const save = () =>
    saveCheckpoint({ runId: ID2, userId: ALICE, source: "api", depth: 0, checkpoint: CP });

  it("holds none of the run's state, and resumes from what it was", async () => {
    await save();
    noText(fake.tables.swarm_run_checkpoints);
    const row = fake.tables.swarm_run_checkpoints[0]!;
    expect(row).toMatchObject({ completed_node_ids: ["n1"], level_index: 2 });
    expect(await loadCheckpoint(ID2, ALICE)).toMatchObject(CP);
  });

  it("seals an empty output too, which is how the pass tells it is done", async () => {
    const sealed = await sealCheckpoint(ALICE, ID2, { ctx: {}, last_output: "" });
    expect(sealed.last_output).toMatch(/^ck1:/);
    expect((await openCheckpoint(ID2, sealed)).last_output).toBe("");
  });

  it("is another user's nothing", async () => {
    await save();
    expect(await loadCheckpoint(ID2, BOB)).toBeNull();
  });

  it("reads as it was from before R449", async () => {
    fake.tables.swarm_run_checkpoints.push({
      run_id: ID2,
      user_id: ALICE,
      ctx: { a: "b" },
      last_output: "plain",
      level_index: 1,
    });
    expect(await loadCheckpoint(ID2, ALICE)).toMatchObject({
      ctx: { a: "b" },
      lastOutput: "plain",
    });
  });

  it("whose key is gone is an error, never 'nothing to resume'", async () => {
    await save();
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    await expect(loadCheckpoint(ID2, ALICE)).rejects.toThrow(/erased/);
  });

  it("is not bound to another run", async () => {
    await save();
    const row = fake.tables.swarm_run_checkpoints[0]! as { ctx: unknown; last_output: string };
    await expect(openCheckpoint(ID3, row)).rejects.toThrow(/did not open/);
  });

  it("before the user-key tables exist, is stored as it was", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    await save();
    expect(fake.tables.swarm_run_checkpoints[0]).toMatchObject({
      ctx: { answer: "Halvard" },
      last_output: "Halvard earned",
    });
  });
});

describe("what resuming a run reads", () => {
  it("opens the run's input, and says when it cannot", async () => {
    const run = await sealedRun();
    expect(await openRunInput(run)).toBe("About Halvard");
    expect(await openRunInput({ id: ID2, input_prompt: null })).toBeNull();
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    await expect(openRunInput(run)).rejects.toThrow(/erased/);
  });

  it("does not take a checkpoint it cannot open for a run already resumed", () => {
    const src = readFileSync(path.resolve("src/utils/swarmResume.functions.ts"), "utf8");
    const at = src.indexOf("held = await loadCheckpoint(run.id, run.user_id);");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toContain("The run was not resumed: ");
    expect(src).not.toContain("if (!(await loadCheckpoint(");
  });

  it("the executor opens the input it resumes with", () => {
    const src = readFileSync(path.resolve("src/utils/swarmExecute.server.ts"), "utf8");
    expect(src).toContain('input: (await openRunInput(run)) ?? "",');
    expect(src).not.toContain('input: run.input_prompt ?? ""');
  });
});

describe("the reply kept for an Idempotency-Key", () => {
  it("is sealed, bound to its key, and opens", async () => {
    const r = await sealIdempotentReply(ALICE, ID1, "k1", "completed", { out: "Halvard" });
    noText(r);
    expect(r.status).toBe("completed");
    expect(await openIdempotentReply(r.response, ID1, "k1")).toEqual({ out: "Halvard" });
    await expect(openIdempotentReply(r.response, ID1, "k2")).rejects.toThrow(/did not open/);
    await expect(openIdempotentReply(r.response, ID2, "k1")).rejects.toThrow(/did not open/);
  });

  it("reads as it was from before R449", async () => {
    expect(await openIdempotentReply({ out: "x" }, ID1, "k1")).toEqual({ out: "x" });
  });

  it("the route seals what it keeps and refuses, not re-runs, what it cannot open", () => {
    const src = readFileSync(path.resolve("src/routes/api/swarm.run.ts"), "utf8");
    expect(src).toContain("const sealed = await sealIdempotentReply(");
    expect(src).toContain("response: sealed.response as never");
    expect(src).not.toContain("response: body as never");
    const at = src.indexOf('verdict.action === "replay"');
    const branch = src.slice(at, src.indexOf('verdict.action === "in_progress"'));
    expect(branch).toContain("await openIdempotentReply(verdict.response, key.id, idemKey)");
    expect(branch).toContain("503");
  });
});

describe("the Swarm Traces reads", () => {
  const seed = async () => {
    fake.tables.swarm_runs.push(await sealedRun());
    fake.tables.swarm_run_steps.push(await sealedStep());
    fake.tables.swarm_run_edges.push({
      ...edgeRow(),
      payload_preview: await sealEdgePreview(ALICE, ID3, "Halvard earned"),
    });
  };
  const page = (t: string) => ({
    data: { access_token: t, run_id: ID2, after: null, size: 100 },
  });

  it("open a run, its steps and links for its owner", async () => {
    await seed();
    const r = ok(await getSwarmRun({ data: { access_token: "alice-token", run_id: ID2 } }));
    expect(r.run).toMatchObject({
      input_prompt: "About Halvard",
      final_output: "Halvard earned 4.2m",
      total_cost_usd: 0.25,
      body_sealed: true,
      body_unreadable: null,
    });
    const s = ok(await listSwarmRunSteps(page("alice-token")));
    expect(s.steps[0]).toMatchObject({ ...RESULT, body_unreadable: null });
    const e = ok(await listSwarmRunEdges(page("alice-token")));
    expect(e.edges[0]).toMatchObject({ payload_preview: "Halvard earned" });
  });

  it("give another user nothing", async () => {
    await seed();
    expect(
      ok(await getSwarmRun({ data: { access_token: "bob-token", run_id: ID2 } })).run,
    ).toBeNull();
    expect(ok(await listSwarmRunSteps(page("bob-token"))).steps).toEqual([]);
    expect(ok(await listSwarmRunEdges(page("bob-token"))).edges).toEqual([]);
  });

  it.each(["not-a-run", "11111111", "1' or 1=1"])(
    "take the address %s for no run, not an error",
    async (run_id) => {
      await seed();
      const access_token = "alice-token";
      const asked = fake.log.length;
      expect(ok(await getSwarmRun({ data: { access_token, run_id } })).run).toBeNull();
      const paged = { data: { access_token, run_id, after: null, size: 100 } };
      expect(ok(await listSwarmRunSteps(paged)).steps).toEqual([]);
      expect(ok(await listSwarmRunEdges(paged)).edges).toEqual([]);
      // Never asked: Postgres answers an id like this with an error, which a page
      // would show as a failed read, where this fake only finds nothing.
      expect(fake.log.length).toBe(asked);
    },
  );

  it("refuse a caller with no session", async () => {
    await seed();
    expect(await getSwarmRun({ data: { access_token: "nope", run_id: ID2 } })).toMatchObject({
      ok: false,
    });
    expect(await listSwarmRunSteps(page("nope"))).toMatchObject({ ok: false });
    expect(await listSwarmRunEdges(page("nope"))).toMatchObject({ ok: false });
  });

  it("page by id", async () => {
    fake.tables.swarm_run_steps.push(await sealedStep({ id: ID1 }), await sealedStep({ id: ID3 }));
    const r = ok(
      await listSwarmRunSteps({
        data: { access_token: "alice-token", run_id: ID2, after: ID1, size: 100 },
      }),
    );
    expect(r.steps.map((s) => s.id)).toEqual([ID3]);
  });

  it("with the key gone still load, keep the figures and say why", async () => {
    await seed();
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const r = ok(await getSwarmRun({ data: { access_token: "alice-token", run_id: ID2 } }));
    expect(r.run).toMatchObject({ input_prompt: null, final_output: null, total_cost_usd: 0.25 });
    expect(r.run!.body_unreadable).toMatch(/erased/);
    const s = ok(await listSwarmRunSteps(page("alice-token")));
    expect(s.steps[0]).toMatchObject({
      input: {},
      output: null,
      thinking: null,
      tool_calls: [],
      memory_used: [],
      rag_chunks: [],
      data_extractions: [],
      cost_usd: 0.25,
    });
    expect(s.steps[0]!.body_unreadable).toMatch(/erased/);
    const e = ok(await listSwarmRunEdges(page("alice-token")));
    expect(e.edges[0]).toMatchObject({ payload_preview: null, bytes: 14 });
    expect(e.edges[0]!.body_unreadable).toMatch(/erased/);
  });

  it("read rows from before R449 as they are", async () => {
    fake.tables.swarm_runs.push(runRow());
    fake.tables.swarm_run_steps.push(stepRow());
    const r = ok(await getSwarmRun({ data: { access_token: "alice-token", run_id: ID2 } }));
    expect(r.run).toMatchObject({ input_prompt: "About Halvard", body_sealed: false });
    expect(ok(await listSwarmRunSteps(page("alice-token"))).steps[0]).toMatchObject({
      input: stepRow().input,
      ...RESULT,
      body_sealed: false,
    });
  });
});

describe("Quality trends", () => {
  const card = JSON.stringify({ overall: 0.8, pass: true, metrics: { accuracy: 0.8 } });
  const evalStep = async (id: string, user = ALICE, output: string | null = card) => ({
    ...stepRow({ id, user_id: user, node_kind: "evaluate", run_id: ID2 }),
    output: (await sealStepResult(user, id, { output })).output,
  });

  it("gets scores from sealed outputs, the caller's alone, with the swarm's name", async () => {
    fake.tables.swarm_runs.push(runRow());
    fake.tables.swarm_run_steps.push(
      await evalStep(ID1),
      await evalStep(ID3, BOB),
      // Reads like a scorecard, and is not an Evaluate step's.
      { ...(await evalStep(ID4)), node_kind: "agent" },
    );
    const r = ok(await listEvalScorecards({ data: { access_token: "alice-token" } }));
    expect(r.unreadable).toBe(0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ swarm_name: "Payroll", overall: 0.8, pass: true });
  });

  it("sends back the scores and nothing a step wrote around them", async () => {
    fake.tables.swarm_runs.push(runRow());
    fake.tables.swarm_run_steps.push(
      await evalStep(ID1, ALICE, `Halvard's answer holds up: ${card}`),
    );
    const r = ok(await listEvalScorecards({ data: { access_token: "alice-token" } }));
    expect(r.items).toHaveLength(1);
    noText(r);
  });

  it("counts what it cannot read, and asks for a gone key once", async () => {
    fake.tables.swarm_runs.push(runRow());
    fake.tables.swarm_run_steps.push(await evalStep(ID1), await evalStep(ID3));
    mem.erase(ALICE);
    keyHierarchy().forgetAll();
    const before = mem.calls.userKeyByKid;
    const r = ok(await listEvalScorecards({ data: { access_token: "alice-token" } }));
    expect(r).toMatchObject({ items: [], unreadable: 2 });
    expect(mem.calls.userKeyByKid - before).toBe(1);
  });

  it("does not take unreadable scorecards for an account with none", () => {
    const src = readFileSync(
      path.resolve("src/components/observability/QualityTrends.tsx"),
      "utf8",
    );
    const notice = src.indexOf("if (trends.total === 0 && unreadable > 0) {");
    const onboarding = src.indexOf("if (trends.total === 0) {");
    expect(notice).toBeGreaterThan(0);
    expect(notice).toBeLessThan(onboarding);
  });
});

describe("what reads these tables without the key", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");

  it("the run page and Quality trends ask the server", () => {
    for (const f of [
      "src/routes/_authenticated/analytics_.observability.$runId.tsx",
      "src/components/observability/QualityTrends.tsx",
    ]) {
      const src = read(f);
      expect(src, f).not.toContain("@/integrations/supabase/client");
      expect(src, f).not.toContain('.from("swarm_run');
    }
  });

  it.each([
    [
      "src/routes/_authenticated/analytics_.observability.tsx",
      '.from("swarm_runs")\n        .select(\n',
    ],
    ["src/components/swarms/RecentRunsPanel.tsx", '.from("swarm_runs")\n      .select(\n'],
  ])("%s reads no body", (f, anchor) => {
    const src = read(f);
    const at = src.indexOf(anchor);
    expect(at, f).toBeGreaterThan(0);
    const select = src.slice(at, src.indexOf(".order(", at));
    expect(select).toContain("status");
    expect(select).not.toMatch(/input_prompt|final_output|swarm_snapshot|\*/);
  });

  it("the OpenTelemetry export reads no body", () => {
    const src = read("src/utils/observability/otelExport.server.ts");
    for (const t of ['.from("swarm_runs")', '.from("swarm_run_steps")']) {
      const at = src.indexOf(t);
      const select = src.slice(at, src.indexOf(".in(", at));
      expect(select, t).toContain("status");
      expect(select, t).not.toMatch(/input_prompt|final_output|\boutput\b|thinking|tool_calls/);
    }
  });
});

describe("the pass over runs kept before R449", () => {
  const seedPlain = () => {
    fake.tables.swarm_runs.push(runRow());
    fake.tables.swarm_run_steps.push(stepRow());
    fake.tables.swarm_run_edges.push(edgeRow());
    fake.tables.swarm_run_checkpoints.push({
      run_id: ID2,
      user_id: ALICE,
      ctx: { a: "Halvard" },
      last_output: "Halvard",
    });
  };

  it("seals all four, says how many, and has nothing left the second time", async () => {
    seedPlain();
    expect(await sealOlderRuns()).toEqual({
      runs: 1,
      steps: 1,
      edges: 1,
      checkpoints: 1,
      unreadable: 0,
      left: false,
      failed: 0,
      errors: [],
    });
    noText(fake.tables);
    expect(await openRunRow(fake.tables.swarm_runs[0] as ReturnType<typeof runRow>)).toMatchObject({
      input_prompt: "About Halvard",
      final_output: "Halvard earned 4.2m",
    });
    expect(
      await openStepRow(fake.tables.swarm_run_steps[0] as ReturnType<typeof stepRow>),
    ).toMatchObject({ ...RESULT, input: stepRow().input, body_unreadable: null });
    expect(await loadCheckpoint(ID2, ALICE)).toMatchObject({
      ctx: { a: "Halvard" },
      lastOutput: "Halvard",
    });
    // Nothing is even tried on what is done: not a write its guard would refuse.
    const writes = () => fake.log.filter((l: string) => l.startsWith("update ")).length;
    const before = writes();
    expect(await sealOlderRuns()).toMatchObject({ runs: 0, steps: 0, edges: 0, checkpoints: 0 });
    expect(writes()).toBe(before);
  });

  it("has nothing to do for an empty value, and tries nothing", async () => {
    fake.tables.swarm_runs.push(runRow({ input_prompt: "", final_output: "" }));
    fake.tables.swarm_run_edges.push(edgeRow({ payload_preview: "" }));
    expect(await sealOlderRuns()).toMatchObject({ runs: 0, edges: 0, failed: 0 });
    expect(fake.log.filter((l: string) => l.startsWith("update "))).toEqual([]);
  });

  it("finds a run with only an output to seal", async () => {
    fake.tables.swarm_runs.push(runRow({ input_prompt: null }));
    expect((await sealOlderRuns()).runs).toBe(1);
    expect(fake.tables.swarm_runs[0]!.final_output).toMatch(/^ck1:/);
  });

  it("does not seal twice what a run has sealed, and writes only what it sealed", async () => {
    const sealed = await sealedRun();
    fake.tables.swarm_runs.push({ ...sealed, input_prompt: "About Halvard" });
    expect((await sealOlderRuns()).runs).toBe(1);
    const run = fake.tables.swarm_runs[0] as ReturnType<typeof runRow>;
    expect(run.final_output).toBe(sealed.final_output);
    expect(await openRunRow(run)).toMatchObject({
      input_prompt: "About Halvard",
      final_output: "Halvard earned 4.2m",
    });
  });

  it("seals only the input of a step not finished: its finish writes the rest", async () => {
    fake.tables.swarm_run_steps.push(
      stepRow({ status: "running", finished_at: null, output: null, tool_calls: [] }),
    );
    expect((await sealOlderRuns()).steps).toBe(1);
    const step = fake.tables.swarm_run_steps[0]!;
    expect(step.input).toMatchObject({ body_sealed: true });
    expect(step.output).toBeNull();
    expect(step.tool_calls).toEqual([]);
  });

  it("does not seal twice a column a finish already sealed", async () => {
    const sealed = await sealedStep();
    fake.tables.swarm_run_steps.push({ ...sealed, input: stepRow().input });
    expect((await sealOlderRuns()).steps).toBe(1);
    const opened = await openStepRow(fake.tables.swarm_run_steps[0] as ReturnType<typeof stepRow>);
    expect(opened).toMatchObject({ ...RESULT, input: stepRow().input, body_unreadable: null });
  });

  it("leaves a step that moved on while it worked", async () => {
    fake.tables.swarm_run_steps.push(stepRow({ status: "awaiting_approval" }));
    const real = fake.client.from.bind(fake.client);
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        const update = q.update.bind(q);
        q.update = (p: unknown) => {
          Object.assign(fake.tables.swarm_run_steps[0]!, { status: "success" });
          return update(p);
        };
        return q;
      },
    } as never;
    expect((await sealOlderRuns()).steps).toBe(0);
    expect(fake.tables.swarm_run_steps[0]!.output).toBe(RESULT.output);
  });

  /** Runs `change` just before the pass's write, as another writer would. */
  const beforeWrite = (change: () => void) => {
    const real = fake.client.from.bind(fake.client);
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        const update = q.update.bind(q);
        q.update = (p: unknown) => {
          change();
          return update(p);
        };
        return q;
      },
    } as never;
  };

  it("does not write over a run sealed while it worked", async () => {
    const value = await sealRunInput(ALICE, ID2, "Written meanwhile");
    fake.tables.swarm_runs.push(runRow({ final_output: null }));
    beforeWrite(() => Object.assign(fake.tables.swarm_runs[0]!, { input_prompt: value }));
    expect((await sealOlderRuns()).runs).toBe(0);
    expect(fake.tables.swarm_runs[0]!.input_prompt).toBe(value);
  });

  it("does not write over a step sealed while it worked", async () => {
    const input = await sealStepInput(ALICE, ID1, { prompt: "Written meanwhile" });
    fake.tables.swarm_run_steps.push(stepRow());
    beforeWrite(() => Object.assign(fake.tables.swarm_run_steps[0]!, { input }));
    expect((await sealOlderRuns()).steps).toBe(0);
    expect(fake.tables.swarm_run_steps[0]!.input).toEqual(input);
    expect(fake.tables.swarm_run_steps[0]!.output).toBe(RESULT.output);
  });

  it("does not write over a link sealed while it worked", async () => {
    const value = await sealEdgePreview(ALICE, ID3, "Written meanwhile");
    fake.tables.swarm_run_edges.push(edgeRow());
    beforeWrite(() => Object.assign(fake.tables.swarm_run_edges[0]!, { payload_preview: value }));
    expect((await sealOlderRuns()).edges).toBe(0);
    expect(fake.tables.swarm_run_edges[0]!.payload_preview).toBe(value);
  });

  it("does not write over a checkpoint saved while it worked", async () => {
    const newer = await sealCheckpoint(ALICE, ID2, { ctx: { n: "2" }, last_output: "newer" });
    fake.tables.swarm_run_checkpoints.push({
      run_id: ID2,
      user_id: ALICE,
      ctx: { n: "1" },
      last_output: "older",
    });
    beforeWrite(() => Object.assign(fake.tables.swarm_run_checkpoints[0]!, newer));
    expect((await sealOlderRuns()).checkpoints).toBe(0);
    expect(fake.tables.swarm_run_checkpoints[0]).toMatchObject(newer);
  });

  it("stops at its limit, across the tables, and says more is left", async () => {
    seedPlain();
    const r = await sealOlderRuns({ limit: 2 });
    expect(r).toMatchObject({ runs: 1, steps: 1, edges: 0, left: true });
    expect(await sealOlderRuns({ limit: 2 })).toMatchObject({
      edges: 1,
      checkpoints: 1,
      left: false,
    });
  });

  it("counts and leaves a row whose owner's key is refused, and goes on", async () => {
    fake.tables.swarm_runs.push(runRow(), runRow({ id: ID3, user_id: BOB }));
    refuseKeys(ALICE);
    const r = await sealOlderRuns();
    expect(r).toMatchObject({ runs: 1, unreadable: 1, failed: 0 });
    expect(fake.tables.swarm_runs[0]).toEqual(runRow());
  });

  it("does nothing before the user-key tables exist", async () => {
    __setKeyHierarchyForTests(missingKeyStore());
    seedPlain();
    expect(await sealOlderRuns()).toMatchObject({ runs: 0, steps: 0, edges: 0, checkpoints: 0 });
    expect(fake.tables.swarm_runs[0]).toEqual(runRow());
  });

  it("reports a read that failed, and goes on to the next table", async () => {
    fake = fakePostgrest({ swarm_run_steps: [stepRow()] });
    h.db = fake.client as never;
    const r = await sealOlderRuns();
    expect(r.steps).toBe(1);
    expect(r.failed).toBe(4);
    expect(r.errors[0]).toMatch(/^runs: /);
  });

  it("reports a write that failed, and goes on", async () => {
    fake.tables.swarm_run_edges.push(edgeRow(), edgeRow({ id: ID4 }));
    const real = fake.client.from.bind(fake.client);
    let writes = 0;
    h.db = {
      from: (t: string) => {
        const q = real(t) as unknown as { update: (p: unknown) => unknown };
        const update = q.update.bind(q);
        q.update = (p: unknown) => {
          if (++writes > 1) return update(p);
          const refused = {
            eq: () => refused,
            not: () => refused,
            select: async () => ({ data: null, error: { message: "refused" } }),
          };
          return refused;
        };
        return q;
      },
    } as never;
    const r = await sealOlderRuns();
    expect(r).toMatchObject({ edges: 1, failed: 1 });
    expect(r.errors[0]).toBe(`links ${ID3}: refused`);
  });
});

describe("what the pass reports", () => {
  it("is in the audit row only when it has something to say", () => {
    const empty = {
      runs: 0,
      steps: 0,
      edges: 0,
      checkpoints: 0,
      unreadable: 0,
      left: false,
      failed: 0,
      errors: [],
    };
    expect(runPassDetail(empty)).toEqual({});
    expect(
      runPassDetail({
        runs: 1,
        steps: 2,
        edges: 3,
        checkpoints: 4,
        unreadable: 5,
        left: true,
        failed: 6,
        errors: ["x"],
      }),
    ).toEqual({
      swarm_runs_sealed: 1,
      run_steps_sealed: 2,
      run_links_sealed: 3,
      run_checkpoints_sealed: 4,
      runs_unreadable: 5,
      runs_left: true,
      runs_failed: 6,
      runs_errors: ["x"],
    });
  });

  it("reads as a line on the card", () => {
    const line = storedFilesPassLine({
      files: 0,
      documents: 0,
      dataset_copies: 0,
      swarm_runs_sealed: 2,
      run_steps_sealed: 6,
      run_links_sealed: 4,
      run_checkpoints_sealed: 1,
      runs_unreadable: 1,
      runs_left: true,
      runs_failed: 1,
    });
    expect(line).toContain(
      "2 swarm runs, 6 run steps, 4 run links, 1 run state encrypted under their owner's key",
    );
    expect(line).toContain("1 of swarm run traces whose owner's key cannot be had now");
    expect(line).toContain("more swarm run traces left for the next pass");
    expect(line).toContain("1 of swarm run traces failed");
  });

  it("has indexes that match what it asks", () => {
    const sql = readFileSync(
      path.resolve("supabase/migrations/20261107000000_swarm_run_seal_index.sql"),
      "utf8",
    );
    expect(sql).toContain("input ->> 'body_sealed' IS NULL");
    expect(sql).toContain("input_prompt NOT LIKE 'ck1:%'");
    expect(sql).toContain("final_output NOT LIKE 'ck1:%'");
    expect(sql).toContain("payload_preview NOT LIKE 'ck1:%'");
  });
});
