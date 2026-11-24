// Model serving on KServe (R532): the settings, names and objects, pure.
//
// On Kubernetes (EKS, GKE, AKS, OKE alike) a warm endpoint can be a KServe
// InferenceService instead of copies the app starts and stops itself. KServe
// then does what the app's own loop did, with the platform's tools: a
// HorizontalPodAutoscaler or KEDA in Standard mode, Knative's request-based
// scaling and scale to zero in Knative mode, and the cloud's node autoscaler
// underneath either.
//
// THE SCORER DOES NOT CHANGE. The predictor is the same image and the same
// score_server.py the sandboxes run, so a prediction is computed by the same
// `_predict` on every path. A pod gets its model the way a sandbox does: from
// the app, which answers with that endpoint's model and no other. It proves
// which endpoint it is with the endpoint's port token, kept in a Secret.
//
// NOT FROM STORAGE, on purpose. KServe's storage initializer would read the
// model with a storage identity shared by every predictor, and a pod runs the
// model's own code (a fitted pipeline is a pickle): one endpoint could then
// read every other endpoint's model. Found while testing on kind (R532).
//
// The API object is serving.kserve.io/v1beta1 InferenceService, as of KServe
// v0.21, whose modes are "Standard" (was RawDeployment) and "Knative" (was
// Serverless).

export const KSERVE_MODES = ["Standard", "Knative"] as const;
export type KserveMode = (typeof KSERVE_MODES)[number];

/**
 * How the app reaches a predictor. `direct`: the in-cluster service address,
 * when the app runs in the same cluster (the Helm chart). `apiserver`: through
 * the API server's service proxy, when it does not (a developer machine
 * driving a kind cluster, or an app outside the cluster) at the cost of a hop.
 */
export const KSERVE_ACCESS = ["direct", "apiserver"] as const;
export type KserveAccess = (typeof KSERVE_ACCESS)[number];

export type KserveConfig = {
  /** ML_SERVING_BACKEND=kserve. Off, warm endpoints are sandboxes as before. */
  enabled: boolean;
  namespace: string;
  mode: KserveMode;
  access: KserveAccess;
  /** The scorer image: the sandbox image, which holds score_server.py. */
  image: string;
  /**
   * The app as a predictor pod reaches it, for its model. In the cluster,
   * the web Service (NOTEBOOK_APP_INTERNAL_URL, which the chart sets).
   */
  appUrl: string;
  /** The service account predictor pods run as. It needs no permissions. */
  serviceAccount: string | null;
  /** What Standard mode scales on, and at what level (percent of the request). */
  scaleMetric: "cpu" | "memory" | "concurrency" | "rps";
  scaleTarget: number;
  cpuRequest: string;
  cpuLimit: string;
  memRequest: string;
  memLimit: string;
  /**
   * How long a deploy waits for the first pod to serve. Longer than a
   * sandbox's: a new node may have to pull the scorer image first.
   */
  readyTimeoutSeconds: number;
};

const DNS_LABEL = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const QUANTITY = /^\d+(\.\d+)?(m|Ki|Mi|Gi|Ti|k|M|G|T)?$/;

/**
 * The KServe settings from the server's environment, with what is wrong with
 * them. A bad value is reported, not guessed around: an endpoint deployed into
 * the wrong namespace, or scaled on a metric the mode cannot use, would serve
 * and look fine until load arrived.
 */
export function kserveConfigFrom(env: Record<string, string | undefined>): {
  config: KserveConfig;
  problems: string[];
} {
  const problems: string[] = [];
  const str = (k: string, d: string) => (env[k]?.trim() ? env[k]!.trim() : d);
  const enabled = str("ML_SERVING_BACKEND", "sandbox").toLowerCase() === "kserve";

  const namespace = str("KSERVE_NAMESPACE", "agentswarms-serving");
  if (!DNS_LABEL.test(namespace) || namespace.length > 63) {
    problems.push(`KSERVE_NAMESPACE "${namespace}" is not a Kubernetes namespace name`);
  }

  const modeRaw = str("KSERVE_MODE", "Standard");
  // The names KServe itself still accepts, for an operator who knows them.
  const legacy: Record<string, KserveMode> = { RawDeployment: "Standard", Serverless: "Knative" };
  const mode = (KSERVE_MODES as readonly string[]).includes(modeRaw)
    ? (modeRaw as KserveMode)
    : (legacy[modeRaw] ?? "Standard");
  if (!(KSERVE_MODES as readonly string[]).includes(modeRaw) && !legacy[modeRaw]) {
    problems.push(`KSERVE_MODE "${modeRaw}" is neither Standard nor Knative`);
  }

  const accessRaw = str("KSERVE_ACCESS", "direct");
  const access = (KSERVE_ACCESS as readonly string[]).includes(accessRaw)
    ? (accessRaw as KserveAccess)
    : "direct";
  if (access !== accessRaw)
    problems.push(`KSERVE_ACCESS "${accessRaw}" is neither direct nor apiserver`);

  const metricRaw = str("KSERVE_SCALE_METRIC", mode === "Knative" ? "concurrency" : "cpu");
  const metricsFor: Record<KserveMode, string[]> = {
    // Standard mode's HPA scales on resource use; requests need Knative (or KEDA).
    Standard: ["cpu", "memory"],
    Knative: ["concurrency", "rps", "cpu", "memory"],
  };
  const scaleMetric = metricsFor[mode].includes(metricRaw)
    ? (metricRaw as KserveConfig["scaleMetric"])
    : mode === "Knative"
      ? "concurrency"
      : "cpu";
  if (scaleMetric !== metricRaw) {
    problems.push(`KSERVE_SCALE_METRIC "${metricRaw}" is not one ${mode} mode scales on`);
  }

  const targetRaw = Number(str("KSERVE_SCALE_TARGET", scaleMetric === "concurrency" ? "4" : "60"));
  const scaleTarget = Number.isFinite(targetRaw) && targetRaw >= 1 ? Math.round(targetRaw) : 60;
  if (scaleTarget !== targetRaw)
    problems.push("KSERVE_SCALE_TARGET must be a whole number of 1 or more");

  const q = (k: string, d: string) => {
    const v = str(k, d);
    if (!QUANTITY.test(v)) problems.push(`${k} "${v}" is not a Kubernetes quantity`);
    return QUANTITY.test(v) ? v : d;
  };

  const image = str("KSERVE_SCORER_IMAGE", str("NOTEBOOK_RUNTIME_IMAGE", ""));
  if (enabled && !image) {
    problems.push("KSERVE_SCORER_IMAGE (or NOTEBOOK_RUNTIME_IMAGE) must name the scorer image");
  }

  const appUrl = str("KSERVE_APP_URL", str("NOTEBOOK_APP_INTERNAL_URL", "")).replace(/\/+$/, "");
  if (enabled && !/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(appUrl)) {
    problems.push(
      "KSERVE_APP_URL (or NOTEBOOK_APP_INTERNAL_URL) must be the app's address as a predictor pod reaches it",
    );
  }

  const sa = env.KSERVE_SERVICE_ACCOUNT?.trim() || null;
  if (sa && (!DNS_LABEL.test(sa) || sa.length > 63)) {
    problems.push(`KSERVE_SERVICE_ACCOUNT "${sa}" is not a service account name`);
  }

  const readyRaw = Number(str("KSERVE_READY_TIMEOUT_SECONDS", "300"));
  const readyTimeoutSeconds =
    Number.isFinite(readyRaw) && readyRaw >= 30 && readyRaw <= 3600 ? Math.round(readyRaw) : 300;
  if (readyTimeoutSeconds !== readyRaw) {
    problems.push("KSERVE_READY_TIMEOUT_SECONDS must be between 30 and 3600");
  }

  return {
    config: {
      enabled,
      namespace,
      mode,
      access,
      image,
      appUrl,
      serviceAccount: sa,
      scaleMetric,
      scaleTarget,
      cpuRequest: q("KSERVE_CPU_REQUEST", "250m"),
      cpuLimit: q("KSERVE_CPU_LIMIT", "1"),
      memRequest: q("KSERVE_MEMORY_REQUEST", "1Gi"),
      memLimit: q("KSERVE_MEMORY_LIMIT", "2Gi"),
      readyTimeoutSeconds,
    },
    problems,
  };
}

// ── Names ────────────────────────────────────────────────────────────────

/**
 * An InferenceService's name for one side of one model's endpoint.
 *
 * Short on purpose: KServe names the predictor's Deployment and Service
 * `<name>-predictor`, Kubernetes adds a ReplicaSet hash and a pod suffix, and
 * every one of those must stay a DNS label of 63 characters or fewer. 26
 * characters here leaves room for all of them.
 */
export function isvcName(modelId: string, role: "primary" | "candidate"): string {
  const hex = modelId
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "")
    .slice(0, 20);
  if (hex.length < 8) throw new Error("Not a model id");
  return `ml-${hex}${role === "candidate" ? "-c" : ""}`;
}

/** The Secret holding one InferenceService's port token. */
export const tokenSecretName = (name: string) => `${name}-token`;

/**
 * The label naming the installation that made an object. Two installations
 * pointed at one namespace (staging and production in one cluster) must never
 * sweep up each other's endpoints, and "made by agentswarms" alone cannot
 * tell them apart.
 */
export const INSTALL_LABEL = "agentswarms.dev/install";

/**
 * Which endpoint a predictor pod says it is: "<namespace>/<name>", both DNS
 * labels. Anything else is refused before a token is even compared.
 */
export function parseEndpoint(raw: string | null | undefined): { ns: string; name: string } | null {
  const m = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?)\/([a-z]([-a-z0-9]*[a-z0-9])?)$/.exec(raw ?? "");
  if (!m || m[1].length > 63 || m[3].length > 63) return null;
  return { ns: m[1], name: m[3] };
}

/** The app's serving API, as a predictor pod calls it. */
export const servingApiUrl = (appUrl: string) => `${appUrl.replace(/\/+$/, "")}/api/ml/serving`;

// ── The objects ──────────────────────────────────────────────────────────

export type IsvcInput = {
  name: string;
  config: KserveConfig;
  minReplicas: number;
  maxReplicas: number;
  labels: Record<string, string>;
};

/**
 * The pod range KServe is given for an endpoint's minimum and maximum.
 *
 * Standard mode's HorizontalPodAutoscaler cannot hold zero pods, so a minimum
 * of 0 becomes 1 there; only Knative scales to zero. The maximum is never
 * below the minimum, and never below 1.
 */
export function replicaBounds(
  mode: KserveMode,
  min: number,
  max: number,
): { minReplicas: number; maxReplicas: number } {
  const floor = mode === "Knative" ? 0 : 1;
  const lo = Math.max(floor, Math.min(Math.trunc(min), Math.trunc(max)));
  return { minReplicas: lo, maxReplicas: Math.max(lo, Math.trunc(max), 1) };
}

/**
 * The InferenceService for one side of an endpoint.
 *
 * A custom-container predictor: KServe's model servers would load a bare
 * sklearn object, and our artifact is a fitted pipeline the shared program
 * prepares input for. No STORAGE_URI, so KServe adds no storage initializer
 * and the pod holds no storage credential: it asks the app for its model.
 */
export function inferenceService(i: IsvcInput) {
  const c = i.config;
  const { minReplicas, maxReplicas } = replicaBounds(c.mode, i.minReplicas, i.maxReplicas);
  return {
    apiVersion: "serving.kserve.io/v1beta1",
    kind: "InferenceService",
    metadata: {
      name: i.name,
      namespace: c.namespace,
      labels: { "app.kubernetes.io/managed-by": "agentswarms", ...i.labels },
      annotations: {
        "serving.kserve.io/deploymentMode": c.mode,
        ...(c.mode === "Standard" ? { "serving.kserve.io/autoscalerClass": "hpa" } : {}),
      },
    },
    spec: {
      predictor: {
        minReplicas,
        maxReplicas,
        scaleMetric: c.scaleMetric,
        scaleTarget: c.scaleTarget,
        ...(c.serviceAccount ? { serviceAccountName: c.serviceAccount } : {}),
        containers: [
          {
            name: "kserve-container",
            image: c.image,
            env: [
              { name: "NB_MODE", value: "score" },
              { name: "AGENTSWARMS_SERVING_URL", value: servingApiUrl(c.appUrl) },
              { name: "AGENTSWARMS_ENDPOINT", value: `${c.namespace}/${i.name}` },
              { name: "KG_PORT", value: "8080" },
              {
                name: "KG_AUTH_TOKEN",
                valueFrom: { secretKeyRef: { name: tokenSecretName(i.name), key: "token" } },
              },
            ],
            ports: [{ containerPort: 8080, protocol: "TCP" }],
            readinessProbe: {
              httpGet: { path: "/healthz", port: 8080 },
              periodSeconds: 5,
              failureThreshold: 60,
            },
            resources: {
              requests: { cpu: c.cpuRequest, memory: c.memRequest },
              limits: { cpu: c.cpuLimit, memory: c.memLimit },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              // The image's user is a name (runner), which runAsNonRoot cannot
              // check; its uid is stated so the kubelet can.
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              capabilities: { drop: ["ALL"] },
              seccompProfile: { type: "RuntimeDefault" },
            },
          },
        ],
      },
    },
  };
}

/** The Secret beside it, holding the port token the scorer checks. */
export function tokenSecret(
  name: string,
  namespace: string,
  token: string,
  labels: Record<string, string> = {},
) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: tokenSecretName(name),
      namespace,
      labels: { "app.kubernetes.io/managed-by": "agentswarms", ...labels },
    },
    type: "Opaque",
    stringData: { token },
  };
}

// ── Reading it back ──────────────────────────────────────────────────────

export type IsvcState = {
  ready: boolean;
  /** Why not, in the controller's words, when it says. */
  reason: string | null;
  /** The predictor's address as KServe reports it. */
  url: string | null;
};

/** Ready, and if not why not, from an InferenceService's status. */
export function isvcState(obj: unknown): IsvcState {
  const status = (obj as { status?: Record<string, unknown> } | null)?.status ?? {};
  const conditions = Array.isArray(status.conditions)
    ? (status.conditions as { type?: string; status?: string; reason?: string; message?: string }[])
    : [];
  const ready = conditions.find((c) => c.type === "Ready");
  const failing = conditions.find((c) => c.status === "False" && (c.message || c.reason));
  const address = (status.address as { url?: string } | undefined)?.url ?? null;
  return {
    ready: ready?.status === "True",
    reason: ready?.status === "True" ? null : (failing?.message ?? failing?.reason ?? null),
    url: address ?? (typeof status.url === "string" ? status.url : null),
  };
}

/** The predictor's in-cluster address, for `direct` access. */
export const predictorServiceUrl = (name: string, namespace: string) =>
  `http://${name}-predictor.${namespace}.svc.cluster.local`;

/** The API server path that proxies to the predictor, for `apiserver` access. */
export const predictorProxyPath = (name: string, namespace: string) =>
  `/api/v1/namespaces/${namespace}/services/${name}-predictor:80/proxy`;

// ── The pods behind it ───────────────────────────────────────────────────

type PodLike = {
  metadata?: { deletionTimestamp?: string | null };
  status?: {
    phase?: string;
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
    initContainerStatuses?: ContainerStatusLike[];
    containerStatuses?: ContainerStatusLike[];
  };
};
type ContainerStatusLike = {
  name?: string;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; exitCode?: number; message?: string };
  };
};

export type PodsSummary = {
  /** Pods answering, by their readiness probe. */
  ready: number;
  /** Pods that exist and are not on their way out. */
  total: number;
  /** Why a pod is not ready, from the first one that says, in Kubernetes' words. */
  reason: string | null;
};

/**
 * How many of an InferenceService's pods are serving, and why the others are
 * not: "no node has room" and "the image cannot be pulled" are facts about the
 * cluster an owner can act on, where "not ready" alone is not.
 */
export function podsSummary(pods: PodLike[]): PodsSummary {
  let ready = 0;
  let total = 0;
  let reason: string | null = null;
  for (const pod of pods) {
    if (pod.metadata?.deletionTimestamp) continue;
    if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") continue;
    total++;
    const conditions = pod.status?.conditions ?? [];
    if (conditions.some((c) => c.type === "Ready" && c.status === "True")) {
      ready++;
      continue;
    }
    if (reason) continue;
    const unscheduled = conditions.find((c) => c.type === "PodScheduled" && c.status === "False");
    if (unscheduled) {
      reason = unscheduled.message || unscheduled.reason || "Waiting for a node";
      continue;
    }
    const statuses = [
      ...(pod.status?.initContainerStatuses ?? []).map((s) => ({ ...s, init: true })),
      ...(pod.status?.containerStatuses ?? []).map((s) => ({ ...s, init: false })),
    ];
    for (const st of statuses) {
      const w = st.state?.waiting;
      const t = st.state?.terminated;
      // Waiting for an init container (one the cluster adds) is a normal wait.
      const who = st.init ? `Setting up (${st.name ?? "init"})` : "The scorer";
      if (w?.reason && w.reason !== "PodInitializing" && w.reason !== "ContainerCreating") {
        reason = `${who}: ${w.reason}${w.message ? ` (${w.message})` : ""}`;
        break;
      }
      if (t && t.exitCode !== 0 && t.reason !== "Completed") {
        // A termination message is often the container's log tail; its last
        // line is the one that says what went wrong.
        const said = (t.message ?? "").trim().split("\n").pop()?.trim();
        reason = `${who} exited: ${t.reason ?? `code ${t.exitCode}`}${said ? ` (${said})` : ""}`;
        break;
      }
    }
  }
  return { ready, total, reason: reason ? reason.slice(0, 500) : null };
}

/**
 * When Kubernetes adds a pod, in words an endpoint's owner can check against
 * what they see: the metric and the level it is held at.
 */
export function scaleRuleText(metric: string, target: number): string {
  switch (metric) {
    case "memory":
      return `pods use more than ${target}% of the memory each one asks for, on average`;
    case "concurrency":
      return `each pod has more than ${target} request${target === 1 ? "" : "s"} in flight`;
    case "rps":
      return `each pod gets more than ${target} request${target === 1 ? "" : "s"} a second`;
    default:
      return `pods use more than ${target}% of the CPU each one asks for, on average`;
  }
}
