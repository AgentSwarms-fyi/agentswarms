// A browser can read its swarm runs but no longer write them (R421,
// VA-2026-10-25-31, -47, -48).
//
// swarm_runs, its steps and edges were `FOR ALL` to their owner because the
// canvas tracer wrote them from the page: a user could delete a run, zero its
// cost or rewrite a step at any time. swarm_run_checkpoints, the state a parked
// run resumes from, was `FOR ALL` too, so the owner could rewrite what an
// approved step goes on to send. Migration 20261103000000 leaves the owner
// SELECT only; the canvas tracer and Cancel go through server functions whose
// rules live in swarmTraceStore.server.ts, run here against an in-memory
// stand-in for the tables.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "00000000-0000-4000-8000-0000000000a1";
const THEM = "00000000-0000-4000-8000-0000000000b2";

type Row = Record<string, unknown>;
let db: Record<string, Row[]> = {};
let seq = 0;
// A read that is already out of date: the next maybeSingle on `table` returns
// the row with `patch` over it, as if it changed between the check and the
// write. This is how a race between two tabs looks to the store.
let stale: { table: string; patch: Row } | null = null;

// Just enough of the PostgREST builder for the store: select / eq / in, then
// maybeSingle / single / await; insert and update return what they touched.
vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    const rows = () => (db[table] ??= []);
    const matched = () => rows().filter((r) => filters.every((f) => f(r)));
    const run = (): Row[] => {
      if (mode === "insert") {
        const r = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ...payload };
        rows().push(r);
        return [r];
      }
      if (mode === "update") {
        const hit = matched();
        for (const r of hit) Object.assign(r, payload);
        return hit;
      }
      return matched();
    };
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      insert: (p: Row) => ((mode = "insert"), (payload = p), b),
      update: (p: Row) => ((mode = "update"), (payload = p), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      maybeSingle: async () => {
        const r = run()[0] ?? null;
        if (r && stale?.table === table) {
          const patch = stale.patch;
          stale = null;
          return { data: { ...r, ...patch }, error: null };
        }
        return { data: r, error: null };
      },
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => void) =>
        resolve({ data: run(), error: null }),
    });
    return b;
  };
  return { supabaseAdmin: { from } };
});

const store = await import("@/utils/observability/swarmTraceStore.server");

beforeEach(() => {
  stale = null;
  db = {};
  seq = 0;
});
afterEach(() => {
  delete process.env.PERSIST_PROMPT_BODIES;
});

const step = (over: Row = {}) => ({
  stepId: "",
  status: "success" as const,
  output: "out",
  tokensIn: 10,
  tokensOut: 20,
  costUsd: 0.5,
  latencyMs: 100,
  ...over,
});

describe("a run is written only through the server, as its owner", () => {
  it("starts as the caller's own running run", async () => {
    const { runId } = await store.startRun(ME, { swarmName: "s", inputPrompt: "hi" });
    expect(db.swarm_runs[0]).toMatchObject({ id: runId, user_id: ME, status: "running" });
  });

  it("refuses a step, an edge or a finish on someone else's run", async () => {
    const { runId } = await store.startRun(THEM, {});
    await expect(store.startStep(ME, { runId, nodeId: "a" })).rejects.toThrow(/Run not found/);
    await expect(
      store.recordEdge(ME, { runId, sourceNodeId: "a", targetNodeId: "b" }),
    ).rejects.toThrow(/Run not found/);
    await expect(store.finishRun(ME, { runId, status: "success" })).rejects.toThrow(
      /Run not found/,
    );
    await expect(store.cancelRun(ME, { runId })).rejects.toThrow(/Run not found/);
    const { stepId } = await store.startStep(THEM, { runId, nodeId: "a" });
    await expect(store.finishStep(ME, step({ stepId }))).rejects.toThrow(/Step not found/);
  });
});

describe("a finished thing stays as it finished", () => {
  it("a step is finished once: no rewriting its cost afterwards", async () => {
    const { runId } = await store.startRun(ME, {});
    const { stepId } = await store.startStep(ME, { runId, nodeId: "a" });
    await store.finishStep(ME, step({ stepId, costUsd: 0.5 }));
    await expect(store.finishStep(ME, step({ stepId, costUsd: 0 }))).rejects.toThrow(
      /already finished/,
    );
    expect(db.swarm_run_steps[0].cost_usd).toBe(0.5);
  });

  it("waiting on an approval is not final: the step still finishes when its node does", async () => {
    const { runId } = await store.startRun(ME, {});
    const { stepId } = await store.startStep(ME, { runId, nodeId: "gate" });
    await store.finishStep(ME, step({ stepId, status: "awaiting_approval" }));
    await store.finishStep(ME, step({ stepId, status: "success" }));
    expect(db.swarm_run_steps[0].status).toBe("success");
  });

  it("nothing is added to a run that closed; its totals are its steps', summed here", async () => {
    const { runId } = await store.startRun(ME, {});
    const a = await store.startStep(ME, { runId, nodeId: "a" });
    const b = await store.startStep(ME, { runId, nodeId: "b" });
    await store.finishStep(ME, step({ stepId: a.stepId, costUsd: 0.25, tokensIn: 3 }));
    await store.finishStep(ME, step({ stepId: b.stepId, status: "error", costUsd: 0.5 }));
    await store.finishRun(ME, { runId, status: "success" });
    expect(db.swarm_runs[0]).toMatchObject({
      status: "success",
      total_cost_usd: 0.75,
      step_count: 2,
      error_count: 1,
    });
    await expect(store.startStep(ME, { runId, nodeId: "c" })).rejects.toThrow(/has finished/);
    await expect(
      store.recordEdge(ME, { runId, sourceNodeId: "a", targetNodeId: "b" }),
    ).rejects.toThrow(/has finished/);
    // A second close does not change how it ended.
    await store.finishRun(ME, { runId, status: "error", errorMessage: "rewritten" });
    expect(db.swarm_runs[0]).toMatchObject({ status: "success", error_message: null });
  });

  it("a cancelled run keeps 'cancelled', its in-flight steps still end, and it gets their numbers", async () => {
    const { runId } = await store.startRun(ME, {});
    const { stepId } = await store.startStep(ME, { runId, nodeId: "a" });
    expect(await store.cancelRun(ME, { runId })).toEqual({ cancelled: true });
    await store.finishStep(ME, step({ stepId, status: "error", costUsd: 0.1 }));
    await store.finishRun(ME, { runId, status: "success" });
    expect(db.swarm_runs[0]).toMatchObject({ status: "cancelled", total_cost_usd: 0.1 });
  });

  it("a step that finished after it was read is still not rewritten (the write is guarded)", async () => {
    const { runId } = await store.startRun(ME, {});
    const { stepId } = await store.startStep(ME, { runId, nodeId: "a" });
    await store.finishStep(ME, step({ stepId, costUsd: 0.5 }));
    stale = { table: "swarm_run_steps", patch: { status: "running" } };
    await expect(store.finishStep(ME, step({ stepId, costUsd: 0 }))).rejects.toThrow(
      /already finished/,
    );
    expect(db.swarm_run_steps[0].cost_usd).toBe(0.5);
  });

  it("a run that closed after it was read is not closed again", async () => {
    const { runId } = await store.startRun(ME, {});
    await store.finishRun(ME, { runId, status: "success" });
    stale = { table: "swarm_runs", patch: { status: "running" } };
    await store.finishRun(ME, { runId, status: "error", errorMessage: "rewritten" });
    expect(db.swarm_runs[0]).toMatchObject({ status: "success", error_message: null });
  });

  it("a step still open when its run closed cannot finish afterwards", async () => {
    const { runId } = await store.startRun(ME, {});
    const { stepId } = await store.startStep(ME, { runId, nodeId: "a" });
    await store.finishRun(ME, { runId, status: "success" });
    await expect(store.finishStep(ME, step({ stepId, costUsd: 9 }))).rejects.toThrow(
      /run has finished/,
    );
    expect(db.swarm_run_steps[0].status).toBe("running");
  });

  it("a late Cancel cannot turn a finished run into a cancelled one", async () => {
    const { runId } = await store.startRun(ME, {});
    await store.finishRun(ME, { runId, status: "success" });
    expect(await store.cancelRun(ME, { runId })).toEqual({ cancelled: false });
    expect(db.swarm_runs[0].status).toBe("success");
  });
});

describe("PERSIST_PROMPT_BODIES now covers canvas runs (VA-2026-10-25-47)", () => {
  it("drops the prompt, input, output, thinking and edge preview when it is off", async () => {
    process.env.PERSIST_PROMPT_BODIES = "false";
    const { runId } = await store.startRun(ME, { inputPrompt: "secret prompt" });
    const { stepId } = await store.startStep(ME, { runId, nodeId: "a", input: { prompt: "x" } });
    await store.finishStep(ME, step({ stepId, output: "model said", thinking: "hmm" }));
    await store.recordEdge(ME, {
      runId,
      sourceNodeId: "a",
      targetNodeId: "b",
      payloadPreview: "p",
    });
    expect(db.swarm_runs[0].input_prompt).toBeNull();
    expect(db.swarm_run_steps[0]).toMatchObject({
      input: { redacted: true },
      output: null,
      thinking: null,
      cost_usd: 0.5,
    });
    expect(db.swarm_run_edges[0].payload_preview).toBeNull();
  });
});

// ── Where it is written ──────────────────────────────────────────────────────
const rd = (p: string) => readFileSync(p, "utf8");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

describe("no browser code writes the run tables", () => {
  it("the canvas tracer calls the server functions and holds no client", () => {
    const t = rd("src/utils/observability/tracer.ts");
    expect(t).not.toMatch(/@\/integrations\/supabase\/client"/);
    expect(t).not.toMatch(/\.from\("swarm_run/);
    for (const fn of [
      "startSwarmRun",
      "startSwarmStep",
      "finishSwarmStep",
      "recordSwarmEdge",
      "finishSwarmRun",
    ]) {
      expect(t).toContain(`${fn}({`);
    }
  });

  it("every write to swarm_runs, its steps, edges or checkpoints is the service role's", () => {
    // After the migration a write through the browser's client (or a user's
    // token) is refused, and one written that way would fail silently, so none
    // may exist. The receiver of `.from(...)` names the client.
    const writers: string[] = [];
    for (const f of sources("src")) {
      const s = rd(f);
      for (const m of s.matchAll(
        /(\w+)\s*\.from\("swarm_run(?:s|_steps|_edges|_checkpoints)"\)([\s\S]{0,400})/g,
      )) {
        const chain = m[2].split(/;\s*\n/)[0];
        if (!/\.(insert|update|upsert|delete)\(/.test(chain)) continue;
        writers.push(f);
        expect(m[1], `${f} writes a run table through ${m[1]}`).toBe("supabaseAdmin");
      }
    }
    expect(new Set(writers)).toContain("src/utils/observability/swarmTraceStore.server.ts");
  });

  it("Cancel goes through cancelSwarmRun, from this tab and from Recent runs", () => {
    const m = rd("src/lib/swarmRunManager.ts");
    expect(m.match(/cancelSwarmRun\(\{ data: \{ runId: /g)).toHaveLength(2);
  });
});

describe("migration 20261103000000", () => {
  const sql = rd("supabase/migrations/20261103000000_swarm_run_write_lockdown.sql");
  const tables = ["swarm_runs", "swarm_run_steps", "swarm_run_edges", "swarm_run_checkpoints"];

  it("drops each FOR ALL policy and leaves an owner SELECT, with client writes revoked", () => {
    for (const t of tables) {
      expect(sql).toMatch(new RegExp(`DROP POLICY IF EXISTS "[^"]+" ON public\\.${t};`));
      expect(sql).toMatch(
        new RegExp(`ON public\\.${t} FOR SELECT USING \\(auth\\.uid\\(\\) = user_id\\);`),
      );
      expect(sql).toContain(
        `REVOKE INSERT, UPDATE, DELETE ON public.${t} FROM anon, authenticated;`,
      );
    }
  });

  it("proves all four on apply", () => {
    const loop = sql.slice(sql.indexOf("FOREACH t IN ARRAY"), sql.indexOf("END LOOP"));
    for (const t of tables) expect(loop).toContain(`'${t}'`);
    expect(loop).toContain("cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')");
    expect(loop).toContain("privilege_type IN ('INSERT', 'UPDATE', 'DELETE')");
  });
});
