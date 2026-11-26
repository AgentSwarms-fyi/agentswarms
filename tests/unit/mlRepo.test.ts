// ML pipelines in the team's own repository (R541).
//
// The file format runs as pure functions. Save, update, import and the CI
// deploy run for real through mlRepo.server, the one definition path and the
// /api/workflows/run door, over an in-memory stand-in for the database and a
// stand-in repository (the GitHub/GitLab calls are the only thing faked).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  changesLine,
  ciSnippets,
  definitionChanges,
  literalCredential,
  repoKey,
  modelConfigDoc,
  noChanges,
  parseWorkflowFile,
  pipelineFilePath,
  repoFileUrl,
  toWorkflowFile,
  validRef,
  validRepoName,
  workflowFileText,
  type WorkflowDefinition,
} from "@/lib/workflowFile";

const rd = (p: string) => readFileSync(p, "utf8");

// ── The stand-ins ────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  seq: 0,
  /** Tables whose migration is "not applied": every read answers PostgREST's error. */
  missing: new Set<string>(),
}));
const repo = vi.hoisted(() => ({
  head: "aaaaaaa1111111111111111111111111111111aa",
  files: new Map<string, string>(),
  onBranch: new Set<string>(),
  commits: [] as { files: { path: string; content: string }[]; message: string }[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/integrations/supabase/client.server", () => {
  class Q {
    filters: ((r: Record<string, unknown>) => boolean)[] = [];
    op: "select" | "update" | "insert" | "upsert" = "select";
    patch: Record<string, unknown> = {};
    rows: Record<string, unknown>[] = [];
    conflict = "id";
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
    order() {
      return this;
    }
    limit() {
      return this;
    }
    update(p: Record<string, unknown>) {
      this.op = "update";
      this.patch = p;
      return this;
    }
    insert(r: Record<string, unknown> | Record<string, unknown>[]) {
      this.op = "insert";
      this.rows = Array.isArray(r) ? r : [r];
      return this;
    }
    upsert(r: Record<string, unknown>, o?: { onConflict?: string }) {
      this.op = "upsert";
      this.rows = [r];
      this.conflict = o?.onConflict ?? "id";
      return this;
    }
    exec(): Record<string, unknown>[] {
      const t = (db.tables[this.table] ??= []);
      if (this.op === "insert") {
        const made = this.rows.map((r) => ({
          id: r.id ?? `00000000-0000-4000-8000-${String(++db.seq).padStart(12, "0")}`,
          updated_at: "2026-11-26T00:00:00.000Z",
          ...r,
        }));
        t.push(...made);
        return made;
      }
      if (this.op === "upsert") {
        for (const r of this.rows) {
          const i = t.findIndex((x) => x[this.conflict] === r[this.conflict]);
          if (i >= 0) t[i] = { ...t[i], ...r };
          else t.push({ ...r });
        }
        return this.rows;
      }
      const hit = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") for (const r of hit) Object.assign(r, this.patch);
      return hit;
    }
    async maybeSingle() {
      return { data: this.exec()[0] ?? null, error: null };
    }
    async single() {
      const rows = this.exec();
      return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "none" } };
    }
    then(res: (v: unknown) => void, rej: (e: unknown) => void) {
      if (db.missing.has(this.table)) {
        res({
          data: null,
          error: {
            message: `Could not find the table 'public.${this.table}' in the schema cache`,
          },
        });
        return;
      }
      try {
        const data = this.exec();
        res({ data, error: null, count: data.length });
      } catch (e) {
        rej(e);
      }
    }
  }
  return {
    supabaseAdmin: {
      from: (t: string) => new Q(t),
      rpc: async () => ({ data: true, error: null }),
    },
  };
});
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/notify.server", () => ({ notifyUser: vi.fn(async () => undefined) }));
vi.mock("@/utils/workflows/run.server", () => ({
  nextWorkflowRunAt: () => "2026-12-01T00:00:00.000Z",
  startWorkflowRun: vi.fn(async () => ({ ok: true, runId: "run-1" })),
}));
vi.mock("@/utils/git/token.server", () => ({
  storedGitToken: async () => "tok_fixture_not_real",
  gitTokenForUse: async () => "tok_fixture_not_real",
}));
vi.mock("@/utils/git/exporter.server", () => ({
  branchHead: vi.fn(async () => repo.head),
  listFolder: vi.fn(async (_c: unknown, _t: string, folder: string) =>
    [...repo.files.keys()]
      .filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/"))
      .map((p) => ({ path: p, name: p.slice(folder.length + 1) })),
  ),
  readFileAtRef: vi.fn(async (_c: unknown, _t: string, path: string) => {
    const text = repo.files.get(path);
    if (text === undefined) throw new Error("GitHub 404: Not Found");
    return text;
  }),
  commitOnBranch: vi.fn(async (_c: unknown, _t: string, sha: string) => repo.onBranch.has(sha)),
  commitFiles: vi.fn(
    async (
      _c: unknown,
      _t: string,
      files: { path: string; content: string }[],
      message: string,
    ) => {
      for (const f of files) repo.files.set(f.path, f.content);
      repo.commits.push({ files, message });
      repo.head = `${String(repo.commits.length).padStart(7, "c")}${"0".repeat(33)}`;
      repo.onBranch.add(repo.head);
      return {
        sha: repo.head,
        commitUrl: `https://github.com/acme/ml/commit/${repo.head}`,
        files: files.length,
      };
    },
  ),
}));

import { auditEvent } from "@/utils/audit.server";
import { commitFiles } from "@/utils/git/exporter.server";
import { startWorkflowRun } from "@/utils/workflows/run.server";
import {
  importWorkflowFromRepo,
  pullWorkflowFromRepo,
  saveWorkflowToRepo,
  unlinkedPipelineFiles,
} from "@/utils/mlRepo.server";

const USER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const WF = "11111111-1111-4111-8111-111111111111";
const TOKEN = "wfk_fixture_trigger_token";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

function seed() {
  db.tables = {
    workflows: [
      {
        id: WF,
        user_id: USER,
        name: "Churn pipeline",
        description: null,
        graph: {
          nodes: [
            { id: "n1", kind: "ml_schedule", label: "Retrain", targetId: "s-1", x: 10.4, y: 20.6 },
          ],
          edges: [],
          params: [],
        },
        params: [],
        schedule: "manual",
        cron_expr: null,
        timezone: null,
        overlap: "skip",
        notify_on: "failure",
        timeout_minutes: 240,
        is_active: true,
        next_run_at: null,
        updated_at: "2026-11-01T00:00:00.000Z",
        trigger_token_hash: hash(TOKEN),
      },
    ],
    ml_schedules: [
      {
        id: "s-1",
        user_id: USER,
        name: "Weekly retrain",
        model_id: "m-1",
        kind: "retrain",
        schedule: "weekly",
        cron_expr: null,
        timezone: null,
        promote_if_better: true,
        is_active: true,
        config: { tuning: "quick" },
      },
      { id: "s-x", user_id: OTHER, name: "Weekly retrain", model_id: "m-x", kind: "retrain" },
    ],
    ml_models: [
      {
        id: "m-1",
        user_id: USER,
        name: "Churn",
        description: null,
        task: "classification",
        source: { kind: "lakehouse", schema: "main", table: "customers" },
        prep: {},
        target_column: "churned",
        feature_columns: ["age", "plan"],
        promotion_approvers: [
          "00000000-0000-4000-8000-0000000000c3",
          "00000000-0000-4000-8000-0000000000d4",
        ],
        production_version_id: "v-1",
        feature_stats: { age: { mean: 41 } },
      },
      { id: "m-x", user_id: OTHER, name: "Churn" },
    ],
    ml_model_versions: [
      {
        id: "v-1",
        user_id: USER,
        model_id: "m-1",
        version: 3,
        algorithm: "lightgbm",
        metrics: { auc: 0.81 },
        trained_at: "2026-11-20T00:00:00.000Z",
        training_rows: 1000,
        leaderboard: [{ algorithm: "xgboost" }],
      },
    ],
    integrations: [],
    workflow_repo_links: [],
    approvals: [],
    git_export_config: [
      {
        user_id: USER,
        provider: "github",
        repo: "acme/ml",
        branch: "main",
        base_path: "agentswarms",
        host: null,
        token_enc: { ciphertext: "x", iv: "y" },
      },
    ],
  };
  db.missing = new Set();
  repo.head = "aaaaaaa1111111111111111111111111111111aa";
  repo.files = new Map();
  repo.onBranch = new Set([repo.head]);
  repo.commits = [];
}

const workflow = () => db.tables.workflows.find((w) => w.id === WF)! as Row;
const link = () =>
  db.tables.workflow_repo_links.find((l) => l.workflow_id === WF) as Row | undefined;
const PATH = "agentswarms/ml/pipelines/churn-pipeline.json";

/** Edit the pipeline's file in the repository, as a person would in a pull request. */
function editInRepo(fn: (f: Record<string, unknown>) => void, sha: string) {
  const f = JSON.parse(repo.files.get(PATH)!) as Record<string, unknown>;
  fn(f);
  repo.files.set(PATH, JSON.stringify(f, null, 2));
  repo.head = sha;
  repo.onBranch.add(sha);
}

beforeEach(() => {
  seed();
  vi.mocked(auditEvent).mockClear();
  vi.mocked(commitFiles).mockClear();
  vi.mocked(startWorkflowRun).mockClear();
});

// ── The file format ─────────────────────────────────────────────────────

const DEF: WorkflowDefinition = {
  name: "Churn pipeline",
  description: null,
  schedule: "daily",
  cronExpr: null,
  timezone: "Europe/Paris",
  overlap: "skip",
  notifyOn: "failure",
  timeoutMinutes: 240,
  graph: {
    nodes: [
      { id: "n1", kind: "ml_schedule", label: "Retrain", targetId: "s-1", x: 10.4, y: 20.6 },
      { id: "n2", kind: "approval", label: "Check the scores" },
    ],
    edges: [{ from: "n1", to: "n2" }],
    params: [{ name: "day", default: "today" }],
  },
};

describe("a workflow file", () => {
  it("reads back to the same definition, byte for byte the second time", () => {
    const file = toWorkflowFile(DEF, { n1: { name: "Weekly retrain", model: "Churn" } });
    const text = workflowFileText(file);
    const parsed = parseWorkflowFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(workflowFileText(parsed.file)).toBe(text);
    expect(file.steps[0]).toMatchObject({
      target: { name: "Weekly retrain", model: "Churn" },
      x: 10,
      y: 21,
    });
    // Keys in a fixed order: id, kind, label, target, targetId…
    expect(Object.keys(file.steps[0]).slice(0, 5)).toEqual([
      "id",
      "kind",
      "label",
      "target",
      "targetId",
    ]);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("leaves out whether the pipeline is switched on", () => {
    const text = workflowFileText(toWorkflowFile(DEF));
    expect(text).not.toMatch(/isActive|is_active/);
    expect(text).toContain('"format": "agentswarms.workflow"');
  });

  it("says what is wrong, where", () => {
    expect(parseWorkflowFile("{nope")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(parseWorkflowFile('{"format":"other"}')).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a workflow file"),
    });
    expect(parseWorkflowFile('{"format":"agentswarms.workflow","version":9}')).toMatchObject({
      ok: false,
      error: expect.stringContaining("version 9"),
    });
    const bad = JSON.parse(workflowFileText(toWorkflowFile(DEF)));
    bad.steps[1].kind = "rm_rf";
    expect(parseWorkflowFile(JSON.stringify(bad))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^steps\.1\.kind/),
    });
    expect(parseWorkflowFile(" ".repeat(600 * 1024))).toMatchObject({
      ok: false,
      error: expect.stringContaining("over 512 KB"),
    });
  });

  it("counts what an update would change, and a moved step is not a change", () => {
    const next = structuredClone(DEF);
    next.graph.nodes[0].x = 500;
    expect(noChanges(definitionChanges(DEF, next))).toBe(true);
    next.graph.nodes.push({ id: "n3", kind: "notify", label: "Tell the team", text: "done" });
    next.graph.edges.push({ from: "n2", to: "n3" });
    next.schedule = "weekly";
    next.graph.nodes[1].label = "Check scores";
    const c = definitionChanges(DEF, next);
    expect(c).toMatchObject({
      added: ["Tell the team"],
      removed: [],
      changed: ["Check scores"],
      settings: ["schedule"],
      arrows: 1,
    });
    expect(changesLine(c)).toBe("1 step added, 1 step changed, 1 arrow changed, schedule");
  });

  it("puts a new pipeline at its name, or beside a file that is already there", () => {
    expect(pipelineFilePath("agentswarms/", "Churn: weekly!", WF, new Set())).toBe(
      "agentswarms/ml/pipelines/churn-weekly.json",
    );
    expect(
      pipelineFilePath(
        "agentswarms",
        "Churn weekly",
        WF,
        new Set(["agentswarms/ml/pipelines/churn-weekly.json"]),
      ),
    ).toBe("agentswarms/ml/pipelines/churn-weekly-11111111.json");
  });

  it("takes a sha or a branch name as a ref, and nothing that walks out", () => {
    for (const ok of ["main", "release/2026-11", "aaaaaaa1111"])
      expect(validRef(ok), ok).toBe(true);
    for (const bad of ["../x", "a..b", "/main", "main/", "-x", "a b", "a;rm", ""])
      expect(validRef(bad), bad).toBe(false);
    expect(validRepoName("acme/ml")).toBe(true);
    expect(validRepoName("group/sub/project")).toBe(true);
    for (const bad of ["acme", "../x/y", "acme/../users", "acme/ml?x=1"])
      expect(validRepoName(bad), bad).toBe(false);
  });

  it("refuses a key typed into an HTTP step, and allows one picked from secrets", () => {
    const http = (headers: Record<string, string>, url = "https://x.test", body?: string) => ({
      nodes: [
        {
          id: "h",
          kind: "http" as const,
          label: "Call",
          http: { method: "POST" as const, url, headers, ...(body ? { body } : {}) },
        },
      ],
      edges: [],
    });
    expect(literalCredential(http({ Authorization: "Bearer sk_live_fixture" }))).toBe(
      '"Call": header Authorization',
    );
    expect(literalCredential(http({ "X-Api-Key": "abc" }))).toBe('"Call": header X-Api-Key');
    expect(literalCredential(http({ Authorization: "Bearer {{secret:API_TOKEN}}" }))).toBeNull();
    expect(literalCredential(http({ "X-Api-Key": "{{ secret:KEY }}" }))).toBeNull();
    expect(literalCredential(http({ "Content-Type": "application/json" }))).toBeNull();
    // FOUND IN REVIEW: the header was checked, the address and the body were not.
    expect(literalCredential(http({}, "https://x.test/hook?api_key=fixture123&day=1"))).toBe(
      '"Call": address parameter api_key',
    );
    expect(literalCredential(http({}, "https://x.test/hook?token={{secret:HOOK}}"))).toBeNull();
    expect(
      literalCredential(http({}, "https://x.test", '{"auth":{"client_secret":"fixture"}}')),
    ).toBe('"Call": body field client_secret');
    expect(literalCredential(http({}, "https://x.test", "user=a&password=fixture"))).toBe(
      '"Call": body field password',
    );
    expect(
      literalCredential(http({}, "https://x.test", '{"password":"{{secret:DB_PASSWORD}}"}')),
    ).toBeNull();
    expect(literalCredential(http({}, "https://x.test", '{"rows": 3, "table": "x"}'))).toBeNull();
  });

  it("names a repository by provider, host and path", () => {
    expect(repoKey({ provider: "github", repo: "/acme/ml/" })).toBe("github:acme/ml");
    expect(repoKey({ provider: "gitlab", repo: "g/p", host: "https://git.example.com/" })).toBe(
      "gitlab:https://git.example.com/g/p",
    );
    expect(repoKey({ provider: "gitlab", repo: "g/p", host: null })).toBe(
      "gitlab:https://gitlab.com/g/p",
    );
    expect(validRepoName("123456", "gitlab")).toBe(true);
    expect(validRepoName("123456", "github")).toBe(false);
  });

  it("writes the CI jobs with the secret's NAME, the commit, and only this file", () => {
    const s = ciSnippets({
      origin: "https://app.example.com/",
      workflowId: WF,
      path: PATH,
      branch: "main",
    });
    for (const text of [s.github, s.gitlab]) {
      expect(text).toContain("https://app.example.com/api/workflows/run");
      expect(text).toContain(WF);
      expect(text).toContain(PATH);
      expect(text).toMatch(/sync\\?":true/);
    }
    expect(s.github).toContain("${{ secrets.AGENTSWARMS_TRIGGER_TOKEN }}");
    expect(s.github).toContain('"ref":"${{ github.sha }}"');
    expect(s.github).toContain('branches: ["main"]');
    expect(s.gitlab).toContain("$AGENTSWARMS_TRIGGER_TOKEN");
    expect(s.gitlab).toContain('\\"ref\\":\\"$CI_COMMIT_SHA\\"');
    expect(s.gitlab).toContain('$CI_COMMIT_BRANCH == "main"');
  });

  it("links the file on GitHub and on a self-hosted GitLab", () => {
    expect(
      repoFileUrl(
        { provider: "github", repo: "acme/ml", branch: "release/1", host: null },
        "a b/c.json",
      ),
    ).toBe("https://github.com/acme/ml/blob/release/1/a%20b/c.json");
    expect(
      repoFileUrl(
        { provider: "gitlab", repo: "g/p", branch: "main", host: "https://git.example.com/" },
        "x.json",
      ),
    ).toBe("https://git.example.com/g/p/-/blob/main/x.json");
  });

  it("never makes a link from a host that is not a web address", () => {
    expect(
      repoFileUrl(
        { provider: "gitlab", repo: "g/p", branch: "main", host: "javascript:alert(1)" },
        "x.json",
      ),
    ).toBe("");
    expect(
      repoFileUrl({ provider: "gitlab", repo: "1234", branch: "main", host: null }, "x.json"),
    ).toBe("");
    const save = rd("src/utils/gitExport.functions.ts");
    expect(save).toContain(".refine((h) => /^https?:\\/\\//i.test(h)");
  });

  it("describes a model with its approvers counted, never named, and no data", () => {
    const doc = modelConfigDoc({
      model: {
        ...(seedModel() as never),
      },
      schedules: [],
      production: {
        version: 3,
        algorithm: "lightgbm",
        metrics: { auc: 0.81 },
        trained_at: null,
        training_rows: 10,
      },
    });
    const text = JSON.stringify(doc);
    expect(doc.promotion).toEqual({ needsApproval: true, approvers: 2 });
    expect(text).not.toContain("0000000000c3");
    expect(text).not.toMatch(/feature_stats|leaderboard|mean/);
  });
});

function seedModel() {
  seed();
  return db.tables.ml_models[0];
}

// ── Save, update and import, for real ──────────────────────────────────

describe("Save to repo", () => {
  it("commits the pipeline and the model it trains, and records both sides", async () => {
    const res = await saveWorkflowToRepo(USER, WF, "First save");
    expect(res).toMatchObject({ ok: true, path: PATH, files: 2 });
    const [commit] = repo.commits;
    expect(commit.message).toBe("First save");
    expect(commit.files.map((f) => f.path)).toEqual([PATH, "agentswarms/ml/models/churn-m-1.json"]);
    const file = JSON.parse(commit.files[0].content);
    expect(file.steps[0]).toMatchObject({
      targetId: "s-1",
      target: { name: "Weekly retrain", model: "Churn" },
    });
    const model = commit.files[1].content;
    expect(model).toContain('"approvers": 2');
    expect(model).not.toContain("0000000000c3");
    expect(model).not.toMatch(/feature_stats|leaderboard/);
    const l = link()!;
    expect(l).toMatchObject({
      path: PATH,
      synced_by: "save",
      synced_commit: repo.head,
      user_id: USER,
    });
    expect(l.local_hash).toBe(l.repo_hash);
    expect(l.local_hash).toBe(hash(commit.files[0].content));
    // Saving is not an edit: the version the editor holds stays put.
    expect(workflow().updated_at).toBe("2026-11-01T00:00:00.000Z");
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workflow.repo.save" }),
    );
  });

  it("never overwrites somebody else's file of the same name", async () => {
    repo.files.set(PATH, "{}");
    const res = await saveWorkflowToRepo(USER, WF);
    expect(res).toMatchObject({
      ok: true,
      path: "agentswarms/ml/pipelines/churn-pipeline-11111111.json",
    });
    expect(repo.files.get(PATH)).toBe("{}");
  });

  it("refuses a key typed into a header, before anything is written", async () => {
    (workflow().graph as { nodes: unknown[] }).nodes.push({
      id: "h",
      kind: "http",
      label: "Webhook",
      http: {
        method: "POST",
        url: "https://hooks.example.com",
        headers: { Authorization: "Bearer sk_fixture_typed" },
      },
    });
    const res = await saveWorkflowToRepo(USER, WF);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining('"Webhook": header Authorization'),
    });
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it("names the migration when the link table is not there, before committing anything", async () => {
    db.missing.add("workflow_repo_links");
    expect(await saveWorkflowToRepo(USER, WF)).toMatchObject({
      ok: false,
      error: expect.stringContaining("needs migration 20261204000000"),
    });
    expect(commitFiles).not.toHaveBeenCalled();
    expect(await pullWorkflowFromRepo(USER, WF, { apply: true, by: "ci" })).toMatchObject({
      ok: false,
      status: 503,
      error: expect.stringContaining("needs migration 20261204000000"),
    });
  });

  it("says where to connect a repository when there is none", async () => {
    db.tables.git_export_config = [];
    expect(await saveWorkflowToRepo(USER, WF)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Integrations → Git repository"),
    });
  });

  it("only saves the caller's own workflow", async () => {
    expect(await saveWorkflowToRepo(OTHER, WF)).toMatchObject({
      ok: false,
      error: "Workflow not found",
    });
  });
});

describe("Update from repo", () => {
  beforeEach(async () => {
    await saveWorkflowToRepo(USER, WF);
  });

  it("previews, then applies exactly the commit it previewed", async () => {
    editInRepo((f) => {
      (f.steps as unknown[]).push({
        id: "n2",
        kind: "notify",
        label: "Tell the team",
        text: "Retrained",
      });
      (f.edges as unknown[]).push({ from: "n1", to: "n2" });
    }, "bbbbbbb2222222222222222222222222222222bb");
    const preview = await pullWorkflowFromRepo(USER, WF, { apply: false, by: "pull" });
    expect(preview).toMatchObject({ ok: true, commit: "bbbbbbb2222222222222222222222222222222bb" });
    if (!preview.ok) return;
    expect(changesLine(preview.changes)).toBe("1 step added, 1 arrow changed");
    expect((workflow().graph as { nodes: unknown[] }).nodes).toHaveLength(1);

    const applied = await pullWorkflowFromRepo(USER, WF, {
      ref: preview.commit,
      apply: true,
      by: "pull",
    });
    expect(applied.ok).toBe(true);
    expect((workflow().graph as { nodes: { label: string }[] }).nodes.map((n) => n.label)).toEqual([
      "Retrain",
      "Tell the team",
    ]);
    // Whether it runs is not the file's to say.
    expect(workflow().is_active).toBe(true);
    expect(link()).toMatchObject({ synced_by: "pull", synced_commit: preview.commit });
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workflow.repo.pull" }),
    );
  });

  it("holds a file to every rule an editor save is held to, and changes nothing", async () => {
    editInRepo((f) => {
      (f.edges as unknown[]).push({ from: "n1", to: "ghost" });
    }, "ccccccc3333333333333333333333333333333cc");
    const res = await pullWorkflowFromRepo(USER, WF, { apply: true, by: "pull" });
    expect(res).toMatchObject({
      ok: false,
      status: 422,
      error: "An arrow points at a step that is gone",
    });
    repo.files.set(PATH, "{ not json");
    expect(await pullWorkflowFromRepo(USER, WF, { apply: true, by: "pull" })).toMatchObject({
      ok: false,
      status: 422,
      error: expect.stringContaining("not valid JSON"),
    });
    expect((workflow().graph as { edges: unknown[] }).edges).toEqual([]);
  });

  it("finds a step's target by name when the id is not the reader's, and says so when it cannot", async () => {
    editInRepo((f) => {
      (f.steps as Record<string, unknown>[])[0].targetId = "s-x"; // somebody else's schedule
    }, "ddddddd4444444444444444444444444444444dd");
    const ok = await pullWorkflowFromRepo(USER, WF, { apply: false, by: "pull" });
    expect(ok).toMatchObject({ ok: true, renamed: 1 });

    editInRepo((f) => {
      (f.steps as Record<string, unknown>[])[0].target = { name: "Weekly retrain", model: "Fraud" };
    }, "eeeeeee5555555555555555555555555555555ee");
    expect(await pullWorkflowFromRepo(USER, WF, { apply: false, by: "pull" })).toMatchObject({
      ok: false,
      error:
        'The step "Retrain" needs the ML schedule "Weekly retrain" of the model "Fraud", and you have none by that name',
    });

    db.tables.ml_schedules.push({
      id: "s-2",
      user_id: USER,
      name: "Weekly retrain",
      model_id: "m-1",
    });
    editInRepo((f) => {
      (f.steps as Record<string, unknown>[])[0].target = { name: "Weekly retrain", model: "Churn" };
    }, "fffffff6666666666666666666666666666666ff");
    expect(await pullWorkflowFromRepo(USER, WF, { apply: false, by: "pull" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("you have 2 by that name — rename one"),
    });
  });
});

describe("after the connected repository changes", () => {
  it("refuses to read the old path from the new repository, and saves anew there", async () => {
    await saveWorkflowToRepo(USER, WF);
    expect(link()).toMatchObject({ repo: "github:acme/ml" });
    (db.tables.git_export_config[0] as Row).repo = "acme/other";
    expect(await pullWorkflowFromRepo(USER, WF, { apply: true, by: "ci" })).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining("kept in github:acme/ml"),
    });
    const again = await saveWorkflowToRepo(USER, WF);
    expect(again).toMatchObject({ ok: true });
    expect(link()).toMatchObject({ repo: "github:acme/other" });
  });
});

describe("Import from repo", () => {
  it("lists the files nobody keeps yet, and imports one paused", async () => {
    await saveWorkflowToRepo(USER, WF);
    const other = JSON.parse(repo.files.get(PATH)!);
    other.name = "Fraud scoring";
    other.schedule = "daily";
    repo.files.set("agentswarms/ml/pipelines/fraud.json", JSON.stringify(other));
    const listed = await unlinkedPipelineFiles(USER);
    expect(listed).toMatchObject({
      ok: true,
      files: [{ path: "agentswarms/ml/pipelines/fraud.json", name: "fraud" }],
    });
    if (!listed.ok) return;

    const made = await importWorkflowFromRepo(
      USER,
      "agentswarms/ml/pipelines/fraud.json",
      listed.commit,
    );
    expect(made).toMatchObject({ ok: true, name: "Fraud scoring" });
    if (!made.ok) return;
    const row = db.tables.workflows.find((w) => w.id === made.id)!;
    expect(row).toMatchObject({ user_id: USER, is_active: false, schedule: "daily" });
    expect(db.tables.workflow_repo_links.find((l) => l.workflow_id === made.id)).toMatchObject({
      synced_by: "import",
      path: "agentswarms/ml/pipelines/fraud.json",
    });
  });

  it("only from the pipelines folder", async () => {
    for (const path of [
      "agentswarms/secrets.json",
      "agentswarms/ml/pipelines/../x.json",
      "other/ml/pipelines/a.json",
    ]) {
      expect(await importWorkflowFromRepo(USER, path, repo.head), path).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });
});

// ── The CI door ─────────────────────────────────────────────────────────

type Post = (a: { request: Request }) => Promise<Response>;
let POST: Post;
beforeAll(async () => {
  const { Route } = (await import("@/routes/api/workflows.run")) as unknown as {
    Route: { options: { server: { handlers: { POST: Post } } } };
  };
  POST = Route.options.server.handlers.POST;
}, 120_000);

const call = (body: Record<string, unknown>) =>
  POST({
    request: new Request("http://app.test/api/workflows/run", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id: WF, ...body }),
    }),
  });

describe("POST /api/workflows/run with sync", () => {
  beforeEach(async () => {
    await saveWorkflowToRepo(USER, WF);
    editInRepo((f) => {
      (f.steps as Record<string, unknown>[])[0].label = "Retrain weekly";
    }, "1234567aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("deploys a commit on the branch, then runs what it deployed", async () => {
    const res = await call({ sync: true, ref: "1234567aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: true,
      deployed: true,
      commit: "1234567aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      changes: "1 step changed",
    });
    const ran = vi.mocked(startWorkflowRun).mock.calls[0][0] as unknown as Row;
    expect((ran.graph as { nodes: { label: string }[] }).nodes[0].label).toBe("Retrain weekly");
    expect(link()).toMatchObject({ synced_by: "ci" });
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workflow.repo.deploy" }),
    );
  });

  it("refuses a commit that never reached the branch, and another branch by name", async () => {
    const off = await call({ sync: true, ref: "9999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(off.status).toBe(409);
    expect((await off.json()).error).toContain("is not on main");
    const branch = await call({ sync: true, ref: "feature/unreviewed" });
    expect(branch.status).toBe(409);
    expect((await branch.json()).error).toContain('not "feature/unreviewed"');
    expect(startWorkflowRun).not.toHaveBeenCalled();
    expect((workflow().graph as { nodes: { label: string }[] }).nodes[0].label).toBe("Retrain");
  });

  it("deploys without running with run: false, even while paused", async () => {
    workflow().is_active = false;
    const res = await call({ sync: true, run: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deployed: true, changes: "1 step changed" });
    expect(startWorkflowRun).not.toHaveBeenCalled();
    expect((await call({ sync: true })).status).toBe(409);
  });

  it("refuses the new fields used wrongly", async () => {
    expect((await call({ ref: "main" })).status).toBe(400);
    expect((await call({ run: false })).status).toBe(400);
    expect((await call({ sync: "yes" })).status).toBe(400);
  });

  it("answers a workflow not kept in a repository with a reason", async () => {
    db.tables.workflow_repo_links = [];
    const res = await call({ sync: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("not kept in a repository");
  });
});

// ── Promotion stays gated, whoever asks ────────────────────────────────

describe("a gated model's promotion", () => {
  it("asks the approvers when a schedule or the API promotes, instead of promoting", async () => {
    const { promoteVersion } = await import("@/utils/ml/api.server");
    db.tables.ml_model_versions.push({
      id: "v-2",
      user_id: USER,
      model_id: "m-1",
      version: 4,
      status: "ready",
      stage: "candidate",
    });
    const model = db.tables.ml_models[0] as never;
    const res = await promoteVersion(model, "v-2", USER);
    expect(res).toEqual({ ok: true, pending: true });
    expect((db.tables.ml_models[0] as Row).production_version_id).toBe("v-1");
    expect(db.tables.approvals).toHaveLength(1);
    expect(db.tables.approvals[0]).toMatchObject({
      action_type: "ml.promote",
      payload: { version_id: "v-2" },
    });
  });

  it("the schedule records that it is waiting, not that it promoted", () => {
    const src = rd("src/utils/ml/schedule.server.ts");
    expect(src).toContain("promoted = res.ok && !res.pending;");
    expect(src).toMatch(/: pending\s*\? "awaiting_approval"/);
    const api = rd("src/utils/ml/api.server.ts");
    expect(api).toContain("promoted = res.ok && !res.pending;");
    expect(rd("src/routes/api/ml.models.register.ts")).toContain("promotion_pending: true");
  });
});

describe("the link table (migration 20261204000000)", () => {
  const sql = rd("supabase/migrations/20261204000000_workflow_repo_links.sql");
  it("is owner-readable and server-written", () => {
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toMatch(/FOR SELECT\s+USING \(auth\.uid\(\) = user_id\)/);
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(sql).toContain("REFERENCES public.workflows(id) ON DELETE CASCADE");
    expect(sql).toContain("synced_by IN ('save', 'pull', 'import', 'ci')");
  });
});

describe("found from the UI in R541", () => {
  it("names a picker's choice with the right article and the acronym kept", async () => {
    const { pickPlaceholder } = await import("@/lib/workflows");
    expect(pickPlaceholder("ML schedule")).toBe("Pick an ML schedule…");
    expect(pickPlaceholder("Notebook")).toBe("Pick a notebook…");
    expect(pickPlaceholder("Prep flow")).toBe("Pick a prep flow…");
    expect(pickPlaceholder("ETL pipeline")).toBe("Pick an ETL pipeline…");
    expect(pickPlaceholder("KPI")).toBe("Pick a KPI…");
    expect(rd("src/components/workflows/StepInspector.tsx")).toContain(
      "placeholder={pickPlaceholder(label)}",
    );
  });

  it("calls a running pipeline row a pipeline run, so a pipeline named ML pipeline reads once", () => {
    const ops = rd("src/routes/_authenticated/ml_.operations.tsx");
    expect(ops).toContain("> · pipeline run</span>");
    expect(ops).not.toContain("> · ML pipeline</span>");
  });
});

describe("the ML pipelines page without the link table", () => {
  it("still shows the repository, and says which migration is missing", () => {
    const fns = rd("src/utils/mlRepo.functions.ts");
    expect(fns).toContain(
      "return { ok: true, repo, links: [], linksError: (e as Error).message };",
    );
    expect(rd("src/routes/_authenticated/ml_.pipelines.tsx")).toContain(
      "setRepoError(inRepo.ok ? (inRepo.linksError ?? null) : inRepo.error);",
    );
  });
});

describe("the connect-a-repository hint", () => {
  it("is one run of text, so its link and full stop sit in the sentence", () => {
    const src = rd("src/components/ml/PipelineRepo.tsx");
    const hint = src.slice(src.indexOf("if (!repo) {"), src.indexOf("Keep these pipelines"));
    expect(hint).toContain('<p className="text-xs text-muted-foreground">');
    expect(hint).not.toMatch(/<p className="[^"]*\bflex\b/);
  });
});
