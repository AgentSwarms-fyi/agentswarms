// Models proposed in chat and trained on their owner's yes (R527).
//
// The server module runs against an in-memory stand-in for the service-role
// client. What is held: a proposal is checked against the table as the owner
// reads it before it is filed; the same model is asked about once; only the
// owner's approved proposal trains, once, through the wizard's own path, after
// the table is checked again; and the wiring reaches the agent, the chat and
// the inbox.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  audit: [] as Array<Record<string, unknown>>,
  columns: null as Array<{ name: string; type: string }> | null,
  schemas: ["analytics"] as string[],
  distinct: 4,
  created: [] as Array<{ userId: string; input: Row; trigger?: string }>,
  createResult: null as null | Row,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let values: Row | null = null;
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
    b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
    b.ilike = (c: string, v: string) => (
      filters.push((r) => String(r[c]).toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase()),
      b
    );
    b.update = (v: Row) => ((op = "update"), (values = v), b);
    b.insert = (v: Row) => ((op = "insert"), (values = v), b);
    b.single = b.maybeSingle = () => ((single = true), b);
    b.then = (resolve: (v: unknown) => void) => {
      const list = (db.tables[table] ??= []);
      let data: Row[];
      if (op === "insert") {
        const row = { id: `${table}-${list.length + 1}`, status: "pending", ...values };
        list.push(row);
        data = [row];
      } else {
        data = list.filter((r) => filters.every((f) => f(r)));
        if (op === "update") for (const r of data) Object.assign(r, values);
      }
      resolve(single ? { data: data[0] ?? null, error: null } : { data, error: null });
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => db.audit.push(e),
}));
vi.mock("@/utils/lakehouse/core.server", () => ({
  lakehouseEnabled: () => true,
  accessibleSchemas: async () => db.schemas.map((name) => ({ name })),
  runLakehouseStatement: async () => ({ columns: [], rows: [[db.distinct]] }),
}));
vi.mock("@/utils/lakehouse/tableColumns.server", () => ({
  lakehouseTableColumns: async () => db.columns,
}));
vi.mock("@/utils/ml/create.server", () => ({
  createModelAndTrain: async (userId: string, input: Row, opts: { trigger?: string }) => {
    db.created.push({ userId, input, trigger: opts?.trigger });
    return db.createResult ?? { ok: true, model_id: "model-1", job_id: "job-1" };
  },
}));

const { proposeTraining, applyApprovedTraining } =
  await import("@/utils/ml/proposeTraining.server");
const { ML_TRAIN_ACTION } = await import("@/lib/mlProposals");

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ASK = {
  task: "forecast",
  table: "analytics.revenue_facts",
  target_column: "net_usd",
  time_column: "placed_at",
  series_column: "region",
  period: "week",
  horizon: 6,
  name: "Revenue by region",
};
const approval = () => db.tables.approvals[0];

beforeEach(() => {
  db.audit = [];
  db.created = [];
  db.createResult = null;
  db.distinct = 4;
  db.schemas = ["analytics"];
  db.columns = [
    { name: "region", type: "VARCHAR" },
    { name: "placed_at", type: "DATE" },
    { name: "net_usd", type: "DECIMAL(18,2)" },
  ];
  db.tables = { approvals: [], ml_models: [] };
});

describe("filing a proposal", () => {
  it("files one approval for the owner, built from the checked names", async () => {
    const r = await proposeTraining(OWNER, ASK, { agentName: "Analyst" });
    expect(r.ok && r.alreadyWaiting).toBe(false);
    expect(db.tables.approvals).toHaveLength(1);
    expect(approval()).toMatchObject({
      user_id: OWNER,
      agent_name: "Analyst",
      action_type: ML_TRAIN_ACTION,
      action_title: 'Train "Revenue by region": forecast net_usd per week',
      risk_level: "low",
    });
    expect(approval().description).toContain("Along placed_at, 6 weeks ahead.");
    expect((approval().payload as Row).proposal).toMatchObject({ series_column: "region" });
    expect(db.audit.map((a) => a.action)).toEqual(["ml.train.proposed"]);
    expect(db.created).toEqual([]);
  });

  it("asks once: the same model still waiting is not filed again", async () => {
    await proposeTraining(OWNER, ASK, { agentName: "Analyst" });
    const again = await proposeTraining(
      OWNER,
      { ...ASK, name: "REVENUE BY REGION" },
      {
        agentName: "Analyst",
      },
    );
    expect(again.ok && again.alreadyWaiting).toBe(true);
    expect(db.tables.approvals).toHaveLength(1);
  });

  it("refuses a table the owner cannot read, a wrong column, an id as a series, a taken name", async () => {
    db.schemas = [];
    expect(await proposeTraining(OWNER, ASK, { agentName: "A" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read"),
    });
    db.schemas = ["analytics"];
    expect(
      await proposeTraining(OWNER, { ...ASK, target_column: "revenue" }, { agentName: "A" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('has no column "revenue"') });
    db.distinct = 5000;
    expect(await proposeTraining(OWNER, ASK, { agentName: "A" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("about 5000 different values"),
    });
    db.distinct = 4;
    db.tables.ml_models.push({ id: "m0", user_id: OWNER, name: "revenue by region" });
    expect(await proposeTraining(OWNER, ASK, { agentName: "A" })).toMatchObject({
      ok: false,
      error: expect.stringContaining('You already have a model called "Revenue by region"'),
    });
    expect(db.tables.approvals).toEqual([]);
  });
});

describe("training an approved proposal", () => {
  const filed = async () => {
    await proposeTraining(OWNER, ASK, { agentName: "Analyst" });
    return approval().id as string;
  };

  it("does nothing until it is approved, and nothing for anyone but its owner", async () => {
    const id = await filed();
    expect(await applyApprovedTraining(id, OWNER)).toMatchObject({ error: "It was pending" });
    approval().status = "approved";
    expect(await applyApprovedTraining(id, OTHER)).toMatchObject({ error: "Approval not found" });
    expect(db.created).toEqual([]);
  });

  it("trains once, as the owner, through the wizard's path", async () => {
    const id = await filed();
    approval().status = "approved";
    const r = await applyApprovedTraining(id, OWNER);
    expect(r).toMatchObject({ ok: true, modelId: "model-1" });
    expect(db.created).toHaveLength(1);
    expect(db.created[0]).toMatchObject({
      userId: OWNER,
      trigger: "approval",
      input: {
        name: "Revenue by region",
        task: "forecast",
        source: { kind: "lakehouse", schema: "analytics", table: "revenue_facts" },
        target_column: "net_usd",
        series_column: "region",
        horizon: 6,
      },
    });
    expect(db.audit.map((a) => a.action)).toContain("ml.train.approved");
    expect(await applyApprovedTraining(id, OWNER)).toMatchObject({
      error: "It has already been carried out",
    });
    expect(db.created).toHaveLength(1);
  });

  it("checks the table again: a column gone since the proposal stops it, and the claim is given back", async () => {
    const id = await filed();
    approval().status = "approved";
    db.columns = db.columns!.filter((c) => c.name !== "placed_at");
    const r = await applyApprovedTraining(id, OWNER);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('no column "placed_at"') });
    expect(approval().resumed_at).toBeNull();
    expect(db.created).toEqual([]);
  });

  it("keeps a model that was made but did not start, and says where it is", async () => {
    const id = await filed();
    approval().status = "approved";
    db.createResult = { ok: false, error: "Concurrent training limit reached", model_id: "m9" };
    const r = await applyApprovedTraining(id, OWNER);
    expect(r).toMatchObject({ ok: false, modelId: "m9" });
    expect(approval().resumed_at).not.toBeNull();
  });
});

describe("the wiring", () => {
  const rd = (p: string) => readFileSync(p, "utf8");

  it("the agent gets the tool only from its own toggle, on every surface", () => {
    const reg = rd("src/utils/tools/registry.server.ts");
    expect(reg).toContain('  "ml_train",\n');
    expect(reg).toContain('if (allows("ml_train")) {');
    expect(reg).toContain('name: "ml_propose_model",');
    expect(reg).toContain("const owner = c.scopeUserId ?? c.userId;");
    expect(reg).toContain("proposeTraining(owner, a, { agentName })");
    expect(reg).toContain('.eq("user_id", owner)');
    expect(rd("src/utils/tools/agentToggles.ts")).toContain(
      'if (t.ml_train) out.push("ml_train");',
    );
    const chat = rd("src/routes/api/chat.ts");
    const at = chat.indexOf("const HEADLESS_AGENT_TOOL_ALLOW = new Set<ToolableId>([");
    expect(chat.slice(at, chat.indexOf("]);", at))).toContain('"ml_train"');
    expect(rd("src/components/agents/AgentForm.tsx")).toContain('id: "ml_train",');
  });

  it("the inbox trains on a yes and makes nothing on a no", () => {
    const inbox = rd("src/components/ApprovalInbox.tsx");
    expect(inbox).toContain("if (item?.action_type === ML_TRAIN_ACTION) {");
    expect(inbox).toContain("await applyTrainingFn({ data: { approvalId: id } })");
    expect(inbox).toContain('toast(`Not trained: ${name}`, { description: "Nothing was made." });');
    expect(inbox).toContain('if (actionType === ML_TRAIN_ACTION) return "proposed";');
  });

  it("the chat card reads what was filed, and the agent is told nothing else waits", async () => {
    const { mlToolData } = await import("@/lib/mlToolResult");
    const card = (extra: Record<string, unknown>) =>
      mlToolData(
        "ml_propose_model",
        JSON.stringify({
          proposed: true,
          proposal: "Train X",
          what_approving_does: ["a"],
          ...extra,
        }),
      );
    expect(card({ already_waiting: true })).toMatchObject({
      kind: "proposal",
      already_waiting: true,
    });
    expect(card({ already_waiting: false })).toMatchObject({ already_waiting: false });
    // A refusal shows as what was wrong, so the person sees why nothing was filed.
    expect(mlToolData("ml_propose_model", JSON.stringify({ proposed: false, error: "x" }))).toEqual(
      { kind: "error", error: "x" },
    );
    // FOUND IN THE UI TEST: the agent called a rejected proposal "still waiting".
    expect(rd("src/utils/tools/registry.server.ts")).toContain(
      "No other proposal for this model is waiting: any earlier one in this conversation has been decided.",
    );
  });

  it("the chat shows the proposal and a way to the inbox", () => {
    expect(rd("src/lib/mlToolResult.ts")).toContain('if (toolName === "ml_propose_model") {');
    expect(rd("src/routes/_authenticated/playground.tsx")).toContain(
      "onClick={() => openApprovalsInbox()}",
    );
  });

  it("the wizard and an approved proposal share one create path", () => {
    expect(rd("src/utils/ml.functions.ts")).toContain(
      "return createModelAndTrain(userId, input as MlCreateInput);",
    );
    expect(rd("src/utils/ml/proposeTraining.server.ts")).toContain(
      "await createModelAndTrain(\n    callerId,",
    );
  });
});
