// ML pipelines and Kubeflow Pipelines (R540).
//
// The client against a stand-in server that answers the way Kubeflow
// Pipelines' v2beta1 API does (the real one, 2.18.0 on kind, is driven end
// to end in docs/UI_TEST_RESULTS.md), the connection type, the workflow step
// that runs a pipeline, and the ML pipelines view over the workflows.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  answer: (
    _method: string,
    _path: string,
    _body: string | null,
  ): { status: number; body: string } => ({
    status: 200,
    body: "{}",
  }),
  calls: [] as {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
  }[],
  thrown: null as Error | null,
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/ssrfGuard.server", () => ({
  safeFetch: async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    if (fake.thrown) throw fake.thrown;
    const body = typeof init.body === "string" ? init.body : null;
    fake.calls.push({ method: init.method ?? "GET", url, headers: init.headers ?? {}, body });
    const u = new URL(url);
    const a = fake.answer(init.method ?? "GET", `${u.pathname}${u.search}`, body);
    return new Response(a.body, { status: a.status });
  },
  providerFetch: async () => new Response("{}"),
  withPrivatePathScope: async (fn: (p: unknown) => unknown) => fn({}),
  PrivatePathRequiredError: class extends Error {},
}));

const kf = await import("@/utils/ml/kubeflowClient.server");
const { integrationSecretFields, integrationShareableFields } =
  await import("@/utils/providers/integrationConfig.server");
const { integrationHosts } = await import("@/utils/providers/integrationHosts");
const { testKubeflowCore } = await import("@/utils/integrations/testAdapters.server");
const wf = await import("@/lib/workflows");
const mp = await import("@/lib/mlPipelines");

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const conn = { api_url: "http://kfp.internal:8888", auth: "token", token: "kfp-test-token" };

const SPEC = {
  root: {
    inputDefinitions: {
      parameters: {
        table: { parameterType: "STRING" },
        epochs: { parameterType: "NUMBER_INTEGER", defaultValue: 5 },
        rate: { parameterType: "NUMBER_DOUBLE", isOptional: true },
        dry_run: { parameterType: "BOOLEAN", defaultValue: false },
        columns: { parameterType: "LIST", isOptional: true },
      },
    },
  },
};

beforeEach(() => {
  fake.calls = [];
  fake.thrown = null;
  fake.answer = () => ({ status: 200, body: "{}" });
});

describe("the Kubeflow Pipelines client", () => {
  it("calls only http(s) addresses with no credentials in them, and sends the token as a bearer", async () => {
    expect(kf.kubeflowBase("https://kf.example.com/pipeline/")).toBe(
      "https://kf.example.com/pipeline",
    );
    expect(kf.kubeflowBase("https://user:pw@kf.example.com")).toBeNull();
    expect(kf.kubeflowBase("file:///etc/passwd")).toBeNull();
    expect(kf.kubeflowBase("https://kf.example.com/?x=1")).toBeNull();
    fake.answer = () => ({
      status: 200,
      body: JSON.stringify({ tag_name: "2.18.0", multi_user: false }),
    });
    expect(await kf.kubeflowHealth(conn)).toEqual({ version: "2.18.0", multiUser: false });
    expect(fake.calls[0].url).toBe("http://kfp.internal:8888/apis/v2beta1/healthz");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer kfp-test-token");
  });

  it("reads every page of pipelines, and skips a row whose id it would not put in a path", async () => {
    fake.answer = (_m, path) =>
      path.includes("page_token=p2")
        ? {
            status: 200,
            body: JSON.stringify({ pipelines: [{ pipeline_id: "p3", display_name: "c" }] }),
          }
        : {
            status: 200,
            body: JSON.stringify({
              pipelines: [
                {
                  pipeline_id: "11111111-1111-4111-8111-111111111111",
                  display_name: "train",
                  description: "nightly",
                },
                { pipeline_id: "../../etc", display_name: "bad" },
              ],
              next_page_token: "p2",
            }),
          };
    const list = await kf.kubeflowPipelines({ ...conn, namespace: "team-ml" });
    expect(list.map((p) => p.name)).toEqual(["train", "c"]);
    expect(fake.calls[0].url).toContain("namespace=team-ml");
    expect(fake.calls[0].url).toContain("sort_by=created_at%20desc");
  });

  it("reads a version's inputs from its spec, defaults as text", () => {
    expect(kf.specParameters(SPEC)).toEqual([
      { name: "table", type: "STRING", default: null, optional: false },
      { name: "epochs", type: "NUMBER_INTEGER", default: "5", optional: true },
      { name: "rate", type: "NUMBER_DOUBLE", default: null, optional: true },
      { name: "dry_run", type: "BOOLEAN", default: "false", optional: true },
      { name: "columns", type: "LIST", default: null, optional: true },
    ]);
    expect(kf.specParameters(null)).toEqual([]);
  });

  it("types a run's text parameters against the version, refusing what Kubeflow would refuse", () => {
    const declared = kf.specParameters(SPEC);
    expect(
      kf.runParameters(
        { table: "main.orders", epochs: "12", rate: "0.05", dry_run: "TRUE", columns: '["a","b"]' },
        declared,
      ),
    ).toEqual({ table: "main.orders", epochs: 12, rate: 0.05, dry_run: true, columns: ["a", "b"] });
    expect(() => kf.runParameters({ table: "t", epochs: "1.5" }, declared)).toThrow(
      "Parameter epochs must be a whole number",
    );
    expect(() => kf.runParameters({ table: "t", dry_run: "yes" }, declared)).toThrow(
      "must be true or false",
    );
    expect(() => kf.runParameters({ table: "t", columns: "{}" }, declared)).toThrow("JSON list");
    expect(() => kf.runParameters({ table: "t", lr: "1" }, declared)).toThrow(
      "The pipeline has no parameter named lr; it takes table, epochs, rate, dry_run, columns.",
    );
    expect(() => kf.runParameters({}, declared)).toThrow("The pipeline needs table.");
  });

  it("reads the inputs exactly as the KFP 2.18.0 SDK compiles them", () => {
    // Verbatim from `score_rows` compiled with kfp 2.18.0 (R540), the
    // integer's default written as 5.0 the way the SDK writes it.
    const compiled = {
      root: {
        inputDefinitions: {
          parameters: {
            dry_run: { defaultValue: false, isOptional: true, parameterType: "BOOLEAN" },
            rows: { defaultValue: 5.0, isOptional: true, parameterType: "NUMBER_INTEGER" },
            table: { parameterType: "STRING" },
            threshold: { defaultValue: 0.5, isOptional: true, parameterType: "NUMBER_DOUBLE" },
          },
        },
      },
      schemaVersion: "2.1.0",
      sdkVersion: "kfp-2.18.0",
    };
    const declared = kf.specParameters(compiled);
    expect(declared).toEqual([
      { name: "dry_run", type: "BOOLEAN", default: "false", optional: true },
      { name: "rows", type: "NUMBER_INTEGER", default: "5", optional: true },
      { name: "table", type: "STRING", default: null, optional: false },
      { name: "threshold", type: "NUMBER_DOUBLE", default: "0.5", optional: true },
    ]);
    // A value typed the SDK's way is a whole number too.
    expect(kf.runParameters({ table: "main.orders", rows: "5.0" }, declared)).toEqual({
      table: "main.orders",
      rows: 5,
    });
  });

  it("starts a run of one version, with typed parameters", async () => {
    fake.answer = (m) => ({
      status: 200,
      body: JSON.stringify({ run_id: "22222222-2222-4222-8222-222222222222", state: "PENDING" }),
    });
    const id = await kf.kubeflowStartRun(conn, {
      pipelineId: "11111111-1111-4111-8111-111111111111",
      versionId: "33333333-3333-4333-8333-333333333333",
      displayName: "Score orders · workflow run 1a2b3c4d",
      parameters: { table: "main.orders", epochs: 12 },
    });
    expect(id).toBe("22222222-2222-4222-8222-222222222222");
    const sent = JSON.parse(fake.calls[0].body ?? "{}");
    expect(fake.calls[0].url).toBe("http://kfp.internal:8888/apis/v2beta1/runs");
    expect(sent).toEqual({
      display_name: "Score orders · workflow run 1a2b3c4d",
      pipeline_version_reference: {
        pipeline_id: "11111111-1111-4111-8111-111111111111",
        pipeline_version_id: "33333333-3333-4333-8333-333333333333",
      },
      runtime_config: { parameters: { table: "main.orders", epochs: 12 } },
    });
  });

  it("maps a run's states to done or not, and says why one failed", () => {
    expect(kf.runOutcome({ state: "RUNNING" })).toEqual({ done: false, state: "RUNNING" });
    expect(kf.runOutcome({ state: "PENDING" }).done).toBe(false);
    expect(kf.runOutcome({ state: "CANCELING" }).done).toBe(false);
    expect(kf.runOutcome({ state: "SUCCEEDED" })).toEqual({
      done: true,
      ok: true,
      state: "SUCCEEDED",
    });
    expect(kf.runOutcome({ state: "SKIPPED" }).done).toBe(true);
    expect(kf.runOutcome({ state: "FAILED", error: { message: "OOMKilled" } })).toMatchObject({
      ok: false,
      error: "The Kubeflow run failed: OOMKilled",
    });
    expect(
      kf.runOutcome({
        state: "FAILED",
        run_details: {
          task_details: [
            { state: "SUCCEEDED", display_name: "load" },
            { state: "FAILED", display_name: "train", error: { message: "exit code 1" } },
          ],
        },
      }),
    ).toMatchObject({ error: "The Kubeflow run failed: train: exit code 1" });
    expect(kf.runOutcome({ state: "CANCELED" })).toMatchObject({
      ok: false,
      error: "The run was cancelled in Kubeflow.",
    });
  });

  it("names the step that failed, from the task list KFP 2.18.0 really returns", () => {
    // MEASURED (R540): a failed run of `always-fails` on Kubeflow Pipelines
    // 2.18.0. No message anywhere; the task list is flat, with the
    // pipeline's machinery among its one real step, "fail".
    const tasks = [
      ["executor(0)", "FAILED"],
      ["root(0)", "FAILED"],
      ["always-fails-xrb5g", "FAILED"],
      ["fail-driver", "SUCCEEDED"],
      ["root", "FAILED"],
      ["always-fails-xrb5g(0)", "FAILED"],
      ["fail(0)", "FAILED"],
      ["executor", "FAILED"],
      ["root-driver", "SUCCEEDED"],
      ["fail", "FAILED"],
      ["fail-driver(0)", "SUCCEEDED"],
      ["root-driver(0)", "SUCCEEDED"],
    ].map(([display_name, state]) => ({ display_name, state, error: null }));
    expect(
      kf.runOutcome({ state: "FAILED", error: null, run_details: { task_details: tasks } }),
    ).toMatchObject({
      done: true,
      ok: false,
      error: 'The Kubeflow run failed at the step "fail"; its log in Kubeflow says why.',
    });
    // Nothing to go on: said plainly.
    expect(kf.runOutcome({ state: "FAILED" })).toMatchObject({
      error: "The Kubeflow run failed.",
    });
  });

  it("says in words why a call failed: refused, a sign-in page, a redirect, nothing there", async () => {
    fake.answer = () => ({ status: 401, body: "{}" });
    await expect(kf.kubeflowHealth(conn)).rejects.toThrow("Kubeflow refused the credentials.");
    fake.answer = () => ({ status: 200, body: "<html><body>Sign in</body></html>" });
    await expect(kf.kubeflowHealth(conn)).rejects.toThrow("usually its sign-in");
    fake.answer = () => ({
      status: 400,
      body: JSON.stringify({ code: 3, message: "Invalid input error: bad parameter" }),
    });
    await expect(kf.kubeflowCall(conn, "GET", "/runs")).rejects.toThrow(
      "Invalid input error: bad parameter",
    );
    fake.thrown = new Error("Too many redirects");
    await expect(kf.kubeflowHealth(conn)).rejects.toThrow("answered with a redirect");
    fake.thrown = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    await expect(kf.kubeflowHealth(conn)).rejects.toThrow(
      "Nothing is answering at kfp.internal:8888: Kubeflow Pipelines is not running there.",
    );
  });

  it("links a run's page in the Pipelines UI, and nothing else", () => {
    expect(kf.kubeflowRunUrl({ api_url: "https://kf.example.com/pipeline" }, "abc-123")).toBe(
      "https://kf.example.com/pipeline/#/runs/details/abc-123",
    );
    expect(kf.kubeflowRunUrl({ api_url: "https://kf.example.com" }, "javascript:x")).toBeNull();
  });
});

describe("the Kubeflow connection type", () => {
  it("keeps its token encrypted, and sends it only to the Pipelines address", () => {
    expect(integrationSecretFields("kubeflow")).toEqual(["token"]);
    expect(integrationShareableFields("kubeflow")).toEqual(["token"]);
    expect(integrationHosts("kubeflow")({ api_url: "https://kf.example.com/pipeline" })).toEqual([
      "https://kf.example.com/pipeline",
    ]);
  });

  it("is a type the database takes, beside every type it already took", () => {
    const sql = read("supabase/migrations/20261203000000_kubeflow_pipelines.sql");
    for (const t of [
      "llm_provider",
      "llm_gateway",
      "n8n",
      "firecrawl",
      "notification",
      "mlflow",
      "kubeflow",
    ]) {
      expect(sql, t).toContain(`'${t}'`);
    }
    // The newest migration that names the CHECK is this one.
    const dir = join(process.cwd(), "supabase/migrations");
    const naming = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        /ADD CONSTRAINT integrations_type_check/.test(readFileSync(join(dir, f), "utf8")),
      );
    expect(naming.at(-1)).toBe("20261203000000_kubeflow_pipelines.sql");
  });

  it("tests what a step will do: health, then the pipelines list, with the token", async () => {
    fake.answer = (_m, path) =>
      path.startsWith("/apis/v2beta1/healthz")
        ? { status: 200, body: JSON.stringify({ tag_name: "2.18.0", multi_user: false }) }
        : {
            status: 200,
            body: JSON.stringify({ pipelines: [{ pipeline_id: "p1", display_name: "x" }] }),
          };
    const r = await testKubeflowCore({
      api_url: "http://kfp.internal:8888/",
      auth: "token",
      token: "t",
    });
    expect(r).toMatchObject({ ok: true, version: "2.18.0", pipelines: 1 });
    expect(r.detail).toBe(
      "Reached Kubeflow Pipelines 2.18.0 at http://kfp.internal:8888: 1 pipeline a workflow can run.",
    );
    fake.answer = () => ({
      status: 200,
      body: JSON.stringify({ tag_name: "2.18.0", multi_user: true }),
    });
    expect((await testKubeflowCore({ api_url: "http://kfp.internal:8888" })).detail).toContain(
      "It is multi-user, so name the profile namespace",
    );
    fake.answer = () => ({ status: 404, body: "404 page not found" });
    expect((await testKubeflowCore({ api_url: "http://kfp.internal:8888" })).detail).toContain(
      "on a full Kubeflow it ends in /pipeline",
    );
    expect(
      (await testKubeflowCore({ api_url: "http://kfp.internal", namespace: "Team ML" })).detail,
    ).toContain("lowercase letters, digits and dashes");
  });
});

describe("the Kubeflow pipeline step", () => {
  const node = (k?: Partial<NonNullable<import("@/lib/workflows").WorkflowNode["kubeflow"]>>) =>
    ({
      id: "n1",
      kind: "kubeflow_run",
      label: "Train on Kubeflow",
      kubeflow: k ? { integrationId: "", pipelineId: "", ...k } : undefined,
    }) as import("@/lib/workflows").WorkflowNode;

  it("is a kind a workflow, the runner's table and the palette all know", () => {
    expect(wf.NODE_KINDS).toContain("kubeflow_run");
    expect(wf.NODE_KIND_LABEL.kubeflow_run).toBe("Kubeflow pipeline");
    const sql = read("supabase/migrations/20261203000000_kubeflow_pipelines.sql");
    for (const kind of wf.NODE_KINDS) expect(sql, kind).toContain(`'${kind}'`);
    expect(read("src/components/workflows/nodeStyles.ts")).toContain(
      'kinds: ["ml_schedule", "kubeflow_run", "notebook", "swarm"]',
    );
  });

  it("needs a connection and a pipeline, and parameter names a pipeline could have", () => {
    expect(wf.validateNodeTarget(node(), "x")).toBe(
      'The Kubeflow step "x" has no connection chosen',
    );
    expect(wf.validateNodeTarget(node({ integrationId: "c" }), "x")).toBe(
      'The Kubeflow step "x" has no pipeline chosen',
    );
    expect(wf.validateNodeTarget(node({ integrationId: "c", pipelineId: "p" }), "x")).toBeNull();
    expect(
      wf.validateNodeTarget(
        node({ integrationId: "c", pipelineId: "p", parameters: { "a b": "1" } }),
        "x",
      ),
    ).toBe('"a b" is not a pipeline parameter name');
  });

  it("finds {{params.x}} in its parameter values", () => {
    const g = {
      nodes: [
        node({ integrationId: "c", pipelineId: "p", parameters: { table: "{{params.table}}" } }),
      ],
      edges: [],
      params: [],
    };
    expect(wf.referencedParams(g)).toEqual(["table"]);
  });

  it("starts the run with the owner's own connection, and polls it by the id it stored", () => {
    const a = read("src/utils/workflows/adapters.server.ts");
    expect(a).toContain("const c = await kubeflowConnectionOf(userId, k.integrationId);");
    expect(a).toContain("targetRunId: `kubeflow:${k.integrationId}:${kfRunId}`");
    // A moment of Kubeflow being unreachable is not the run failing.
    expect(a).toContain("return unsettled(e as Error);");
    expect(a).toContain(
      'if ((e as { status?: number }).status === 404) return gone("Kubeflow run");',
    );
    const conn = read("src/utils/ml/kubeflow.server.ts");
    expect(conn).toContain('.eq("user_id", userId)');
    expect(conn).toContain('.eq("type", "kubeflow")');
    expect(conn).toContain('sendTo: integrationHosts("kubeflow")');
    // And a save refuses a connection that is not the owner's.
    expect(read("src/utils/workflows/definition.server.ts")).toContain(
      "One Kubeflow step uses a connection that is gone, or is not yours.",
    );
  });

  it("links the run in Kubeflow, only when the address is http(s)", async () => {
    const { stepRunLink } = await import("@/components/workflows/nodeStyles");
    expect(
      stepRunLink("kubeflow_run", "kubeflow:x:y", {
        url: "https://kf.example.com/#/runs/details/y",
      }),
    ).toEqual({
      href: "https://kf.example.com/#/runs/details/y",
      label: "Open in Kubeflow",
      external: true,
    });
    expect(stepRunLink("kubeflow_run", "kubeflow:x:y", { url: "javascript:alert(1)" })).toBeNull();
  });
});

describe("ML pipelines", () => {
  it("are the workflows that train, score or run a Kubeflow pipeline", () => {
    const g = (kinds: string[]) =>
      ({
        nodes: kinds.map((k, i) => ({ id: `n${i}`, kind: k, label: "" })),
        edges: [],
        params: [],
      }) as unknown as import("@/lib/workflows").WorkflowGraph;
    expect(mp.isMlPipeline(g(["pipeline", "ml_schedule"]))).toBe(true);
    expect(mp.isMlPipeline(g(["kubeflow_run"]))).toBe(true);
    expect(mp.isMlPipeline(g(["pipeline", "sql", "notify"]))).toBe(false);
    expect(mp.isMlPipeline(null)).toBe(false);
  });

  it("start as retrain, then score, and read in the order they run", () => {
    const s = mp.mlPipelineStarter();
    expect(mp.isMlPipeline(s)).toBe(true);
    expect(mp.pipelineSteps(s)).toEqual(["Retrain", "Score new rows"]);
    // Unconfigured on purpose: a save asks for both schedules.
    expect(wf.validateWorkflow({ name: "ML pipeline", graph: s })).toContain(
      "has nothing selected",
    );
  });

  it("say how they start", () => {
    expect(mp.triggerLine({ schedule: "manual", is_active: true })).toBe("When started");
    expect(mp.triggerLine({ schedule: "daily", is_active: true })).toBe("Every day");
    expect(mp.triggerLine({ schedule: "cron", cron_expr: "0 2 * * *", is_active: true })).toBe(
      "On a schedule (0 2 * * *)",
    );
    expect(mp.triggerLine({ schedule: "daily", is_active: false })).toBe("Paused");
  });

  it("are read only from the caller's own workflows, and named without taking another's name", () => {
    const fns = read("src/utils/mlConsole.functions.ts");
    const list = fns.slice(fns.indexOf("async function pipelinesFor("));
    expect(list).toContain('.from("workflows")');
    expect(list.slice(0, list.indexOf(".limit(200)"))).toContain('.eq("user_id", userId)');
    expect(fns).toContain(
      "for (let i = 2; names.has(name) && i < 1000; i++) name = `ML pipeline ${i}`;",
    );
  });

  it("are in the menu under Deploy, and their runs in ML operations", async () => {
    const { NAV_GROUPS } = await import("@/lib/appNav");
    const ds = NAV_GROUPS.find((g) => g.label === "Data science")!;
    const item = ds.items.find((i) => i.url === "/ml/pipelines");
    expect(item).toMatchObject({ title: "ML pipelines", stage: "Deploy" });
    const ops = read("src/routes/_authenticated/ml_.operations.tsx");
    expect(ops).toContain("data.pipelineRunning.map");
    expect(ops).toContain('r.type === "pipeline"');
  });
});
