// Promote model and Deploy model, as workflow steps (R542).
//
// Driven through the real startNode and pollNode, the real promotion gate
// (promote.server) and the real "does it beat production" decision, over an
// in-memory stand-in for the database. Only the warm-endpoint calls are
// stand-ins: starting a serving container is not what is under test.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  seq: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Q {
    filters: ((r: Record<string, unknown>) => boolean)[] = [];
    op: "select" | "update" | "insert" = "select";
    patch: Record<string, unknown> = {};
    rows: Record<string, unknown>[] = [];
    sortKey: string | null = null;
    sortAsc = true;
    max: number | null = null;
    constructor(public table: string) {}
    select() {
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    contains(c: string, v: Record<string, unknown>) {
      this.filters.push((r) =>
        Object.entries(v).every(([k, x]) => (r[c] as Record<string, unknown>)?.[k] === x),
      );
      return this;
    }
    order(c: string, o?: { ascending?: boolean }) {
      this.sortKey = c;
      this.sortAsc = o?.ascending !== false;
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    update(p: Record<string, unknown>) {
      this.op = "update";
      this.patch = p;
      return this;
    }
    insert(r: Record<string, unknown>) {
      this.op = "insert";
      this.rows = [r];
      return this;
    }
    exec(): Record<string, unknown>[] {
      const t = (db.tables[this.table] ??= []);
      if (this.op === "insert") {
        const made = this.rows.map((r) => ({
          id: r.id ?? `00000000-0000-4000-8000-${String(++db.seq).padStart(12, "0")}`,
          status: "pending",
          ...r,
        }));
        t.push(...made);
        return made;
      }
      let hit = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") for (const r of hit) Object.assign(r, this.patch);
      if (this.sortKey) {
        const k = this.sortKey;
        hit = [...hit].sort(
          (a, b) => ((a[k] as number) - (b[k] as number)) * (this.sortAsc ? 1 : -1),
        );
      }
      return this.max === null ? hit : hit.slice(0, this.max);
    }
    async maybeSingle() {
      return { data: this.exec()[0] ?? null, error: null };
    }
    async single() {
      const rows = this.exec();
      return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "none" } };
    }
    then(res: (v: unknown) => void) {
      res({ data: this.exec(), error: null });
    }
  }
  return { supabaseAdmin: { from: (t: string) => new Q(t) } };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/notify.server", () => ({ notifyUser: vi.fn(async () => undefined) }));
vi.mock("@/utils/ml/serve.server", () => ({
  ensureDeployment: vi.fn(async () => ({ ok: true, endpoint: "http://x", deployment: {} })),
  getDeployment: vi.fn(async () => null),
  setCandidate: vi.fn(async () => ({ ok: true })),
}));

import { ensureDeployment, getDeployment, setCandidate } from "@/utils/ml/serve.server";
import { pollNode, startNode } from "@/utils/workflows/adapters.server";
import { isMlPipeline, mlModelsIn } from "@/lib/mlPipelines";
import { validateNodeTarget, type WorkflowNode } from "@/lib/workflows";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const APPROVER = "00000000-0000-4000-8000-0000000000c3";
const MODEL = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222221";
const V2 = "22222222-2222-4222-8222-222222222222";

function seed(opts: { v2Score?: number; gated?: boolean } = {}) {
  db.tables = {
    ml_models: [
      {
        id: MODEL,
        user_id: OWNER,
        name: "Churn",
        task: "classification",
        production_version_id: V1,
        promotion_approvers: opts.gated ? [APPROVER] : null,
      },
    ],
    ml_model_versions: [
      {
        id: V1,
        model_id: MODEL,
        user_id: OWNER,
        version: 1,
        status: "ready",
        stage: "production",
        metrics: { f1_macro: 0.8 },
      },
      {
        id: V2,
        model_id: MODEL,
        user_id: OWNER,
        version: 2,
        status: "ready",
        stage: "candidate",
        metrics: { f1_macro: opts.v2Score ?? 0.85 },
      },
    ],
    approvals: [],
  };
}

const model = () => db.tables.ml_models[0];
const node = (kind: "ml_promote" | "ml_deploy", ml?: WorkflowNode["ml"], targetId = MODEL) =>
  ({ id: "n", kind, label: "Step", targetId, ml }) as WorkflowNode;
const start = (n: WorkflowNode, userId = OWNER, settle = vi.fn(async () => undefined)) =>
  startNode({ userId, node: n, params: {}, runId: "r", nodeRunId: "nr", settle });

beforeEach(() => {
  seed();
  vi.mocked(ensureDeployment).mockClear();
  vi.mocked(setCandidate).mockClear();
  vi.mocked(getDeployment).mockResolvedValue(null);
});

describe("Promote model", () => {
  it("puts a newer, better version into production on a model without approvers", async () => {
    const res = await start(node("ml_promote", { onlyIfBetter: true }));
    expect(res).toMatchObject({
      ok: true,
      settled: { done: true, ok: true },
      output: { outcome: "promoted", version: 2 },
    });
    expect(model().production_version_id).toBe(V2);
  });

  it("keeps production when the newest version is not better, and still succeeds", async () => {
    seed({ v2Score: 0.7 });
    const res = await start(node("ml_promote", { onlyIfBetter: true }));
    expect(res).toMatchObject({
      ok: true,
      settled: { done: true, ok: true },
      output: { outcome: "kept production", version: 2, production: 1 },
    });
    expect(model().production_version_id).toBe(V1);
  });

  it("promotes whatever is newest when told to, on an ungated model", async () => {
    seed({ v2Score: 0.7 });
    await start(node("ml_promote", { onlyIfBetter: false }));
    expect(model().production_version_id).toBe(V2);
  });

  it("has nothing to do when production is already the newest", async () => {
    model().production_version_id = V2;
    const res = await start(node("ml_promote"));
    expect(res).toMatchObject({ output: { outcome: "nothing newer", production: 2 } });
  });

  it("asks the approvers of a gated model, and waits for the model to change, not for the row", async () => {
    seed({ gated: true });
    const res = await start(node("ml_promote"));
    expect(res).toMatchObject({ ok: true, output: { outcome: "asked the approvers", version: 2 } });
    if (!res.ok || !res.targetRunId) throw new Error("expected a poll id");
    expect(res.targetRunId).toMatch(
      /^mlpromote:[0-9a-f-]{36}:22222222-2222-4222-8222-222222222222$/,
    );
    expect(model().production_version_id).toBe(V1);
    const approval = db.tables.approvals[0];
    expect(approval).toMatchObject({
      action_type: "ml.promote",
      user_id: OWNER,
      approver_user_ids: [APPROVER],
      payload: { model_id: MODEL, version_id: V2, requested_by: OWNER },
    });

    const poll = () =>
      pollNode({ userId: OWNER, kind: "ml_promote", targetRunId: res.targetRunId! });
    expect(await poll()).toEqual({ done: false });
    // A row that SAYS approved promotes nothing: the poller never applies.
    approval.status = "approved";
    expect(await poll()).toEqual({ done: false });
    expect(model().production_version_id).toBe(V1);
    // The approver's own call applied it: now the step is done.
    model().production_version_id = V2;
    expect(await poll()).toEqual({ done: true, ok: true });
    approval.status = "rejected";
    expect(await poll()).toEqual({ done: true, ok: false, error: "The promotion was rejected" });
  });

  it("refuses a model that is not the caller's", async () => {
    expect(await start(node("ml_promote"), OTHER)).toEqual({
      ok: false,
      error: "That model no longer exists, or is not yours",
    });
    expect(model().production_version_id).toBe(V1);
  });
});

describe("Deploy model", () => {
  it("serves production, and settles when the endpoint can score", async () => {
    const settle = vi.fn(async () => undefined);
    const res = await start(node("ml_deploy", { mode: "production" }), OWNER, settle);
    expect(res).toEqual({ ok: true, targetRunId: "detached" });
    await vi.waitFor(() => expect(settle).toHaveBeenCalled());
    expect(vi.mocked(ensureDeployment).mock.calls[0][0]).toMatchObject({
      userId: OWNER,
      model: { id: MODEL },
      version: { id: V1, version: 1 },
    });
    expect(settle).toHaveBeenCalledWith(
      { done: true, ok: true },
      { mode: "production", version: 1 },
    );
  });

  it("says why when the endpoint did not start", async () => {
    vi.mocked(ensureDeployment).mockResolvedValueOnce({
      ok: false,
      error: "You already have 3 warm endpoints; undeploy one first",
    });
    const settle = vi.fn(async () => undefined);
    await start(node("ml_deploy"), OWNER, settle);
    await vi.waitFor(() => expect(settle).toHaveBeenCalled());
    expect(settle).toHaveBeenCalledWith(
      { done: true, ok: false, error: "You already have 3 warm endpoints; undeploy one first" },
      undefined,
    );
  });

  it("tries the newest version as a canary only beside a running endpoint", async () => {
    const canary = node("ml_deploy", { mode: "canary", percent: 10 });
    expect(await start(canary)).toMatchObject({
      ok: false,
      error: expect.stringContaining("endpoint is not running"),
    });
    vi.mocked(getDeployment).mockResolvedValue({ status: "ready" } as never);
    const settle = vi.fn(async () => undefined);
    await start(canary, OWNER, settle);
    await vi.waitFor(() => expect(settle).toHaveBeenCalled());
    expect(vi.mocked(setCandidate).mock.calls[0][0]).toMatchObject({
      mode: "canary",
      percent: 10,
      version: { id: V2 },
    });
    expect(settle).toHaveBeenCalledWith(
      { done: true, ok: true },
      { mode: "canary", version: 2, percent: 10 },
    );
  });

  it("holds a canary to 50% when it runs, not only when it is saved", async () => {
    vi.mocked(getDeployment).mockResolvedValue({ status: "ready" } as never);
    // A graph written straight to the table never met the save's check.
    expect(await start(node("ml_deploy", { mode: "canary", percent: 100 }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("A canary sends 1% to 50% of requests"),
    });
    expect(setCandidate).not.toHaveBeenCalled();
  });

  it("has nothing to try when production is the newest", async () => {
    model().production_version_id = V2;
    vi.mocked(getDeployment).mockResolvedValue({ status: "ready" } as never);
    expect(await start(node("ml_deploy", { mode: "shadow" }))).toMatchObject({
      ok: true,
      settled: { done: true, ok: true },
      output: { mode: "shadow", outcome: "nothing newer than production to try" },
    });
    expect(setCandidate).not.toHaveBeenCalled();
  });
});

describe("what a saved step must say", () => {
  it("names a model, and a canary's share within bounds", () => {
    expect(validateNodeTarget(node("ml_promote", {}, ""), "P")).toBe(
      'The promote step "P" has no model chosen',
    );
    expect(validateNodeTarget(node("ml_deploy", {}, ""), "D")).toBe(
      'The deploy step "D" has no model chosen',
    );
    expect(validateNodeTarget(node("ml_deploy", { mode: "production" }), "D")).toBeNull();
    for (const percent of [0, 51, 12.5]) {
      expect(validateNodeTarget(node("ml_deploy", { mode: "canary", percent }), "D")).toMatch(
        /A canary sends 1% to 50% of requests/,
      );
    }
    expect(validateNodeTarget(node("ml_deploy", { mode: "canary", percent: 50 }), "D")).toBeNull();
  });

  it("makes a workflow an ML pipeline and names its models", () => {
    const graph = {
      nodes: [
        node("ml_deploy"),
        { id: "x", kind: "notify", label: "Tell", text: "hi" } as WorkflowNode,
      ],
      edges: [],
    };
    expect(isMlPipeline(graph)).toBe(true);
    expect(mlModelsIn(graph)).toEqual([MODEL]);
  });

  it("is admitted by the newest kind CHECK", () => {
    const sql = readFileSync("supabase/migrations/20261205000000_ml_delivery_steps.sql", "utf8");
    expect(sql).toContain("'ml_promote'");
    expect(sql).toContain("'ml_deploy'");
  });
});

describe("a database without the migration", () => {
  it("says which migration a workflow's steps need, not the CHECK's name", async () => {
    const { nodeRunsInsertError } = await import("@/utils/workflows/run.server");
    const raw =
      'new row for relation "workflow_node_runs" violates check constraint "workflow_node_runs_kind_check"';
    expect(nodeRunsInsertError(raw, ["ml_schedule", "ml_promote"])).toBe(
      "This database does not know one of this workflow's kinds of step yet: Promote and Deploy model steps need migration 20261205000000. Apply the latest migrations (for example npx supabase db push --remote).",
    );
    expect(nodeRunsInsertError(raw, ["kubeflow_run", "ml_deploy"])).toContain(
      "Kubeflow steps need migration 20261203000000; Promote and Deploy model steps need migration 20261205000000",
    );
    expect(nodeRunsInsertError("connection reset", ["ml_deploy"])).toBe("connection reset");
  });
});

describe("found from the UI in R542", () => {
  it("keeps the deploy modes short enough for the inspector's field", () => {
    const src = readFileSync("src/components/workflows/MlDeliveryFields.tsx", "utf8");
    const block = src.slice(
      src.indexOf("const MODE_LABEL"),
      src.indexOf("};", src.indexOf("const MODE_LABEL")),
    );
    const labels = [...block.matchAll(/: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "Serve production",
      "Canary (answers a share)",
      "Shadow (answers nobody)",
    ]);
    for (const l of labels) expect(l.length, l).toBeLessThanOrEqual(26);
  });
});

describe("a run whose steps could not be recorded", () => {
  it("marks the workflow failed too, not only the run", () => {
    const src = readFileSync("src/utils/workflows/run.server.ts", "utf8");
    const branch = src.slice(
      src.indexOf("if (nodesErr) {"),
      src.indexOf("return { ok: false, error: said };"),
    );
    expect(branch).toContain('.update({ state: "failed", error: said, finished_at: now })');
    expect(branch).toContain('.update({ last_run_at: now, last_run_status: "failed" })');
  });
});
