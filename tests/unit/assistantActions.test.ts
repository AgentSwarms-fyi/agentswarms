// The assistant proposes, the owner approves, the change happens once (R553).
//
// The server module runs against an in-memory stand-in for both clients: the
// reader's own (what RLS lets them open) and the service-role one. What is
// held: a proposal changes nothing and lands only in the reader's own inbox;
// only the owner's own workflow or pipeline can be proposed; the approval's
// words are fixed words and the thing's name, never the model's; an approval
// is carried out once, as its owner, against the thing as it is now; and a
// failure gives the claim back.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    audit: [] as Array<Record<string, unknown>>,
    started: [] as Array<{ kind: string; id: unknown; trigger: string }>,
    startResult: { ok: true, runId: "run-1" } as
      { ok: true; runId: string } | { ok: false; error: string },
    from: null as unknown as (table: string, visible?: (r: Row) => boolean) => unknown,
  };
  state.from = (table: string, visible: (r: Row) => boolean = () => true) => {
    const filters: Array<(r: Row) => boolean> = [visible];
    let op: "select" | "update" | "insert" = "select";
    let values: Row | null = null;
    let single = false;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "range"]) b[m] = () => b;
    b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
    b.is = (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b);
    b.update = (v: Row) => ((op = "update"), (values = v), b);
    b.insert = (v: Row) => ((op = "insert"), (values = v), b);
    b.single = b.maybeSingle = () => ((single = true), b);
    b.then = (resolve: (v: unknown) => void) => {
      const list = (state.tables[table] ??= []);
      let data: Row[];
      if (op === "insert") {
        const row = {
          id: `${table}-${list.length + 1}`,
          status: "pending",
          resumed_at: null,
          ...values,
        };
        list.push(row);
        data = [row];
      } else {
        data = list.filter((r) => filters.every((f) => f(r)));
        if (op === "update") for (const r of data) Object.assign(r, values);
      }
      resolve(single ? { data: data[0] ?? null, error: null } : { data, error: null });
    };
    return b;
  };
  return state;
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => db.from(t) },
}));
vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => db.audit.push(e),
}));
vi.mock("@/utils/workflows/run.server", () => ({
  startWorkflowRun: async (row: Row, trigger: string) => {
    db.started.push({ kind: "workflow", id: row.id, trigger });
    return db.startResult;
  },
  nextWorkflowRunAt: () => "2026-11-28T09:00:00.000Z",
}));
vi.mock("@/utils/etl/service.server", () => ({
  startEtlRun: async (row: Row, trigger: string) => {
    db.started.push({ kind: "etl_pipeline", id: row.id, trigger });
    return db.startResult;
  },
}));
vi.mock("@/utils/etl/schedule.server", () => ({
  nextEtlRunAt: () => "2026-11-28T02:00:00.000Z",
}));

const { proposeAssistantAction, runProposeAction, applyApprovedAssistantAction } =
  await import("@/utils/assistant/actions.server");
const lib = await import("@/lib/assistantActions");
const { ASSISTANT_ACTION, actionFromPayload, actionLines, actionLink, actionTitle, checkAction } =
  lib;

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const WF = "11111111-1111-1111-1111-111111111111";
const WF_MANUAL = "22222222-2222-2222-2222-222222222222";
const WF_SHARED = "33333333-3333-3333-3333-333333333333";
const WF_HIDDEN = "44444444-4444-4444-4444-444444444444";
const PIPE = "55555555-5555-5555-5555-555555555555";

/** The reader's own client: their rows, plus the one shared with them. */
const readerSb = (userId: string) =>
  ({
    from: (t: string) =>
      db.from(t, (r) => r.user_id === userId || (userId === OWNER && r.id === WF_SHARED)),
  }) as never;
const ctx = (userId = OWNER) => ({ sb: readerSb(userId), userId });
const approvals = () => db.tables.approvals ?? [];
const wf = (id = WF) => db.tables.workflows.find((r) => r.id === id)!;
const pipe = () => db.tables.etl_pipelines[0];

beforeEach(() => {
  db.audit = [];
  db.started = [];
  db.startResult = { ok: true, runId: "run-1" };
  db.tables = {
    workflows: [
      {
        id: WF,
        name: "Nightly revenue",
        user_id: OWNER,
        schedule: "daily",
        is_active: true,
        next_run_at: "2026-11-28T01:00:00.000Z",
      },
      { id: WF_MANUAL, name: "By hand", user_id: OWNER, schedule: "manual", is_active: true },
      {
        id: WF_SHARED,
        name: "Team load",
        user_id: OTHER,
        schedule: "hourly",
        is_active: true,
      },
      { id: WF_HIDDEN, name: "Not yours", user_id: OTHER, schedule: "daily", is_active: true },
    ],
    etl_pipelines: [
      {
        id: PIPE,
        name: "orders load",
        user_id: OWNER,
        schedule: "cron",
        cron_expr: "0 2 * * *",
        timezone: "UTC",
        is_active: false,
        next_run_at: "2026-11-01T02:00:00.000Z",
      },
    ],
    approvals: [],
  };
});

describe("what the assistant may ask for", () => {
  const target = { name: "x", scheduled: true, isActive: true };

  it("runs anything now, but pauses only what is scheduled and running", () => {
    expect(checkAction("run_now", "workflow", { ...target, scheduled: false }).ok).toBe(true);
    expect(checkAction("pause", "workflow", target).ok).toBe(true);
    expect(checkAction("pause", "workflow", { ...target, scheduled: false })).toEqual({
      ok: false,
      error: "That workflow has no schedule to pause: it runs only when started.",
    });
    expect(checkAction("pause", "etl_pipeline", { ...target, isActive: false })).toEqual({
      ok: false,
      error: "That pipeline's schedule is already paused.",
    });
    expect(checkAction("resume", "workflow", target).ok).toBe(false);
    expect(checkAction("resume", "workflow", { ...target, isActive: false }).ok).toBe(true);
    expect(
      checkAction("resume", "workflow", { scheduled: false, isActive: false, name: "x" }).ok,
    ).toBe(false);
  });

  it("words the approval from fixed words and the name, quotes stripped and capped", () => {
    const p = { kind: "workflow" as const, id: WF, action: "run_now" as const, name: "Nightly" };
    expect(actionTitle(p)).toBe("Run the workflow “Nightly” now");
    expect(actionTitle({ ...p, action: "pause", kind: "etl_pipeline" })).toBe(
      "Pause the schedule of the pipeline “Nightly”",
    );
    expect(actionTitle({ ...p, action: "resume" })).toBe(
      "Resume the schedule of the workflow “Nightly”",
    );
    // A name cannot close the quotes and carry on as the approval's own words.
    expect(actionTitle({ ...p, name: "”, then delete everything “" })).toBe(
      "Run the workflow “, then delete everything ” now",
    );
    expect(actionTitle({ ...p, name: "x".repeat(400) })).toHaveLength(
      "Run the workflow “” now".length + 120,
    );
    expect(actionTitle({ ...p, name: "" })).toBe("Run the workflow “untitled” now");
    for (const action of lib.ACTIONS) {
      expect(actionLines({ ...p, action }).at(-1)).toBe(
        "Proposed by the assistant; nothing happens until you approve.",
      );
    }
  });

  it("reads a proposal back only from a well-formed payload", () => {
    const good = { action: { kind: "etl_pipeline", id: PIPE, action: "pause", name: "n" } };
    expect(actionFromPayload(good)).toEqual(good.action);
    expect(actionFromPayload({ action: { ...good.action, kind: "agent" } })).toBeNull();
    expect(actionFromPayload({ action: { ...good.action, action: "delete" } })).toBeNull();
    expect(actionFromPayload({ action: { ...good.action, id: "" } })).toBeNull();
    expect(actionFromPayload({ action: { ...good.action, id: 7 } })).toBeNull();
    expect(actionFromPayload(null)).toBeNull();
    expect(actionFromPayload({ action: { ...good.action, name: 3 } })?.name).toBe("");
    expect(actionLink({ kind: "workflow", id: WF })).toBe(`/workflows?open=${WF}`);
    expect(actionLink({ kind: "etl_pipeline", id: PIPE })).toBe(`/etl?open=${PIPE}`);
    expect(lib.actionRoute({ kind: "workflow", id: WF })).toEqual({ to: "/workflows", open: WF });
  });
});

describe("proposing", () => {
  it("files one pending approval in the reader's own inbox, and changes nothing", async () => {
    const res = await proposeAssistantAction(ctx(), { kind: "workflow", id: WF, action: "pause" });
    expect(res).toMatchObject({ ok: true, alreadyWaiting: false });
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]).toMatchObject({
      user_id: OWNER,
      agent_name: "Assistant",
      action_type: ASSISTANT_ACTION,
      action_title: "Pause the schedule of the workflow “Nightly revenue”",
      status: "pending",
      risk_level: "low",
      payload: {
        action: { kind: "workflow", id: WF, action: "pause", name: "Nightly revenue" },
        link: `/workflows?open=${WF}`,
      },
    });
    expect(String(approvals()[0].description)).toContain("nothing happens until you approve");
    expect(wf().is_active).toBe(true);
    expect(db.started).toEqual([]);
    expect(db.audit.map((a) => a.action)).toEqual(["assistant.action.proposed"]);
  });

  it("does not file the same change twice while it waits", async () => {
    await proposeAssistantAction(ctx(), { kind: "workflow", id: WF, action: "run_now" });
    const again = await proposeAssistantAction(ctx(), {
      kind: "workflow",
      id: WF,
      action: "run_now",
    });
    expect(again).toMatchObject({ ok: true, alreadyWaiting: true });
    expect(approvals()).toHaveLength(1);
    // A different change to the same thing is its own proposal.
    await proposeAssistantAction(ctx(), { kind: "workflow", id: WF, action: "pause" });
    expect(approvals()).toHaveLength(2);
  });

  it("refuses one shared with the reader: it is its owner's to change", async () => {
    const res = await proposeAssistantAction(ctx(), {
      kind: "workflow",
      id: WF_SHARED,
      action: "run_now",
    });
    expect(res).toEqual({
      ok: false,
      error: "That one is shared with the user, not theirs: only its owner can run or pause it.",
    });
    expect(approvals()).toEqual([]);
  });

  it("refuses what the reader cannot open, as if it were not there", async () => {
    const res = await proposeAssistantAction(ctx(), {
      kind: "workflow",
      id: WF_HIDDEN,
      action: "run_now",
    });
    expect(res).toEqual({ ok: false, error: "No such workflow or pipeline is open to this user." });
    expect(approvals()).toEqual([]);
  });

  it("refuses a change that does not fit the thing as it is", async () => {
    const manual = await proposeAssistantAction(ctx(), {
      kind: "workflow",
      id: WF_MANUAL,
      action: "pause",
    });
    expect(manual.ok).toBe(false);
    const paused = await proposeAssistantAction(ctx(), {
      kind: "etl_pipeline",
      id: PIPE,
      action: "pause",
    });
    expect(paused).toEqual({ ok: false, error: "That pipeline's schedule is already paused." });
    expect(approvals()).toEqual([]);
  });

  it("refuses anything outside the catalogue", async () => {
    for (const args of [
      { kind: "agent", id: WF, action: "run_now" },
      { kind: "workflow", id: WF, action: "delete" },
      { kind: "workflow", id: "  ", action: "run_now" },
      { kind: "workflow", action: "run_now" },
    ]) {
      expect((await proposeAssistantAction(ctx(), args)).ok).toBe(false);
    }
    expect(approvals()).toEqual([]);
  });

  it("works only on the reader's own token, and tells the model it is not done", async () => {
    const sb = readerSb(OWNER);
    const headless = await runProposeAction(
      { sb, userId: OWNER, authToken: "t", scopeUserId: OWNER } as never,
      { kind: "workflow", id: WF, action: "run_now" },
    );
    expect(headless).toBe("Proposing a change works only in the signed-in app.");
    const noToken = await runProposeAction({ sb, userId: OWNER } as never, {
      kind: "workflow",
      id: WF,
      action: "run_now",
    });
    expect(noToken).toBe("Proposing a change works only in the signed-in app.");
    expect(approvals()).toEqual([]);

    const ok = await runProposeAction({ sb, userId: OWNER, authToken: "t" } as never, {
      kind: "workflow",
      id: WF,
      action: "run_now",
    });
    expect(ok).toContain(
      "Waiting for the user's approval: Run the workflow “Nightly revenue” now.",
    );
    expect(ok).toContain("Do not say it is done.");
    const refused = await runProposeAction({ sb, userId: OWNER, authToken: "t" } as never, {
      kind: "workflow",
      id: WF_SHARED,
      action: "run_now",
    });
    expect(refused).toMatch(/^Not proposed: That one is shared/);
    expect(refused.startsWith(lib.NOT_PROPOSED)).toBe(true);
  });

  it("flags an answer that says it proposed something it never filed", async () => {
    // Found from the UI with the default model: the third request in one
    // conversation was answered "I have proposed to run…" with no call made.
    const { unfiledProposal } = await import("@/lib/assistantThread");
    const said =
      'I have proposed to run the workflow "R553 assistant test" now. Please approve it in your approvals inbox.';
    const answer = (tools?: { name: string; status: "running" | "ok" | "error" | "none" }[]) => ({
      role: "assistant" as const,
      content: said,
      tools,
    });
    expect(unfiledProposal(answer())).toBe(true);
    expect(unfiledProposal(answer([{ name: "find_my_work", status: "ok" }]))).toBe(true);
    // Filed in this answer: true to its word.
    expect(unfiledProposal(answer([{ name: "propose_action", status: "ok" }]))).toBe(false);
    // Refused, yet still claimed: flagged.
    expect(unfiledProposal(answer([{ name: "propose_action", status: "error" }]))).toBe(true);
    // Not settled yet, an error, a question, or no such claim: not flagged.
    expect(unfiledProposal(answer([{ name: "propose_action", status: "running" }]))).toBe(false);
    expect(unfiledProposal({ ...answer(), error: true })).toBe(false);
    expect(unfiledProposal({ role: "user", content: said })).toBe(false);
    for (const text of [
      "The workflow has no schedule to pause: it runs only when started.",
      "Proposals wait in your approvals inbox until you approve them.",
      "I can propose that for you: shall I?",
    ]) {
      expect(unfiledProposal({ role: "assistant", content: text })).toBe(false);
    }
    for (const text of ["I've filed it for your approval.", "A run has been proposed."]) {
      expect(unfiledProposal({ role: "assistant", content: text })).toBe(true);
    }
    const panel = readFileSync("src/components/assistant/AssistantPanel.tsx", "utf8");
    expect(panel).toContain(
      "{!(state.busy && i === state.messages.length - 1) && unfiledProposal(m) ? (",
    );
    expect(readFileSync("src/lib/assistantPrompt.ts", "utf8")).toContain(
      "call propose_action in this reply, every time: only that call files it.",
    );
  });

  it("says nothing was filed when the tool refused, not that it asked", async () => {
    // Found from the UI: "Asked for your approval" above "it has no schedule".
    const { toolLabel } = await import("@/lib/assistantThread");
    expect(toolLabel({ name: "propose_action", status: "running" })).toBe(
      "Asking for your approval…",
    );
    expect(toolLabel({ name: "propose_action", status: "ok" })).toBe("Asked for your approval");
    expect(toolLabel({ name: "propose_action", status: "error" })).toBe(
      "Nothing filed for approval",
    );
    const loop = readFileSync("src/utils/tools/loop.server.ts", "utf8");
    expect(loop).toContain(
      'if (tc.function.name === "propose_action" && result.startsWith(NOT_PROPOSED)) {\n              ok = false;',
    );
  });
});

describe("carrying out an approved proposal", () => {
  async function approved(kind: "workflow" | "etl_pipeline", id: string, action: string) {
    const res = await proposeAssistantAction(ctx(), { kind, id, action });
    if (!res.ok) throw new Error(res.error);
    const row = approvals().find((a) => a.id === res.approvalId)!;
    row.status = "approved";
    return res.approvalId;
  }

  it("runs it now, once, as its owner", async () => {
    const id = await approved("workflow", WF, "run_now");
    const res = await applyApprovedAssistantAction(id, OWNER);
    expect(res).toEqual({ ok: true, message: "A run started.", link: `/workflows?open=${WF}` });
    expect(db.started).toEqual([{ kind: "workflow", id: WF, trigger: "manual" }]);
    expect(approvals()[0].resumed_at).toBeTruthy();
    expect(db.audit.at(-1)).toMatchObject({
      action: "assistant.action.applied",
      userId: OWNER,
      resourceId: WF,
      decisionId: id,
      detail: { approval_id: id, action: "run_now", run_id: "run-1" },
    });

    const twice = await applyApprovedAssistantAction(id, OWNER);
    expect(twice).toEqual({ ok: false, error: "It has already been carried out" });
    expect(db.started).toHaveLength(1);
  });

  it("starts a pipeline through the pipeline's own path", async () => {
    const id = await approved("etl_pipeline", PIPE, "run_now");
    expect((await applyApprovedAssistantAction(id, OWNER)).ok).toBe(true);
    expect(db.started).toEqual([{ kind: "etl_pipeline", id: PIPE, trigger: "manual" }]);
  });

  it("pauses a schedule, and resumes one from its next time, not a missed one", async () => {
    const pauseId = await approved("workflow", WF, "pause");
    expect(await applyApprovedAssistantAction(pauseId, OWNER)).toMatchObject({
      ok: true,
      message: "Its schedule is paused.",
    });
    expect(wf()).toMatchObject({ is_active: false, next_run_at: "2026-11-28T01:00:00.000Z" });
    // A new version, so an editor opened before the approval cannot save over
    // it unnoticed (found from the UI: its Save switched the schedule back on).
    expect(typeof wf().updated_at).toBe("string");
    expect(Date.now() - Date.parse(String(wf().updated_at))).toBeLessThan(60_000);

    const resumeId = await approved("etl_pipeline", PIPE, "resume");
    expect(await applyApprovedAssistantAction(resumeId, OWNER)).toMatchObject({
      ok: true,
      message: "Its schedule is running again.",
      link: `/etl?open=${PIPE}`,
    });
    // Not 2026-11-01 (a run missed while paused), which would fire at once.
    expect(pipe()).toMatchObject({ is_active: true, next_run_at: "2026-11-28T02:00:00.000Z" });

    const wfResume = await approved("workflow", WF, "resume");
    expect((await applyApprovedAssistantAction(wfResume, OWNER)).ok).toBe(true);
    expect(wf()).toMatchObject({ is_active: true, next_run_at: "2026-11-28T09:00:00.000Z" });
    expect(db.started).toEqual([]);
  });

  it("does nothing for an approval that is not approved", async () => {
    const res = await proposeAssistantAction(ctx(), { kind: "workflow", id: WF, action: "pause" });
    if (!res.ok) throw new Error(res.error);
    expect(await applyApprovedAssistantAction(res.approvalId, OWNER)).toEqual({
      ok: false,
      error: "It was pending",
    });
    approvals()[0].status = "rejected";
    expect(await applyApprovedAssistantAction(res.approvalId, OWNER)).toEqual({
      ok: false,
      error: "It was rejected",
    });
    expect(wf().is_active).toBe(true);
    expect(approvals()[0].resumed_at).toBeNull();
  });

  it("does nothing for someone else's approval, or another kind of approval", async () => {
    const id = await approved("workflow", WF, "pause");
    expect(await applyApprovedAssistantAction(id, OTHER)).toEqual({
      ok: false,
      error: "Approval not found",
    });
    approvals()[0].action_type = "ml.train";
    expect(await applyApprovedAssistantAction(id, OWNER)).toEqual({
      ok: false,
      error: "That approval is not one of the assistant's proposals",
    });
    expect(wf().is_active).toBe(true);
  });

  it("checks the thing again as it is now, and gives the claim back if it no longer fits", async () => {
    const id = await approved("workflow", WF, "pause");
    // Paused by hand while the proposal waited.
    wf().is_active = false;
    expect(await applyApprovedAssistantAction(id, OWNER)).toEqual({
      ok: false,
      error: "That workflow's schedule is already paused.",
    });
    expect(approvals()[0].resumed_at).toBeNull();

    const run = await approved("workflow", WF, "run_now");
    // Handed to someone else while it waited.
    wf().user_id = OTHER;
    expect(await applyApprovedAssistantAction(run, OWNER)).toEqual({
      ok: false,
      error: "It no longer exists, or is no longer yours",
    });
    expect(approvals().find((a) => a.id === run)!.resumed_at).toBeNull();
    expect(db.started).toEqual([]);
  });

  it("gives the claim back when the run does not start, so a retry can", async () => {
    const id = await approved("etl_pipeline", PIPE, "run_now");
    db.startResult = { ok: false, error: "The pipeline has no code" };
    expect(await applyApprovedAssistantAction(id, OWNER)).toEqual({
      ok: false,
      error: "The pipeline has no code",
    });
    expect(approvals()[0].resumed_at).toBeNull();
    expect(db.audit.map((a) => a.action)).not.toContain("assistant.action.applied");

    db.startResult = { ok: true, runId: "run-2" };
    expect((await applyApprovedAssistantAction(id, OWNER)).ok).toBe(true);
    expect(db.started).toHaveLength(2);
  });
});

describe("where it is wired", () => {
  const registry = readFileSync("src/utils/tools/registry.server.ts", "utf8");
  const chat = readFileSync("src/routes/api/chat.ts", "utf8");
  const inbox = readFileSync("src/components/ApprovalInbox.tsx", "utf8");
  const prompt = readFileSync("src/lib/assistantPrompt.ts", "utf8");

  it("is offered only on the signed-in reader's own token, never on a headless run", () => {
    expect(registry).toMatch(/"propose_action",\n\] as const;/);
    expect(registry).toContain(
      'if (allow?.includes("propose_action") && ctx.authToken && !ctx.scopeUserId) {',
    );
    const headless = chat.slice(chat.indexOf("HEADLESS_AGENT_TOOL_ALLOW = new Set"));
    expect(headless.slice(0, headless.indexOf("]);"))).not.toContain("propose_action");
    expect(prompt).toMatch(/ASSISTANT_TOOLS = \[[^\]]*"propose_action"/);
  });

  it("is carried out from the inbox only on a yes", () => {
    const at = inbox.indexOf("if (item?.action_type === ASSISTANT_ACTION) {");
    expect(at).toBeGreaterThan(0);
    const branch = inbox.slice(at, inbox.indexOf("if (item?.action_type === ML_TRAIN_ACTION)", at));
    const reject = branch.indexOf('if (status === "rejected")');
    const apply = branch.indexOf("applyAssistantFn(");
    expect(reject).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(reject);
    expect(branch.slice(reject, apply)).toContain("return;");
  });

  it("opens the thing in the app, without reloading the page", () => {
    const at = inbox.indexOf("if (item?.action_type === ASSISTANT_ACTION) {");
    const branch = inbox.slice(at, inbox.indexOf("if (item?.action_type === ML_TRAIN_ACTION)", at));
    expect(branch).toContain("void navigate({ to: r.to, search: { open: r.open } as never });");
    expect(inbox).not.toContain("window.location.assign(res.link)");
  });

  it("shows the workflow as it is now when a link asks for the one already open", () => {
    // Found from the UI: Open on the toast landed on the page already showing
    // that workflow, which still read Active from before the approval.
    const page = readFileSync("src/routes/_authenticated/workflows.tsx", "utf8");
    const at = page.indexOf("if (id === selectedId) {");
    expect(at).toBeGreaterThan(0);
    const branch = page.slice(at, at + 500);
    expect(branch).toContain('await mayDiscard("Reading it again replaces them.")');
    expect(branch).toContain("setLoadNonce((n) => n + 1);");
  });

  it("is a suggestion to the inbox, not an agent waiting on a tool", () => {
    expect(inbox).toMatch(
      /actionType === ML_TRAIN_ACTION \|\|\n\s*actionType === ASSISTANT_ACTION;/,
    );
    expect(inbox).toMatch(/actionType !== ML_TRAIN_ACTION &&\n\s*actionType !== ASSISTANT_ACTION;/);
  });
});
