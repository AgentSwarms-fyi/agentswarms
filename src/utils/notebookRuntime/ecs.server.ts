// Amazon ECS backend for the notebook runtime: one Fargate task per sandbox.
//
// For deployments on AWS (ECS on EC2, or a VM behind a load balancer). The
// app's own containers may share EC2 hosts, so a sandbox must not: an ECS task
// on a shared host can read its neighbours' credentials ("ECScape", AWS
// advises Fargate for untrusted code). Each sandbox is a Fargate microVM.
//
// No SDK: the ECS and CloudWatch Logs JSON APIs, signed with SigV4, with
// credentials from the app's own identity (utils/aws/credentials.server).
//
// The task definition is the infrastructure's (deploy/aws registers it): the
// image, the read-only root filesystem, the scratch volumes, the log group, no
// task role, and the subnets that route only to the egress proxy and the app.
// RunTask may override environment, CPU and memory, not the image, so on this
// backend the image is the task definition's and the runtime settings' image
// is not used.
//
// SECRETS DO NOT GO IN THE OVERRIDES. RunTask's request is written to
// CloudTrail and handed back by DescribeTasks to anyone allowed to call it, so
// the session token and the sandbox's port token would land in both. The
// overrides carry a one-time nonce instead (bootstrap.server.ts): the sandbox
// trades it at the app for its environment, once, on start. That also keeps
// a large batch input under RunTask's 8 KB override limit.
import { randomBytes } from "node:crypto";

import { createAwsCredentialChain, type AwsCredentialChain } from "@/utils/aws/credentials.server";
import { signAwsRequest } from "@/utils/aws/sigv4";
import { cloudRegion } from "@/utils/providers/cloudRegion";
import { BOOTSTRAP_PATH, stageBootstrap } from "./bootstrap.server";
import type {
  KernelKind,
  KernelSpec,
  KernelStatus,
  NotebookOrchestrator,
  TeardownResult,
} from "./orchestrator";
import { sandboxName, sandboxServing, type SandboxAuth } from "./orchestrator";

type Env = Record<string, string | undefined>;

export type EcsSandboxConfig = {
  region: string;
  cluster: string;
  /** Family, family:revision or ARN, per kind of sandbox. */
  taskDefinition: Record<KernelKind, string>;
  /** Capacity provider per kind: FARGATE, or FARGATE_SPOT for batch. */
  capacityProvider: Record<KernelKind, string>;
  subnets: string[];
  securityGroups: string[];
  /** The container in the task definition that runs the sandbox. */
  container: string;
  /** awslogs group and stream prefix the task definition writes to. */
  logGroup: string | null;
  logStreamPrefix: string;
  ecsEndpoint: string;
  logsEndpoint: string;
};

export class EcsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EcsConfigError";
  }
}

const REQUIRED = [
  "NOTEBOOK_ECS_CLUSTER",
  "NOTEBOOK_ECS_TASK_DEFINITION",
  "NOTEBOOK_ECS_SUBNETS",
  "NOTEBOOK_ECS_SECURITY_GROUPS",
] as const;

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function domainOf(region: string): string {
  return region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
}

function origin(raw: string, name: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new EcsConfigError(`${name} "${raw}" is not a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new EcsConfigError(`${name} must be an http(s) URL, not ${u.protocol}`);
  }
  return u.origin;
}

function endpointFor(service: "ecs" | "logs", region: string, env: Env): string {
  const own = (env[`AWS_ENDPOINT_URL_${service.toUpperCase()}`] ?? "").trim();
  if (own) return origin(own, `AWS_ENDPOINT_URL_${service.toUpperCase()}`);
  const any = (env.AWS_ENDPOINT_URL ?? "").trim();
  if (any) return origin(any, "AWS_ENDPOINT_URL");
  const fips = /^(1|true|yes|on)$/i.test((env.AWS_USE_FIPS_ENDPOINT ?? "").trim());
  return `https://${service}${fips ? "-fips" : ""}.${region}.${domainOf(region)}`;
}

/** Read the ECS settings the infrastructure sets. Throws an EcsConfigError naming what is missing. */
export function ecsConfigFromEnv(env: Env = process.env): EcsSandboxConfig {
  const missing = REQUIRED.filter((k) => !(env[k] ?? "").trim());
  const rawRegion = (env.AWS_REGION ?? "").trim() || (env.AWS_DEFAULT_REGION ?? "").trim();
  if (!rawRegion) missing.push("AWS_REGION" as (typeof REQUIRED)[number]);
  if (missing.length) {
    throw new EcsConfigError(
      `The ECS sandbox backend is not configured: set ${missing.join(", ")}. ` +
        `deploy/aws sets them; see docs/DEVELOPER_WORKSPACE_RUNTIME.md.`,
    );
  }
  let region: string;
  try {
    region = cloudRegion(rawRegion, "The ECS region");
  } catch (e) {
    throw new EcsConfigError((e as Error).message);
  }
  const td = (env.NOTEBOOK_ECS_TASK_DEFINITION ?? "").trim();
  const cp = (env.NOTEBOOK_ECS_CAPACITY_PROVIDER ?? "").trim() || "FARGATE";
  const subnets = list(env.NOTEBOOK_ECS_SUBNETS);
  const securityGroups = list(env.NOTEBOOK_ECS_SECURITY_GROUPS);
  // RunTask takes at most 16 of each.
  if (subnets.length > 16 || securityGroups.length > 5) {
    throw new EcsConfigError(
      "RunTask takes at most 16 subnets and 5 security groups: NOTEBOOK_ECS_SUBNETS or NOTEBOOK_ECS_SECURITY_GROUPS lists more",
    );
  }
  return {
    region,
    cluster: (env.NOTEBOOK_ECS_CLUSTER ?? "").trim(),
    taskDefinition: {
      interactive: td,
      batch: (env.NOTEBOOK_ECS_TASK_DEFINITION_BATCH ?? "").trim() || td,
      service: (env.NOTEBOOK_ECS_TASK_DEFINITION_SERVICE ?? "").trim() || td,
    },
    capacityProvider: {
      interactive: cp,
      service: cp,
      batch: (env.NOTEBOOK_ECS_BATCH_CAPACITY_PROVIDER ?? "").trim() || cp,
    },
    subnets,
    securityGroups,
    container: (env.NOTEBOOK_ECS_CONTAINER ?? "").trim() || "kernel",
    logGroup: (env.NOTEBOOK_ECS_LOG_GROUP ?? "").trim() || null,
    logStreamPrefix: (env.NOTEBOOK_ECS_LOG_STREAM_PREFIX ?? "").trim() || "nb",
    ecsEndpoint: endpointFor("ecs", region, env),
    logsEndpoint: endpointFor("logs", region, env),
  };
}

// ── Fargate sizes ────────────────────────────────────────────────────────────

/**
 * Fargate runs only fixed CPU/memory pairs. Each CPU size, in CPU units
 * (1024 = 1 vCPU), with its memory range and step in MiB (AWS, "Fargate task
 * definition considerations", read 2026-11-13).
 */
export const FARGATE_SIZES: readonly { cpu: number; min: number; max: number; step: number }[] = [
  { cpu: 256, min: 512, max: 2048, step: 512 },
  { cpu: 512, min: 1024, max: 4096, step: 1024 },
  { cpu: 1024, min: 2048, max: 8192, step: 1024 },
  { cpu: 2048, min: 4096, max: 16384, step: 1024 },
  { cpu: 4096, min: 8192, max: 30720, step: 1024 },
  { cpu: 8192, min: 16384, max: 61440, step: 4096 },
  { cpu: 16384, min: 32768, max: 122880, step: 8192 },
];

/** "2", "1.5", "500m" → vCPUs. */
export function parseCpu(limit: string): number {
  const s = limit.trim();
  const n = s.endsWith("m") ? Number(s.slice(0, -1)) / 1000 : Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new EcsConfigError(`"${limit}" is not a CPU limit`);
  return n;
}

/**
 * The smallest Fargate size with at least the CPU and memory asked for.
 * 256 units with 512 MiB is the smallest there is; a request above 16 vCPU
 * or 120 GiB is refused, saying so.
 */
export function fargateSize(cpuLimit: string, memMb: number): { cpu: string; memory: string } {
  const units = Math.ceil(parseCpu(cpuLimit) * 1024);
  const mem = Math.max(1, Math.ceil(memMb));
  for (const size of FARGATE_SIZES) {
    if (size.cpu < units || size.max < mem) continue;
    const memory = Math.max(size.min, Math.ceil(mem / size.step) * size.step);
    return { cpu: String(size.cpu), memory: String(memory) };
  }
  throw new EcsConfigError(
    `No Fargate size has ${cpuLimit} vCPU and ${memMb} MB: the largest is 16 vCPU with 120 GB. ` +
      `Lower the sandbox's CPU or memory in Admin → Developer runtime.`,
  );
}

// ── The two APIs ─────────────────────────────────────────────────────────────

const TARGET = {
  ecs: "AmazonEC2ContainerServiceV20141113",
  logs: "Logs_20140328",
} as const;

export class AwsApiError extends Error {
  constructor(
    message: string,
    readonly type: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AwsApiError";
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type EcsDeps = {
  fetch?: Fetch;
  credentials?: AwsCredentialChain;
  now?: () => Date;
  /** Where the bootstrap environment is kept; the database, but for tests. */
  stage?: typeof stageBootstrap;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
};

const chains = new Map<string, AwsCredentialChain>();
function chainFor(region: string): AwsCredentialChain {
  let c = chains.get(region);
  if (!c) chains.set(region, (c = createAwsCredentialChain({ region })));
  return c;
}

/** The error's type, without the namespace ECS and Logs put before '#'. */
function errorType(body: { __type?: string }): string {
  const t = body.__type ?? "";
  return t.slice(t.lastIndexOf("#") + 1) || "UnknownError";
}

const RETRYABLE = new Set([
  "ThrottlingException",
  "ServerException",
  "ServiceUnavailableException",
]);

/** Who to tell about a refusal: the role, not the sandbox. */
function explain(service: "ecs" | "logs", action: string, type: string, message: string): string {
  const what = `${service === "ecs" ? "ECS" : "CloudWatch Logs"} ${action}`;
  if (type === "AccessDeniedException") {
    return `${what} was refused: ${message}. The app's IAM role needs ${service}:${action}; deploy/aws grants it.`;
  }
  return `${what} failed (${type}): ${message}`;
}

export function createEcsOrchestrator(cfg: EcsSandboxConfig, deps: EcsDeps = {}) {
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const creds = deps.credentials ?? chainFor(cfg.region);
  const stage = deps.stage ?? stageBootstrap;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function call<T>(service: "ecs" | "logs", action: string, body: object): Promise<T> {
    const url = `${service === "ecs" ? cfg.ecsEndpoint : cfg.logsEndpoint}/`;
    const payload = JSON.stringify(body);
    // Three tries for throttling and 5xx: RunTask carries a client token, so
    // a repeat after a lost answer starts no second sandbox.
    for (let attempt = 1; ; attempt++) {
      const headers = await signAwsRequest({
        service,
        region: cfg.region,
        credentials: await creds.get(),
        method: "POST",
        url,
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `${TARGET[service]}.${action}`,
        },
        body: payload,
        now: deps.now?.(),
      });
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers,
          body: payload,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        if (attempt < 3) {
          await sleep(attempt * 500);
          continue;
        }
        throw new AwsApiError(
          `${service === "ecs" ? "ECS" : "CloudWatch Logs"} at ${url} could not be reached: ${(e as Error).message}`,
          "NetworkError",
          0,
        );
      }
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        /* not JSON: reported below by status */
      }
      if (res.ok) return parsed as T;
      const type = errorType(parsed as { __type?: string });
      if ((RETRYABLE.has(type) || res.status >= 500) && attempt < 3) {
        await sleep(attempt * 500);
        continue;
      }
      const message =
        (parsed.message as string | undefined) ??
        (parsed.Message as string | undefined) ??
        `HTTP ${res.status}`;
      throw new AwsApiError(explain(service, action, type, message), type, res.status);
    }
  }

  return new EcsOrchestrator(cfg, call, stage);
}

type Call = <T>(service: "ecs" | "logs", action: string, body: object) => Promise<T>;

type EcsTask = {
  taskArn?: string;
  lastStatus?: string;
  desiredStatus?: string;
  stopCode?: string;
  stoppedReason?: string;
  containers?: {
    name?: string;
    exitCode?: number;
    reason?: string;
    networkInterfaces?: { privateIpv4Address?: string }[];
  }[];
  attachments?: { type?: string; details?: { name?: string; value?: string }[] }[];
};
type Failure = { arn?: string; reason?: string; detail?: string };

/**
 * What the sandbox may be told in the open. Everything else, the session and
 * port tokens above all and anything added later, goes through the bootstrap:
 * a new variable is secret until someone moves it here.
 */
export const OPEN_ENV = new Set([
  "NB_MODE",
  "NB_SESSION_ID",
  "KG_IP",
  "KG_PORT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
]);

/** RunTask refuses overrides over 8192 characters. */
export const RUNTASK_OVERRIDE_LIMIT = 8192;

const STOPPING = new Set(["DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED"]);

export class EcsOrchestrator implements NotebookOrchestrator {
  constructor(
    private readonly cfg: EcsSandboxConfig,
    private readonly call: Call,
    private readonly stage: typeof stageBootstrap,
  ) {}

  async create(spec: KernelSpec): Promise<{ ref: string }> {
    if (spec.gpus && spec.gpus > 0) {
      throw new Error(
        "Fargate has no GPUs. Run GPU training on the Kubernetes backend (EKS), or set training GPUs to 0 in Admin → Developer runtime.",
      );
    }
    const origin = spec.env.AGENTSWARMS_ORIGIN;
    if (!origin) throw new Error("The sandbox has no app URL to fetch its environment from");
    const nonce = randomBytes(32).toString("base64url");
    await this.stage(spec.sessionId, spec.userId, spec.env, nonce);

    const open = Object.entries(spec.env).filter(([k]) => OPEN_ENV.has(k));
    const environment = [
      ...open,
      ["NB_BOOTSTRAP_URL", `${origin.replace(/\/+$/, "")}${BOOTSTRAP_PATH}`],
      ["NB_BOOTSTRAP_NONCE", nonce],
    ].map(([name, value]) => ({ name, value }));
    const size = fargateSize(spec.cpuLimit, spec.memLimitMb);
    const overrides = {
      cpu: size.cpu,
      memory: size.memory,
      containerOverrides: [{ name: this.cfg.container, environment }],
    };
    const length = JSON.stringify(overrides).length;
    if (length > RUNTASK_OVERRIDE_LIMIT) {
      throw new Error(
        `The sandbox's overrides are ${length} characters, over RunTask's ${RUNTASK_OVERRIDE_LIMIT}`,
      );
    }

    const res = await this.call<{ tasks?: EcsTask[]; failures?: Failure[] }>("ecs", "RunTask", {
      cluster: this.cfg.cluster,
      taskDefinition: this.cfg.taskDefinition[spec.kind],
      count: 1,
      // The same session never starts two sandboxes, whatever is retried.
      clientToken: spec.sessionId,
      startedBy: sandboxName(spec.sessionId),
      capacityProviderStrategy: [
        { capacityProvider: this.cfg.capacityProvider[spec.kind], weight: 1 },
      ],
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.cfg.subnets,
          securityGroups: this.cfg.securityGroups,
          assignPublicIp: "DISABLED",
        },
      },
      overrides,
      enableECSManagedTags: true,
      propagateTags: "TASK_DEFINITION",
      tags: [
        { key: "agentswarms:session", value: spec.sessionId },
        { key: "agentswarms:kind", value: spec.kind },
      ],
    });
    const arn = res.tasks?.[0]?.taskArn;
    if (!arn) {
      const f = res.failures?.[0];
      throw new Error(
        `ECS did not start the sandbox: ${f?.reason ?? "no task and no reason given"}${f?.detail ? ` (${f.detail})` : ""}`,
      );
    }
    return { ref: arn };
  }

  private async describe(ref: string): Promise<{ task?: EcsTask; missing: boolean }> {
    const res = await this.call<{ tasks?: EcsTask[]; failures?: Failure[] }>(
      "ecs",
      "DescribeTasks",
      { cluster: this.cfg.cluster, tasks: [ref] },
    );
    const task = res.tasks?.find((t) => t.taskArn === ref) ?? res.tasks?.[0];
    return { task, missing: !task && (res.failures ?? []).some((f) => f.reason === "MISSING") };
  }

  async status(
    ref: string,
    kind: KernelKind = "interactive",
    auth?: SandboxAuth,
  ): Promise<KernelStatus> {
    let found: { task?: EcsTask; missing: boolean };
    try {
      found = await this.describe(ref);
    } catch (e) {
      return { state: "error", message: (e as Error).message };
    }
    // ECS forgets a stopped task about an hour after it stops.
    if (found.missing) return { state: "gone" };
    const task = found.task;
    if (!task) return { state: "error", message: "ECS answered DescribeTasks with no task" };

    const c = task.containers?.find((x) => x.name === this.cfg.container) ?? task.containers?.[0];
    if (STOPPING.has(task.lastStatus ?? "") || task.desiredStatus === "STOPPED") {
      if (c?.exitCode === 0) return { state: "succeeded", exitCode: 0 };
      // StopTask: this app (or someone in the console) took it down. The
      // kernel's SIGTERM exit code says nothing about the sandbox.
      if (task.stopCode === "UserInitiated") return { state: "gone" };
      if (task.stopCode === "SpotInterruption") {
        return {
          state: "error",
          message: "Fargate Spot took the capacity back; the sandbox was stopped",
        };
      }
      const why = [task.stoppedReason, c?.reason].filter(Boolean).join(": ");
      const exited = c?.exitCode !== undefined && c.exitCode !== null;
      return {
        state: "error",
        ...(exited ? { exitCode: c.exitCode } : {}),
        message:
          why ||
          (exited
            ? `The sandbox exited with ${c.exitCode}`
            : `The sandbox is stopping (${task.lastStatus ?? "no status"})`),
      };
    }
    if (task.lastStatus !== "RUNNING") return { state: "starting" };
    // A batch job serves nothing: running is running.
    if (kind === "batch") return { state: "running" };
    const ip =
      c?.networkInterfaces?.find((n) => n.privateIpv4Address)?.privateIpv4Address ??
      task.attachments?.flatMap((a) => a.details ?? []).find((d) => d.name === "privateIPv4Address")
        ?.value;
    if (!ip) return { state: "starting" };
    const endpoint = `http://${ip}:8888`;
    // Task RUNNING != process serving; wait for it to answer on its own path.
    if (!(await sandboxServing(endpoint, kind, auth))) return { state: "starting" };
    return { state: "running", endpoint };
  }

  async stop(ref: string): Promise<TeardownResult> {
    try {
      await this.call("ecs", "StopTask", {
        cluster: this.cfg.cluster,
        task: ref,
        reason: "Stopped by AgentSwarms",
      });
      return { removed: true };
    } catch (e) {
      // A task ECS no longer knows is gone, which is what was asked for.
      if (
        e instanceof AwsApiError &&
        e.type === "InvalidParameterException" &&
        /not found/i.test(e.message)
      ) {
        return { removed: true };
      }
      return { removed: false, error: (e as Error).message };
    }
  }

  async logs(ref: string): Promise<string> {
    if (!this.cfg.logGroup) return "";
    const taskId = ref.slice(ref.lastIndexOf("/") + 1);
    try {
      const res = await this.call<{ events?: { message?: string }[] }>("logs", "GetLogEvents", {
        logGroupName: this.cfg.logGroup,
        logStreamName: `${this.cfg.logStreamPrefix}/${this.cfg.container}/${taskId}`,
        // The last 2000 lines, oldest first, as the k8s backend reads them.
        startFromHead: false,
        limit: 2000,
      });
      return (res.events ?? []).map((e) => e.message ?? "").join("\n");
    } catch {
      return "";
    }
  }

  /** For the admin check: can this role see the cluster? */
  async describeCluster(): Promise<{ status: string; running: number }> {
    const res = await this.call<{
      clusters?: { status?: string; runningTasksCount?: number }[];
      failures?: Failure[];
    }>("ecs", "DescribeClusters", { clusters: [this.cfg.cluster] });
    const c = res.clusters?.[0];
    if (!c) {
      throw new Error(
        `ECS has no cluster ${this.cfg.cluster} in ${this.cfg.region}: ${res.failures?.[0]?.reason ?? "not found"}`,
      );
    }
    return { status: c.status ?? "UNKNOWN", running: c.runningTasksCount ?? 0 };
  }
}

/** The orchestrator getOrchestrator returns for backend "ecs". */
export function ecsOrchestratorFromEnv(): EcsOrchestrator {
  return createEcsOrchestrator(ecsConfigFromEnv());
}
