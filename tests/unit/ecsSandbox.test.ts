// The ECS sandbox backend (R477), against ECS and CloudWatch Logs answers in
// the shapes their API references give. No AWS account is involved: what is
// checked is what the backend sends, and what it makes of each answer.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import {
  EcsConfigError,
  OPEN_ENV,
  createEcsOrchestrator,
  ecsConfigFromEnv,
  fargateSize,
  type EcsSandboxConfig,
} from "@/utils/notebookRuntime/ecs.server";
import type { KernelSpec } from "@/utils/notebookRuntime/orchestrator";

const ENV = {
  AWS_REGION: "eu-west-1",
  NOTEBOOK_ECS_CLUSTER: "agentswarms",
  NOTEBOOK_ECS_TASK_DEFINITION: "agentswarms-sandbox",
  NOTEBOOK_ECS_SUBNETS: "subnet-aaa, subnet-bbb",
  NOTEBOOK_ECS_SECURITY_GROUPS: "sg-111",
  NOTEBOOK_ECS_BATCH_CAPACITY_PROVIDER: "FARGATE_SPOT",
  NOTEBOOK_ECS_LOG_GROUP: "/agentswarms/sandboxes",
};

const ARN = "arn:aws:ecs:eu-west-1:123456789012:task/agentswarms/0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SID = "6f0d3c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f";

type Sent = {
  url: string;
  target: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

/** An AWS that answers each action from a queue, and records what it was sent. */
function fakeAws(answers: Record<string, { status?: number; body: unknown }[]>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const target = headers["x-amz-target"];
    const action = target.slice(target.indexOf(".") + 1);
    sent.push({ url, target, body: JSON.parse(String(init.body)), headers });
    const next = answers[action]?.shift();
    if (!next) throw new Error(`no answer queued for ${action}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/x-amz-json-1.1" },
    });
  });
  return { fetch, sent };
}

const credentials = {
  source: "env" as const,
  get: async () => ({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: "session-token-example",
    expiresAt: null,
    source: "env" as const,
    identity: "test",
  }),
};

function orchestrator(
  answers: Record<string, { status?: number; body: unknown }[]>,
  cfg: EcsSandboxConfig = ecsConfigFromEnv(ENV),
) {
  const aws = fakeAws(answers);
  const staged: {
    sessionId: string;
    userId: string;
    env: Record<string, string>;
    nonce: string;
  }[] = [];
  const orch = createEcsOrchestrator(cfg, {
    fetch: aws.fetch,
    credentials,
    sleep: async () => {},
    stage: async (sessionId, userId, env, nonce) => {
      staged.push({ sessionId, userId, env, nonce });
    },
  });
  return { orch, aws, staged };
}

const SECRET_ENV = {
  AGENTSWARMS_TOKEN: "eyJhbGciOi.session.token",
  KG_AUTH_TOKEN: "port-token-hmac",
  NB_INPUTS: JSON.stringify({ rows: "x".repeat(100_000) }),
  NB_ENTRYPOINT: "main",
  NB_RESULT_CALLBACK: "http://app.internal:3000/api/notebook/runtime/result",
};

function spec(over: Partial<KernelSpec> = {}): KernelSpec {
  return {
    sessionId: SID,
    userId: "user-1",
    kind: "batch",
    image: "ignored-on-ecs",
    cpuLimit: "1",
    memLimitMb: 2048,
    timeoutSeconds: 3600,
    env: {
      NB_MODE: "batch",
      NB_SESSION_ID: SID,
      AGENTSWARMS_ORIGIN: "http://app.internal:3000",
      KG_IP: "0.0.0.0",
      KG_PORT: "8888",
      HTTPS_PROXY: "http://egress.internal:3128",
      NO_PROXY: "app.internal,localhost",
      ...SECRET_ENV,
    },
    ...over,
  };
}

const runOk = { body: { tasks: [{ taskArn: ARN, lastStatus: "PROVISIONING" }], failures: [] } };

describe("configuration", () => {
  it("names every setting that is missing", () => {
    expect(() => ecsConfigFromEnv({})).toThrow(EcsConfigError);
    expect(() => ecsConfigFromEnv({})).toThrow(
      /NOTEBOOK_ECS_CLUSTER, NOTEBOOK_ECS_TASK_DEFINITION, NOTEBOOK_ECS_SUBNETS, NOTEBOOK_ECS_SECURITY_GROUPS, AWS_REGION/,
    );
  });

  it("reads lists, defaults and per-kind settings", () => {
    const cfg = ecsConfigFromEnv(ENV);
    expect(cfg.subnets).toEqual(["subnet-aaa", "subnet-bbb"]);
    expect(cfg.container).toBe("kernel");
    expect(cfg.capacityProvider).toEqual({
      interactive: "FARGATE",
      service: "FARGATE",
      batch: "FARGATE_SPOT",
    });
    expect(cfg.taskDefinition.batch).toBe("agentswarms-sandbox");
    expect(cfg.ecsEndpoint).toBe("https://ecs.eu-west-1.amazonaws.com");
    expect(cfg.logsEndpoint).toBe("https://logs.eu-west-1.amazonaws.com");
  });

  it("takes VPC endpoint, FIPS and China endpoints", () => {
    expect(
      ecsConfigFromEnv({
        ...ENV,
        AWS_ENDPOINT_URL_ECS: "https://vpce-1.ecs.eu-west-1.vpce.amazonaws.com/",
      }).ecsEndpoint,
    ).toBe("https://vpce-1.ecs.eu-west-1.vpce.amazonaws.com");
    expect(ecsConfigFromEnv({ ...ENV, AWS_USE_FIPS_ENDPOINT: "true" }).ecsEndpoint).toBe(
      "https://ecs-fips.eu-west-1.amazonaws.com",
    );
    expect(ecsConfigFromEnv({ ...ENV, AWS_REGION: "cn-north-1" }).logsEndpoint).toBe(
      "https://logs.cn-north-1.amazonaws.com.cn",
    );
  });
});

describe("Fargate sizes", () => {
  it.each([
    ["1", 2048, "1024", "2048"],
    ["0.25", 256, "256", "512"],
    ["500m", 512, "512", "1024"],
    ["2", 4096, "2048", "4096"],
    ["1", 10_000, "2048", "10240"], // 1 vCPU tops out at 8 GB
    ["4", 32_768, "8192", "32768"], // 4 vCPU tops out at 30 GB
    ["8", 20_000, "8192", "20480"], // 4 GB steps
    ["1.5", 3000, "2048", "4096"],
  ])("cpu %s, %i MB → %s/%s", (cpu, mem, wantCpu, wantMem) => {
    expect(fargateSize(cpu, mem)).toEqual({ cpu: wantCpu, memory: wantMem });
  });

  it("refuses more than Fargate has, saying where to change it", () => {
    expect(() => fargateSize("16", 200_000)).toThrow(/largest is 16 vCPU with 120 GB/);
    expect(() => fargateSize("32", 1024)).toThrow(EcsConfigError);
    expect(() => fargateSize("lots", 1024)).toThrow(/not a CPU limit/);
  });
});

describe("starting a sandbox", () => {
  it("sends a signed RunTask with the session as its client token", async () => {
    const { orch, aws } = orchestrator({ RunTask: [runOk] });
    expect(await orch.create(spec())).toEqual({ ref: ARN });
    const [call] = aws.sent;
    expect(call.url).toBe("https://ecs.eu-west-1.amazonaws.com/");
    expect(call.target).toBe("AmazonEC2ContainerServiceV20141113.RunTask");
    expect(call.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(call.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/ecs\/aws4_request/,
    );
    expect(call.headers["x-amz-security-token"]).toBe("session-token-example");
    expect(call.body).toMatchObject({
      cluster: "agentswarms",
      taskDefinition: "agentswarms-sandbox",
      count: 1,
      clientToken: SID,
      startedBy: `nb-${SID}`,
      capacityProviderStrategy: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ["subnet-aaa", "subnet-bbb"],
          securityGroups: ["sg-111"],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: { cpu: "1024", memory: "2048" },
    });
  });

  it("puts no secret in the overrides, only a nonce the app keeps the environment for", async () => {
    const { orch, aws, staged } = orchestrator({ RunTask: [runOk] });
    await orch.create(spec());
    const sent = JSON.stringify(aws.sent[0].body);
    for (const [name, value] of Object.entries(SECRET_ENV)) {
      expect(sent, `${name} went to RunTask`).not.toContain(name);
      // Whole values: a prefix would match the bootstrap URL, which shares
      // the app's origin with the result callback.
      expect(sent, `${name}'s value went to RunTask`).not.toContain(
        JSON.stringify(value).slice(1, -1),
      );
    }
    // What stays in the open is the plumbing, and the way to the rest.
    const env = Object.fromEntries(
      (
        aws.sent[0].body.overrides as {
          containerOverrides: { environment: { name: string; value: string }[] }[];
        }
      ).containerOverrides[0].environment.map((e) => [e.name, e.value]),
    );
    expect(env).toMatchObject({
      NB_MODE: "batch",
      NB_SESSION_ID: SID,
      HTTPS_PROXY: "http://egress.internal:3128",
      NB_BOOTSTRAP_URL: "http://app.internal:3000/api/notebook/runtime/bootstrap",
    });
    expect(env.NB_BOOTSTRAP_NONCE).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The whole environment, secrets included, is kept under that nonce.
    expect(staged).toEqual([
      { sessionId: SID, userId: "user-1", env: spec().env, nonce: env.NB_BOOTSTRAP_NONCE },
    ]);
    // The 100 KB input is not RunTask's problem any more.
    expect(sent.length).toBeLessThan(8192);
  });

  it("keeps the open list to plumbing", () => {
    for (const secret of [
      "AGENTSWARMS_TOKEN",
      "KG_AUTH_TOKEN",
      "NB_INPUTS",
      "NB_ENTRYPOINT",
      "AGENTSWARMS_ORIGIN",
    ]) {
      expect(OPEN_ENV.has(secret), secret).toBe(false);
    }
  });

  it("refuses a GPU before anything is started or stored", async () => {
    const { orch, aws, staged } = orchestrator({});
    await expect(orch.create(spec({ gpus: 1 }))).rejects.toThrow(/Fargate has no GPUs/);
    expect(aws.sent).toHaveLength(0);
    expect(staged).toHaveLength(0);
  });

  it("says why ECS did not start it", async () => {
    const { orch } = orchestrator({
      RunTask: [
        {
          body: {
            tasks: [],
            failures: [
              {
                reason:
                  "Capacity is unavailable at this time. Please try again later or in a different availability zone",
              },
            ],
          },
        },
      ],
    });
    await expect(orch.create(spec())).rejects.toThrow(
      /ECS did not start the sandbox: Capacity is unavailable/,
    );
  });

  it("retries throttling with the same client token", async () => {
    const { orch, aws } = orchestrator({
      RunTask: [
        { status: 400, body: { __type: "ThrottlingException", message: "Rate exceeded" } },
        runOk,
      ],
    });
    expect(await orch.create(spec())).toEqual({ ref: ARN });
    expect(aws.sent.map((s) => s.body.clientToken)).toEqual([SID, SID]);
  });

  it("names the permission a refusal is about", async () => {
    const { orch } = orchestrator({
      RunTask: [
        {
          status: 400,
          body: {
            __type: "com.amazon.coral.service#AccessDeniedException",
            message:
              "User: arn:aws:sts::123456789012:assumed-role/app/x is not authorized to perform: ecs:RunTask",
          },
        },
      ],
    });
    await expect(orch.create(spec())).rejects.toThrow(
      /ECS RunTask was refused: .*not authorized.*The app's IAM role needs ecs:RunTask/,
    );
  });
});

describe("reading a sandbox's state", () => {
  const task = (over: Record<string, unknown>) => ({
    body: {
      tasks: [
        {
          taskArn: ARN,
          lastStatus: "RUNNING",
          desiredStatus: "RUNNING",
          containers: [
            { name: "kernel", networkInterfaces: [{ privateIpv4Address: "10.0.12.34" }] },
          ],
          ...over,
        },
      ],
      failures: [],
    },
  });

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).Authorization;
        // The kernel answers only with its own token (R466).
        if (url === "http://10.0.12.34:8888/api" && auth === "token port")
          return new Response("{}");
        return new Response("", { status: 401 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is running once the kernel answers, at the task's own address", async () => {
    const { orch } = orchestrator({ DescribeTasks: [task({})] });
    expect(await orch.status(ARN, "interactive", { token: "port" })).toEqual({
      state: "running",
      endpoint: "http://10.0.12.34:8888",
    });
  });

  it("is still starting while the kernel refuses or does not answer", async () => {
    const { orch } = orchestrator({ DescribeTasks: [task({})] });
    expect(await orch.status(ARN, "interactive", { token: "wrong" })).toEqual({
      state: "starting",
    });
  });

  it("is starting while Fargate provisions it", async () => {
    const { orch } = orchestrator({ DescribeTasks: [task({ lastStatus: "PENDING" })] });
    expect(await orch.status(ARN, "interactive")).toEqual({ state: "starting" });
  });

  it("takes the address from the ENI attachment too", async () => {
    const { orch } = orchestrator({
      DescribeTasks: [
        task({
          containers: [{ name: "kernel" }],
          attachments: [
            {
              type: "ElasticNetworkInterface",
              details: [
                { name: "subnetId", value: "subnet-aaa" },
                { name: "privateIPv4Address", value: "10.0.12.34" },
              ],
            },
          ],
        }),
      ],
    });
    expect((await orch.status(ARN, "interactive", { token: "port" })).endpoint).toBe(
      "http://10.0.12.34:8888",
    );
  });

  it("does not probe a batch job, which serves nothing", async () => {
    const { orch } = orchestrator({ DescribeTasks: [task({ containers: [{ name: "kernel" }] })] });
    expect(await orch.status(ARN, "batch")).toEqual({ state: "running" });
  });

  it("has succeeded when the job exited 0", async () => {
    const { orch } = orchestrator({
      DescribeTasks: [
        task({
          lastStatus: "STOPPED",
          desiredStatus: "STOPPED",
          stopCode: "EssentialContainerExited",
          stoppedReason: "Essential container in task exited",
          containers: [{ name: "kernel", exitCode: 0 }],
        }),
      ],
    });
    expect(await orch.status(ARN, "batch")).toEqual({ state: "succeeded", exitCode: 0 });
  });

  it("has failed, saying why, when it exited otherwise", async () => {
    const { orch } = orchestrator({
      DescribeTasks: [
        task({
          lastStatus: "STOPPED",
          desiredStatus: "STOPPED",
          stopCode: "EssentialContainerExited",
          stoppedReason: "Essential container in task exited",
          containers: [
            {
              name: "kernel",
              exitCode: 137,
              reason: "OutOfMemoryError: Container killed due to memory usage",
            },
          ],
        }),
      ],
    });
    expect(await orch.status(ARN, "batch")).toEqual({
      state: "error",
      exitCode: 137,
      message:
        "Essential container in task exited: OutOfMemoryError: Container killed due to memory usage",
    });
  });

  it("passes on a start that failed, such as an image it could not pull", async () => {
    const { orch } = orchestrator({
      DescribeTasks: [
        task({
          lastStatus: "STOPPED",
          desiredStatus: "STOPPED",
          stopCode: "TaskFailedToStart",
          stoppedReason: "CannotPullContainerError: pull image manifest has been retried 5 time(s)",
          containers: [{ name: "kernel" }],
        }),
      ],
    });
    const st = await orch.status(ARN, "interactive");
    expect(st.state).toBe("error");
    expect(st.message).toMatch(/^CannotPullContainerError/);
  });

  it("is gone when this app stopped it, whatever the kernel's exit code", async () => {
    const { orch } = orchestrator({
      DescribeTasks: [
        task({
          lastStatus: "STOPPED",
          desiredStatus: "STOPPED",
          stopCode: "UserInitiated",
          stoppedReason: "Stopped by AgentSwarms",
          containers: [{ name: "kernel", exitCode: 143 }],
        }),
      ],
    });
    expect(await orch.status(ARN, "interactive")).toEqual({ state: "gone" });
  });

  it("says so when Fargate Spot took it back", async () => {
    const { orch } = orchestrator({
      DescribeTasks: [
        task({ lastStatus: "STOPPING", desiredStatus: "STOPPED", stopCode: "SpotInterruption" }),
      ],
    });
    expect(await orch.status(ARN, "batch")).toMatchObject({
      state: "error",
      message: expect.stringMatching(/Fargate Spot took the capacity back/),
    });
  });

  it("is gone once ECS has forgotten it", async () => {
    const { orch } = orchestrator({
      DescribeTasks: [{ body: { tasks: [], failures: [{ arn: ARN, reason: "MISSING" }] } }],
    });
    expect(await orch.status(ARN, "batch")).toEqual({ state: "gone" });
  });
});

describe("stopping and logs", () => {
  it("stops the task and counts that as removed", async () => {
    const { orch, aws } = orchestrator({
      StopTask: [{ body: { task: { taskArn: ARN, desiredStatus: "STOPPED" } } }],
    });
    expect(await orch.stop(ARN)).toEqual({ removed: true });
    expect(aws.sent[0].body).toEqual({
      cluster: "agentswarms",
      task: ARN,
      reason: "Stopped by AgentSwarms",
    });
  });

  it("counts a task ECS does not know as removed", async () => {
    const { orch } = orchestrator({
      StopTask: [
        {
          status: 400,
          body: {
            __type: "InvalidParameterException",
            message: "The referenced task was not found.",
          },
        },
      ],
    });
    expect(await orch.stop(ARN)).toEqual({ removed: true });
  });

  it("says so when it could not stop it", async () => {
    const { orch } = orchestrator({
      StopTask: [
        {
          status: 400,
          body: {
            __type: "AccessDeniedException",
            message: "not authorized to perform: ecs:StopTask",
          },
        },
      ],
    });
    const r = await orch.stop(ARN);
    expect(r.removed).toBe(false);
    expect(r.error).toMatch(/ECS StopTask was refused/);
  });

  it("reads the last lines from the task's own log stream", async () => {
    const { orch, aws } = orchestrator({
      GetLogEvents: [
        { body: { events: [{ message: "one" }, { message: "two" }], nextForwardToken: "f/1" } },
      ],
    });
    expect(await orch.logs(ARN)).toBe("one\ntwo");
    expect(aws.sent[0].url).toBe("https://logs.eu-west-1.amazonaws.com/");
    expect(aws.sent[0].target).toBe("Logs_20140328.GetLogEvents");
    expect(aws.sent[0].body).toEqual({
      logGroupName: "/agentswarms/sandboxes",
      logStreamName: "nb/kernel/0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      startFromHead: false,
      limit: 2000,
    });
  });

  it("has no logs without a log group, and asks nobody", async () => {
    const { orch, aws } = orchestrator({}, { ...ecsConfigFromEnv(ENV), logGroup: null });
    expect(await orch.logs(ARN)).toBe("");
    expect(aws.sent).toHaveLength(0);
  });
});

describe("the sandbox's side", () => {
  const entry = readFileSync("docker/notebook-runtime/entrypoint.sh", "utf8");
  const dockerfile = readFileSync("docker/notebook-runtime/Dockerfile", "utf8");

  it("fetches its environment before anything else runs, and stops if it cannot", () => {
    const boot = entry.indexOf('if [ -n "${NB_BOOTSTRAP_URL:-}" ]');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(entry.indexOf("batch_runner.py"));
    expect(entry).toContain('boot="$(python -I /opt/agentswarms/bootstrap.py)" || exit 1');
    expect(entry).toContain("unset boot NB_BOOTSTRAP_NONCE NB_BOOTSTRAP_URL");
    expect(dockerfile).toContain("COPY bootstrap.py /opt/agentswarms/bootstrap.py");
  });
});
