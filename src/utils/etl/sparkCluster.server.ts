// Where a Spark-engine run's cluster comes from.
//
// Two providers, chosen once per deployment (Admin → Developer runtime, or
// SPARK_PROVIDER):
//
//   static — an endpoint somebody else runs: the Compose `spark` profile on a
//            laptop, a standalone cluster, a managed service that speaks Spark
//            Connect. The platform does not manage its lifecycle; every run
//            shares it. This is the default, and the only one that works when
//            the app is not itself in Kubernetes.
//
//   k8s    — one cluster PER RUN, created here: a driver pod that serves Spark
//            Connect, plus the executor pods it asks the cluster for. The run
//            gets the whole cluster to itself, sized from settings, and it is
//            torn down when the run ends. This is the cloud path: capacity is
//            the node pool, not one box.
//
// Three things make per-run clusters safe to hand a scheduler:
//
//   1. Executors are OWNED by the driver pod (spark.kubernetes.driver.pod.name),
//      so deleting the driver garbage-collects them — there is no second thing
//      to remember to delete.
//   2. The driver pod carries activeDeadlineSeconds. If this process dies
//      between creating a cluster and recording it, the kubelet still ends it.
//   3. Every object is labelled with the run id, so `reapOrphanedSparkClusters`
//      can find and delete a cluster whose run is over even when nothing in the
//      database points at it.
//
// The run row (etl_runs.spark_cluster_ref / spark_connect_url) is what any app
// REPLICA reads to tear a cluster down — the replica that finalises a run is
// rarely the one that started it.
import { connect } from "node:net";

import { k8sFetch } from "@/utils/notebookRuntime/k8s.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type SparkProvider = "static" | "k8s";

/** The Spark Connect port every driver serves on. */
const CONNECT_PORT = 15002;
/** Driver RPC + block manager, so executors can call back to the driver. */
const DRIVER_PORT = 7078;
const BLOCK_MANAGER_PORT = 7079;

/**
 * The connectors a pipeline can need, resolved by the driver at startup.
 *
 * An operator whose image already carries these jars sets SPARK_PACKAGES to an
 * empty string and skips the resolution — worth doing, because it is the
 * slowest part of starting a per-run cluster.
 */
const DEFAULT_PACKAGES =
  "org.apache.hadoop:hadoop-aws:3.5.0,io.delta:delta-spark_2.13:4.4.0," +
  "org.postgresql:postgresql:42.7.13,com.mysql:mysql-connector-j:9.7.0";

const DEFAULT_IMAGE = "apache/spark:4.2.0-python3";

function envInt(name: string): number | undefined {
  const n = Number(process.env[name]?.trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

function positive(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined;
}

export type SparkClusterSettings = {
  provider: SparkProvider;
  /** static only: the endpoint every run shares. */
  staticUrl: string | null;
  image: string;
  executors: number;
  executorCores: number;
  executorMemMb: number;
  driverMemMb: number;
};

/**
 * Provider and sizing: the settings row wins, then the environment, then the
 * default — the same order every other compute knob on this platform uses.
 */
export async function sparkClusterSettings(): Promise<SparkClusterSettings> {
  const { data } = await supabaseAdmin
    .from("notebook_runtime_settings")
    .select(
      "spark_provider, spark_connect_url, spark_image, spark_executors, spark_executor_cores, spark_executor_mem_mb, spark_driver_mem_mb",
    )
    .eq("id", true)
    .maybeSingle();

  const raw = (data?.spark_provider ?? process.env.SPARK_PROVIDER ?? "static").trim();
  const provider: SparkProvider = raw === "k8s" ? "k8s" : "static";
  return {
    provider,
    staticUrl: data?.spark_connect_url?.trim() || process.env.SPARK_CONNECT_URL?.trim() || null,
    image: data?.spark_image?.trim() || process.env.SPARK_IMAGE?.trim() || DEFAULT_IMAGE,
    executors: positive(data?.spark_executors) ?? envInt("SPARK_EXECUTORS") ?? 2,
    executorCores: positive(data?.spark_executor_cores) ?? envInt("SPARK_EXECUTOR_CORES") ?? 1,
    executorMemMb: positive(data?.spark_executor_mem_mb) ?? envInt("SPARK_EXECUTOR_MEM_MB") ?? 2048,
    driverMemMb: positive(data?.spark_driver_mem_mb) ?? envInt("SPARK_DRIVER_MEM_MB") ?? 2048,
  };
}

/**
 * Is this process running inside a Kubernetes pod?
 *
 * The API server injects these into every container it starts. Without them
 * there is no ServiceAccount to create pods with, so the `k8s` provider cannot
 * work however it is configured.
 */
export function inCluster(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST);
}

/**
 * Can a pipeline choose the Spark engine on this instance at all?
 *
 * `static` needs an endpoint to have been configured. `k8s` needs no endpoint —
 * the cluster is created when a run needs one — but it does need the app to be
 * in a cluster: an operator who selects it on a Docker host would otherwise get
 * an engine the picker offers and every run fails on.
 */
export async function sparkEngineAvailability(): Promise<{
  configured: boolean;
  provider: SparkProvider;
  host: string | null;
}> {
  const s = await sparkClusterSettings();
  if (s.provider === "k8s") return { configured: inCluster(), provider: "k8s", host: null };
  let host: string | null = null;
  if (s.staticUrl) {
    try {
      host = new URL(s.staticUrl.replace(/^sc:\/\//i, "http://")).host;
    } catch {
      host = null;
    }
  }
  return { configured: Boolean(s.staticUrl), provider: "static", host };
}

// ── Kubernetes per-run clusters ─────────────────────────────────────────────

/**
 * Spark pods live in their own namespace, not the kernels' one.
 *
 * Not tidiness: a kernel is under a default-deny NetworkPolicy whose only way
 * out is the HTTP egress proxy, and a Spark driver has to reach object storage
 * and databases directly. Separate namespaces let each have the policy and the
 * resource quota it actually needs.
 */
function sparkNamespace(): string {
  return process.env.SPARK_K8S_NAMESPACE?.trim() || "agentswarms-spark";
}

/** A name that is derivable from the run id, so a leak is always findable. */
function clusterName(runId: string): string {
  return `spark-${runId.replace(/-/g, "").slice(0, 20)}`;
}

function jsonEnv<T>(name: string): T | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[spark-k8s] ${name} is not valid JSON; ignoring it`);
    return undefined;
  }
}

function labelsFor(runId: string, userId: string) {
  return {
    "app.kubernetes.io/managed-by": "agentswarms",
    "app.kubernetes.io/component": "spark-driver",
    "agentswarms.spark/run": runId,
    "agentswarms.spark/user": userId,
  };
}

/**
 * Is something listening on the Spark Connect port yet?
 *
 * A TCP connect, not a gRPC call: the driver opens the port only once the
 * session is up, which is exactly the transition worth waiting for, and a
 * connect needs no protocol knowledge in the app.
 */
function portOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: timeoutMs });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function driverArgs(s: SparkClusterSettings, name: string, ns: string): string[] {
  const sa = process.env.SPARK_K8S_SERVICE_ACCOUNT?.trim() || "spark-driver";
  const packages = process.env.SPARK_PACKAGES?.trim() ?? DEFAULT_PACKAGES;
  const podTemplate = process.env.SPARK_K8S_EXECUTOR_POD_TEMPLATE?.trim();
  const conf = [
    // Client mode: this pod IS the driver, and it also serves Spark Connect.
    `spark.master=k8s://https://kubernetes.default.svc:443`,
    `spark.submit.deployMode=client`,
    `spark.kubernetes.container.image=${s.image}`,
    `spark.kubernetes.namespace=${ns}`,
    `spark.kubernetes.authenticate.driver.serviceAccountName=${sa}`,
    // Executors are owned by this pod, so deleting it deletes them.
    `spark.kubernetes.driver.pod.name=${name}`,
    `spark.kubernetes.executor.podNamePrefix=${name}`,
    `spark.kubernetes.executor.deleteOnTermination=true`,
    // Executors dial the driver back through its headless Service.
    `spark.driver.host=${name}.${ns}.svc.cluster.local`,
    `spark.driver.bindAddress=0.0.0.0`,
    `spark.driver.port=${DRIVER_PORT}`,
    `spark.blockManager.port=${BLOCK_MANAGER_PORT}`,
    `spark.driver.memory=${s.driverMemMb}m`,
    `spark.executor.instances=${s.executors}`,
    `spark.executor.cores=${s.executorCores}`,
    `spark.executor.memory=${s.executorMemMb}m`,
    `spark.jars.ivy=/tmp/ivy`,
    // Delta, so a Delta target and its MERGE work the way they do on the
    // Compose profile. Harmless when no pipeline writes Delta.
    `spark.sql.extensions=io.delta.sql.DeltaSparkSessionExtension`,
    `spark.sql.catalog.spark_catalog=org.apache.spark.sql.delta.catalog.DeltaCatalog`,
    `spark.connect.grpc.binding.port=${CONNECT_PORT}`,
    ...(podTemplate ? [`spark.kubernetes.executor.podTemplateFile=${podTemplate}`] : []),
    ...(process.env.SPARK_K8S_EXTRA_CONF ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  ];
  return [
    "/opt/spark/sbin/start-connect-server.sh",
    ...(packages ? ["--packages", packages] : []),
    ...conf.flatMap((c) => ["--conf", c]),
  ];
}

function driverPod(
  s: SparkClusterSettings,
  name: string,
  ns: string,
  runId: string,
  userId: string,
  deadlineSeconds: number,
) {
  const runAsUser = envInt("SPARK_K8S_RUN_AS_USER") ?? 185; // the apache/spark image's user
  // Driver JVM heap + the off-heap the JVM and Python take beside it. Spark's
  // own overhead default is 10%, which is too thin for a pod limit that the
  // kubelet enforces by killing.
  const memLimitMb = Math.round(s.driverMemMb * 1.4) + 512;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: ns, labels: labelsFor(runId, userId) },
    spec: {
      restartPolicy: "Never",
      // The driver talks to the API server to ask for executors, so unlike a
      // kernel it does need its token.
      serviceAccountName: process.env.SPARK_K8S_SERVICE_ACCOUNT?.trim() || "spark-driver",
      automountServiceAccountToken: true,
      // Even if this process never gets to delete the cluster, the kubelet does.
      activeDeadlineSeconds: deadlineSeconds,
      ...(jsonEnv<Record<string, string>>("SPARK_K8S_NODE_SELECTOR")
        ? { nodeSelector: jsonEnv<Record<string, string>>("SPARK_K8S_NODE_SELECTOR") }
        : {}),
      ...(jsonEnv<unknown[]>("SPARK_K8S_TOLERATIONS")
        ? { tolerations: jsonEnv<unknown[]>("SPARK_K8S_TOLERATIONS") }
        : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser,
        runAsGroup: runAsUser,
        fsGroup: runAsUser,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "spark-driver",
          image: s.image,
          imagePullPolicy: process.env.SPARK_K8S_PULL_POLICY || "IfNotPresent",
          command: driverArgs(s, name, ns),
          env: [
            { name: "SPARK_NO_DAEMONIZE", value: "true" },
            // The launcher writes a log and a pid file; both must land where a
            // read-only root filesystem still allows writing.
            { name: "SPARK_LOG_DIR", value: "/tmp/spark-logs" },
            { name: "SPARK_PID_DIR", value: "/tmp" },
            { name: "HOME", value: "/tmp" },
          ],
          ports: [
            { name: "connect", containerPort: CONNECT_PORT },
            { name: "driver-rpc", containerPort: DRIVER_PORT },
            { name: "blockmanager", containerPort: BLOCK_MANAGER_PORT },
          ],
          resources: {
            requests: {
              cpu: process.env.SPARK_K8S_DRIVER_CPU_REQUEST || "500m",
              memory: `${s.driverMemMb}Mi`,
            },
            limits: {
              cpu: process.env.SPARK_K8S_DRIVER_CPU_LIMIT || "2",
              memory: `${memLimitMb}Mi`,
            },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
        },
      ],
      volumes: [
        {
          name: "tmp",
          emptyDir: { sizeLimit: process.env.SPARK_K8S_DRIVER_SCRATCH || "8Gi" },
        },
      ],
    },
  };
}

/**
 * Headless on purpose: executors and the sandbox both resolve the name
 * straight to the driver's pod IP, which is what spark.driver.host must be.
 */
function driverService(name: string, ns: string, runId: string, userId: string) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: ns, labels: labelsFor(runId, userId) },
    spec: {
      clusterIP: "None",
      selector: { "agentswarms.spark/run": runId },
      ports: [
        { name: "connect", port: CONNECT_PORT, targetPort: CONNECT_PORT },
        { name: "driver-rpc", port: DRIVER_PORT, targetPort: DRIVER_PORT },
        { name: "blockmanager", port: BLOCK_MANAGER_PORT, targetPort: BLOCK_MANAGER_PORT },
      ],
    },
  };
}

/**
 * Everything Kubernetes needs for one run's cluster, as plain objects.
 *
 * Separated from the calls that post them so the shape can be asserted in a
 * test: which conf makes executors the driver's children, that the pod carries
 * a deadline, and that it runs unprivileged are the properties that keep a
 * per-run cluster from leaking or over-reaching, and they are worth pinning.
 */
export function sparkDriverManifests(
  s: SparkClusterSettings,
  opts: { runId: string; userId: string; timeoutMinutes: number },
): { pod: unknown; service: unknown; url: string; ref: string; name: string; namespace: string } {
  const ns = sparkNamespace();
  const name = clusterName(opts.runId);
  // Slack over the run's own ceiling: the pod must outlive the run it serves,
  // and only act as a backstop when nothing tore it down.
  const deadline =
    Math.max(600, Math.round(opts.timeoutMinutes * 60) + 300) + sparkStartupSeconds();
  return {
    pod: driverPod(s, name, ns, opts.runId, opts.userId, deadline),
    service: driverService(name, ns, opts.runId, opts.userId),
    url: `sc://${name}.${ns}.svc.cluster.local:${CONNECT_PORT}`,
    ref: `${ns}/${name}`,
    name,
    namespace: ns,
  };
}

/** Delete a cluster's Pod and Service; never throws. */
async function deleteCluster(name: string, ns: string): Promise<void> {
  await k8sFetch(`/api/v1/namespaces/${ns}/pods/${name}?gracePeriodSeconds=5`, {
    method: "DELETE",
  }).catch(() => {});
  await k8sFetch(`/api/v1/namespaces/${ns}/services/${name}`, { method: "DELETE" }).catch(() => {});
}

/** How long a per-run driver may take to answer before the run gives up. */
export function sparkStartupSeconds(): number {
  return envInt("SPARK_K8S_STARTUP_TIMEOUT_SECONDS") ?? 420;
}

/**
 * A cluster for one run — created, not yet ready.
 *
 * Under `static` this only reports the shared endpoint; there is nothing to
 * create. Under `k8s` it creates the driver and its Service and RETURNS, so
 * the caller can record the reference before the slow part begins: a cluster
 * that exists but is not written down anywhere is the one way this leaks.
 * Wait for it with `awaitSparkClusterReady`.
 */
export async function acquireSparkCluster(opts: {
  runId: string;
  userId: string;
  /** Wall-clock ceiling for the run, so the pod cannot outlive it. */
  timeoutMinutes: number;
}): Promise<{ url: string; ref: string | null }> {
  const s = await sparkClusterSettings();
  if (s.provider === "static") {
    if (!s.staticUrl) {
      throw new Error(
        "This pipeline uses the Spark engine, but no Spark Connect endpoint is configured (Admin → Developer runtime → Spark engine).",
      );
    }
    return { url: s.staticUrl, ref: null };
  }
  if (!inCluster()) {
    throw new Error(
      "The Spark engine is set to create a cluster per run on Kubernetes, but this app is not running in a cluster. " +
        "Point it at an endpoint instead (Admin → Developer runtime → Spark engine → “An endpoint you run”).",
    );
  }

  const m = sparkDriverManifests(s, opts);
  // The Service first: executors resolve the driver by its name, so it must
  // already exist when the driver starts advertising itself under it.
  const svc = await k8sFetch(`/api/v1/namespaces/${m.namespace}/services`, {
    method: "POST",
    body: JSON.stringify(m.service),
  });
  if (!svc.ok && svc.status !== 409) {
    throw new Error(
      `Spark driver service could not be created (${svc.status}): ${await svc.text()}`,
    );
  }
  const pod = await k8sFetch(`/api/v1/namespaces/${m.namespace}/pods`, {
    method: "POST",
    body: JSON.stringify(m.pod),
  });
  if (!pod.ok && pod.status !== 409) {
    const body = await pod.text();
    await deleteCluster(m.name, m.namespace);
    throw new Error(`Spark driver could not be created (${pod.status}): ${body}`);
  }
  return { url: m.url, ref: m.ref };
}

/**
 * Wait until the run's driver answers on the Connect port.
 *
 * Handing the sandbox an endpoint that is not listening yet only moves the
 * failure into the pipeline's own logs, where it reads as the pipeline's
 * fault. On any failure the cluster is deleted before this throws.
 */
export async function awaitSparkClusterReady(ref: string | null | undefined): Promise<void> {
  if (!ref) return;
  const [ns, name] = ref.split("/");
  if (!ns || !name) return;
  const startupSeconds = sparkStartupSeconds();
  const until = Date.now() + startupSeconds * 1000;
  let lastPhase = "Pending";
  while (Date.now() < until) {
    const res = await k8sFetch(`/api/v1/namespaces/${ns}/pods/${name}`).catch(() => null);
    if (res?.ok) {
      const p = (await res.json()) as { status?: { phase?: string; podIP?: string } };
      lastPhase = p.status?.phase ?? lastPhase;
      if (lastPhase === "Failed" || lastPhase === "Succeeded") {
        await deleteCluster(name, ns);
        throw new Error(
          `The Spark driver stopped before it was ready (pod ${lastPhase}). Its logs are in namespace ${ns}, pod ${name}.`,
        );
      }
      if (p.status?.podIP && (await portOpen(p.status.podIP, CONNECT_PORT))) return;
    } else if (res?.status === 404) {
      throw new Error("The Spark driver disappeared before it was ready.");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await deleteCluster(name, ns);
  throw new Error(
    `The Spark driver did not start within ${startupSeconds}s (last pod phase: ${lastPhase}). ` +
      `Resolving connector packages on first start is usually the slow part — bake them into ` +
      `SPARK_IMAGE and set SPARK_PACKAGES to empty, or raise SPARK_K8S_STARTUP_TIMEOUT_SECONDS.`,
  );
}

/** Tear a per-run cluster down. Safe to call twice, and for a null ref. */
export async function releaseSparkCluster(ref: string | null | undefined): Promise<void> {
  if (!ref) return;
  const [ns, name] = ref.split("/");
  if (!ns || !name) return;
  await deleteCluster(name, ns);
}

/**
 * Delete per-run clusters whose run is over.
 *
 * The run row is the normal path; this is for the case where nothing points at
 * a cluster any more — the app died between creating one and recording it, or
 * a run row was deleted under it. Cheap enough to run on every ETL sweep, and
 * it only ever deletes objects carrying our own label.
 */
export async function reapOrphanedSparkClusters(): Promise<number> {
  const s = await sparkClusterSettings();
  if (s.provider !== "k8s") return 0;
  const ns = sparkNamespace();
  const res = await k8sFetch(
    `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(
      "app.kubernetes.io/managed-by=agentswarms,app.kubernetes.io/component=spark-driver",
    )}`,
  ).catch(() => null);
  if (!res?.ok) return 0;
  const list = (await res.json()) as {
    items?: { metadata?: { name?: string; labels?: Record<string, string> } }[];
  };
  const items = list.items ?? [];
  if (!items.length) return 0;

  const runIds = items
    .map((i) => i.metadata?.labels?.["agentswarms.spark/run"])
    .filter((v): v is string => Boolean(v));
  // A driver belongs to a pipeline run or to a lakehouse query on Spark; a
  // reaper that knew only runs would delete every query's cluster mid-flight.
  const [{ data: liveRuns }, { data: liveQueries }] = await Promise.all([
    supabaseAdmin
      .from("etl_runs")
      .select("id")
      .in("id", runIds)
      .in("status", ["queued", "running", "retrying"]),
    supabaseAdmin
      .from("lakehouse_spark_queries")
      .select("id")
      .in("id", runIds)
      .in("status", ["queued", "running"]),
  ]);
  const liveIds = new Set([...(liveRuns ?? []), ...(liveQueries ?? [])].map((r) => r.id));

  let reaped = 0;
  for (const item of items) {
    const runId = item.metadata?.labels?.["agentswarms.spark/run"];
    const name = item.metadata?.name;
    if (!name || (runId && liveIds.has(runId))) continue;
    await deleteCluster(name, ns);
    reaped++;
  }
  if (reaped) console.warn(`[spark-k8s] reaped ${reaped} orphaned per-run cluster(s)`);
  return reaped;
}
