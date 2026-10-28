// A workflow's trigger door lets six triggers a minute through, then refuses.
//
// VA-2026-10-25-18. POST /api/workflows/run asked `!(await rateLimitedGlobal(…))`
// — but rateLimitedGlobal answers "is the caller OVER the limit?". So a trigger
// within the limit got 429 (while taking a slot), and once six had filled the
// minute's bucket every trigger after them was let through, unlimited. A
// workflow's API trigger had never worked as documented. The ETL trigger door,
// which this one copies, was right all along.
//
// Driven end to end through the real limiter: the database RPC behind it is the
// only stub, and with that RPC down it falls back to the in-process window.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "wfk_test_trigger_token";
const db = vi.hoisted(() => ({
  /** What rate_limit_take answers: true = a slot was taken, false = over. */
  rpc: { data: true as boolean | null, error: null as { message: string } | null },
  rpcCalls: [] as Record<string, unknown>[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const row = {
    id: "wf-1",
    user_id: "u1",
    name: "Nightly load",
    is_active: true,
    trigger_token_hash: createHash("sha256").update("wfk_test_trigger_token").digest("hex"),
  };
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row }) };
  return {
    supabaseAdmin: {
      from: () => chain,
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        db.rpcCalls.push(args);
        return db.rpc;
      },
    },
  };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/workflows/run.server", () => ({
  startWorkflowRun: vi.fn(async () => ({ ok: true, runId: "run-1" })),
}));

import { startWorkflowRun } from "@/utils/workflows/run.server";

type Post = (a: { request: Request }) => Promise<Response>;
let POST: Post;
beforeAll(async () => {
  const { Route } = (await import("@/routes/api/workflows.run")) as unknown as {
    Route: { options: { server: { handlers: { POST: Post } } } };
  };
  POST = Route.options.server.handlers.POST;
}, 120_000);

let workflowId = 0;
const trigger = (id: string) =>
  POST({
    request: new Request("http://app.test/api/workflows/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: id }),
    }),
  });

beforeEach(() => {
  db.rpc = { data: true, error: null };
  db.rpcCalls = [];
  vi.mocked(startWorkflowRun).mockClear();
  vi.stubEnv("WORKFLOW_TRIGGER_PER_MIN", "");
  workflowId += 1;
});

describe("the workflow trigger rate limit", () => {
  it("lets a trigger within the limit through", async () => {
    const res = await trigger(`wf-${workflowId}`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, run_id: "run-1" });
    expect(startWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("refuses a trigger over the limit, and runs nothing", async () => {
    db.rpc = { data: false, error: null };
    const res = await trigger(`wf-${workflowId}`);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many triggers for this workflow" });
    expect(startWorkflowRun).not.toHaveBeenCalled();
  });

  it("asks per workflow, with the configured ceiling", async () => {
    vi.stubEnv("WORKFLOW_TRIGGER_PER_MIN", "3");
    await trigger(`wf-${workflowId}`);
    expect(db.rpcCalls).toEqual([
      { _bucket: `wfrun:wf-${workflowId}`, _max: 3, _window_seconds: 60 },
    ]);
  });

  it("with the shared limiter down: six a minute through, the seventh refused", async () => {
    db.rpc = { data: null, error: { message: "connection reset" } };
    const id = `wf-${workflowId}`;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await trigger(id)).status);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 429]);
    expect(startWorkflowRun).toHaveBeenCalledTimes(6);
  });
});

/** Every .ts file under dir. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("no caller reads the limiter backwards", () => {
  it("every rateLimitedGlobal / rateLimited answer is taken as 'over the limit'", () => {
    const negated: string[] = [];
    let calls = 0;
    for (const f of sources("src")) {
      const text = readFileSync(f, "utf8");
      calls += (text.match(/\brateLimited(?:Global)?\(/g) ?? []).length;
      if (/!\s*\(?\s*(?:await\s+)?rateLimited(?:Global)?\(/.test(text)) negated.push(f);
    }
    expect(calls).toBeGreaterThan(15);
    expect(negated).toEqual([]);
  });
});
