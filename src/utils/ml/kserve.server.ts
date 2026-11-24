// Warm endpoints on KServe (R532): the objects in the cluster, how the app
// reaches what they serve, and how a predictor pod gets its model.
//
// The app applies an InferenceService per side of an endpoint and the
// platform's autoscaler adds and removes its pods. A pod asks the app for its
// own model (servingCaller below), proving which endpoint it is with that
// endpoint's port token; it holds no storage credential, because it runs the
// model's own code and a shared credential would reach every other model.
//
// The pure parts (names, objects, settings, reading status) are in
// src/lib/kserve.ts; this file does the I/O.
import { timingSafeEqual } from "node:crypto";
import {
  INSTALL_LABEL,
  inferenceService,
  isvcState,
  parseEndpoint,
  kserveConfigFrom,
  podsSummary,
  predictorProxyPath,
  predictorServiceUrl,
  replicaBounds,
  tokenSecret,
  tokenSecretName,
  type IsvcState,
  type KserveConfig,
  type PodsSummary,
} from "@/lib/kserve";
import { k8sApiBase, k8sFetch, k8sServiceAccountToken } from "@/utils/notebookRuntime/k8s.server";
import { sandboxToken } from "@/utils/notebookRuntime/sandboxAuth.server";

/** The server's KServe settings, read now (they are environment variables). */
export function kserveSettings(): { config: KserveConfig; problems: string[] } {
  return kserveConfigFrom(process.env);
}

/** Is a new warm endpoint served by KServe on this server? */
export function kserveEnabled(): boolean {
  return kserveSettings().config.enabled;
}

const isvcPath = (ns: string, name: string) =>
  `/apis/serving.kserve.io/v1beta1/namespaces/${encodeURIComponent(ns)}/inferenceservices/${encodeURIComponent(name)}`;
const secretPath = (ns: string, name: string) =>
  `/api/v1/namespaces/${encodeURIComponent(ns)}/secrets/${encodeURIComponent(name)}`;

/**
 * The port token for one InferenceService: the sandbox token (R466) derived
 * for its namespace and name. Never stored by the app; the cluster holds it in
 * the Secret beside the InferenceService, and the app derives it again.
 */
export function kserveToken(ns: string, name: string): Promise<string> {
  return sandboxToken(`kserve:${ns}/${name}`);
}

/**
 * This installation's value for INSTALL_LABEL: derived from its runtime
 * secret, so it is stable, the same on every app instance, and says nothing
 * about the secret.
 */
export async function installLabel(): Promise<string> {
  return (await sandboxToken("kserve:install")).slice(0, 16);
}

/** Where the app reaches a predictor, for the access mode in force. */
export function predictorEndpoint(config: KserveConfig, name: string): string {
  return config.access === "apiserver"
    ? `${k8sApiBase()}${predictorProxyPath(name, config.namespace)}`
    : predictorServiceUrl(name, config.namespace);
}

/**
 * The headers a request to a predictor carries.
 *
 * The token goes in X-Port-Token, which the scorer accepts beside its own
 * Authorization form: through the API server's proxy, Authorization is the
 * API server's (the app's ServiceAccount token), which it removes once it has
 * authenticated the call, so it never reaches the pod.
 */
export async function predictorHeaders(
  ns: string,
  name: string,
  config: KserveConfig = kserveSettings().config,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "X-Port-Token": await kserveToken(ns, name) };
  if (config.access === "apiserver") {
    const sa = k8sServiceAccountToken();
    if (sa) headers.Authorization = `Bearer ${sa}`;
  }
  return headers;
}

/** The API server's message from a failed call, or its status. */
async function k8sMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ? `${res.status}: ${body.message}` : `HTTP ${res.status}`;
}

/** What a failure to manage InferenceServices means, for the person deploying. */
function explain(what: string, status: number, message: string, ns: string): string {
  if (status === 404 && what === "InferenceService") {
    return `This cluster has no KServe (the InferenceService API was not found). Install KServe, or set ML_SERVING_BACKEND=sandbox. (${message})`;
  }
  if (status === 403) {
    return `The app may not manage ${what}s in the namespace ${ns}. Grant its service account the serving role (the Helm chart's serving.enabled does). (${message})`;
  }
  return `Could not apply the ${what}: ${message}`;
}

/**
 * Server-side apply: the object as the app wants it, owned by the app's field
 * manager. `force` takes back fields someone changed by hand, since the app's
 * record of the endpoint is what it answers for.
 */
async function apply(path: string, obj: unknown): Promise<Response> {
  return k8sFetch(`${path}?fieldManager=agentswarms&force=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/apply-patch+yaml" },
    // JSON is YAML; the API server takes it as the apply body.
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(15_000),
  });
}

// ── A predictor asking for its model ─────────────────────────────────────

export type ServingCaller =
  | { ok: true; userId: string; modelId: string; versionId: string; ns: string; name: string }
  | { ok: false; status: number; error: string };

/**
 * Which endpoint is asking, and the model it was started for.
 *
 * The pod says which endpoint it is (X-Endpoint) and proves it with that
 * endpoint's port token (X-Port-Token), compared in constant time against the
 * one the app derives. The model is the one the LIVE copy naming that
 * endpoint holds: an endpoint that has been stopped gets nothing, and no
 * header names a model, so a pod cannot ask for anyone else's.
 */
export async function servingCaller(request: Request): Promise<ServingCaller> {
  const endpoint = parseEndpoint(request.headers.get("x-endpoint"));
  const token = request.headers.get("x-port-token") ?? "";
  if (!endpoint || !token)
    return { ok: false, status: 401, error: "Not an endpoint this app made" };
  let want: string;
  try {
    want = await kserveToken(endpoint.ns, endpoint.name);
  } catch (e) {
    return { ok: false, status: 503, error: (e as Error).message };
  }
  const a = Buffer.from(token);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "Not an endpoint this app made" };
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: rows, error } = await supabaseAdmin
    .from("ml_deployment_replicas")
    .select("user_id, version_id, deployment_id")
    .eq("isvc_namespace", endpoint.ns)
    .eq("isvc_name", endpoint.name)
    .in("status", ["starting", "ready"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return { ok: false, status: 503, error: error.message };
  const copy = (rows ?? [])[0] as
    { user_id: string; version_id: string | null; deployment_id: string } | undefined;
  if (!copy?.version_id) {
    return { ok: false, status: 404, error: "This endpoint is not running" };
  }
  const { data: dep, error: depErr } = await supabaseAdmin
    .from("ml_deployments")
    .select("model_id")
    .eq("id", copy.deployment_id)
    .maybeSingle();
  if (depErr) return { ok: false, status: 503, error: depErr.message };
  if (!dep) return { ok: false, status: 404, error: "This endpoint is not running" };
  return {
    ok: true,
    userId: copy.user_id,
    modelId: (dep as { model_id: string }).model_id,
    versionId: copy.version_id,
    ns: endpoint.ns,
    name: endpoint.name,
  };
}

/**
 * The artifact's bytes for a version, streamed from the lake. The pod checks
 * them against the digest in its config; nothing here is trusted for that.
 */
export async function servingArtifact(args: {
  modelId: string;
  versionId: string;
}): Promise<
  | { ok: true; body: ReadableStream<Uint8Array>; bytes: string | null }
  | { ok: false; status: number; error: string }
> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("artifact_uri")
    .eq("id", args.versionId)
    .eq("model_id", args.modelId)
    .maybeSingle();
  const uri = (version as { artifact_uri: string | null } | null)?.artifact_uri;
  if (!uri) return { ok: false, status: 404, error: "That version has no artifact to serve" };
  const { lakeTarget } = await import("@/utils/ml/experimentArtifacts.server");
  const lake = await lakeTarget();
  if (!lake)
    return { ok: false, status: 503, error: "This server has no lakehouse storage set up" };
  const { presignS3 } = await import("@/utils/lakehouse/presign.server");
  const { artifactKeyOf } = await import("@/utils/ml/lakeManifest");
  const url = presignS3({
    target: lake.target,
    key: artifactKeyOf(uri),
    method: "GET",
    expiresSeconds: 300,
    which: "app",
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok || !res.body) {
    return { ok: false, status: 502, error: `Could not read the model's artifact (${res.status})` };
  }
  return { ok: true, body: res.body, bytes: res.headers.get("content-length") };
}

// ── The objects ───────────────────────────────────────────────────────────

/**
 * Apply the token Secret and the InferenceService for one side of an
 * endpoint. The Secret first: the predictor's container reads it at start.
 */
export async function applyInferenceService(args: {
  config: KserveConfig;
  name: string;
  minReplicas: number;
  maxReplicas: number;
  labels: Record<string, string>;
}): Promise<string | null> {
  const ns = args.config.namespace;
  try {
    const install = { [INSTALL_LABEL]: await installLabel() };
    const secret = await apply(
      secretPath(ns, tokenSecretName(args.name)),
      tokenSecret(args.name, ns, await kserveToken(ns, args.name), install),
    );
    if (!secret.ok) {
      return explain("Secret", secret.status, await k8sMessage(secret), ns);
    }
    const isvc = await apply(
      isvcPath(ns, args.name),
      inferenceService({
        name: args.name,
        config: args.config,
        minReplicas: args.minReplicas,
        maxReplicas: args.maxReplicas,
        labels: { ...args.labels, ...install },
      }),
    );
    if (!isvc.ok) return explain("InferenceService", isvc.status, await k8sMessage(isvc), ns);
    return null;
  } catch (e) {
    return `Could not reach the Kubernetes API: ${(e as Error).message}`;
  }
}

/**
 * Change how many pods an endpoint may have, without touching what it serves.
 * A merge patch of the two numbers, so the rest of the object stays as applied.
 */
export async function resizeInferenceService(args: {
  config: KserveConfig;
  ns: string;
  name: string;
  min: number;
  max: number;
}): Promise<string | null> {
  const bounds = replicaBounds(args.config.mode, args.min, args.max);
  try {
    const res = await k8sFetch(`${isvcPath(args.ns, args.name)}?fieldManager=agentswarms`, {
      method: "PATCH",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: JSON.stringify({ spec: { predictor: bounds } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return null;
    return explain("InferenceService", res.status, await k8sMessage(res), args.ns);
  } catch (e) {
    return `Could not reach the Kubernetes API: ${(e as Error).message}`;
  }
}

export type InferenceServiceRead =
  ({ exists: true; pods: PodsSummary | null } & IsvcState) | { exists: false } | { error: string };

/** An InferenceService's state and its pods, as the cluster has them now. */
export async function readInferenceService(
  ns: string,
  name: string,
): Promise<InferenceServiceRead> {
  try {
    const res = await k8sFetch(isvcPath(ns, name), { signal: AbortSignal.timeout(5_000) });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { error: await k8sMessage(res) };
    const state = isvcState(await res.json());
    const selector = encodeURIComponent(`serving.kserve.io/inferenceservice=${name}`);
    const podsRes = await k8sFetch(
      `/api/v1/namespaces/${encodeURIComponent(ns)}/pods?labelSelector=${selector}`,
      { signal: AbortSignal.timeout(5_000) },
    ).catch(() => null);
    const pods =
      podsRes?.ok === true
        ? podsSummary((((await podsRes.json()) as { items?: unknown[] }).items ?? []) as never[])
        : null;
    return { exists: true, ...state, pods };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Delete one side's InferenceService and its token, and wait until it is gone.
 *
 * WAITED FOR, with foreground propagation: a redeploy applies an object of
 * the same name straight after, and one applied while the old predictor's
 * Deployment and Service were still being collected would find them, or lose
 * them to the collector. Foreground keeps the InferenceService until its
 * dependents are gone, so "not found" means all of it is.
 *
 * Returns what went wrong, or null.
 */
export async function deleteInferenceService(
  ns: string,
  name: string,
  waitMs = 90_000,
): Promise<string | null> {
  try {
    const res = await k8sFetch(isvcPath(ns, name), {
      method: "DELETE",
      body: JSON.stringify({
        kind: "DeleteOptions",
        apiVersion: "v1",
        propagationPolicy: "Foreground",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 404) {
      return `Could not delete the InferenceService ${ns}/${name}: ${await k8sMessage(res)}`;
    }
    const secret = await k8sFetch(secretPath(ns, tokenSecretName(name)), {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
    });
    if (!secret.ok && secret.status !== 404) {
      console.warn(
        `[kserve] the token Secret of ${ns}/${name} could not be deleted: ${await k8sMessage(secret)}`,
      );
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const now = await k8sFetch(isvcPath(ns, name), { signal: AbortSignal.timeout(5_000) });
      if (now.status === 404) return null;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return `The InferenceService ${ns}/${name} is still being removed after ${Math.round(waitMs / 1000)} s`;
  } catch (e) {
    return `Could not reach the Kubernetes API to delete ${ns}/${name}: ${(e as Error).message}`;
  }
}

/**
 * The InferenceServices THIS installation made in a namespace, with when each
 * was made. The orphan sweep reads this; nothing else lists.
 */
export async function listManagedInferenceServices(
  ns: string,
): Promise<{ name: string; createdAt: string | null }[] | { error: string }> {
  try {
    const selector = encodeURIComponent(
      `app.kubernetes.io/managed-by=agentswarms,${INSTALL_LABEL}=${await installLabel()}`,
    );
    const res = await k8sFetch(
      `/apis/serving.kserve.io/v1beta1/namespaces/${encodeURIComponent(ns)}/inferenceservices?labelSelector=${selector}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return { error: await k8sMessage(res) };
    const body = (await res.json()) as {
      items?: { metadata?: { name?: string; creationTimestamp?: string } }[];
    };
    return (body.items ?? [])
      .filter((i) => typeof i.metadata?.name === "string")
      .map((i) => ({ name: i.metadata!.name!, createdAt: i.metadata?.creationTimestamp ?? null }));
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * The scorer's own words from a predictor pod that is not serving.
 *
 * A model that fails to load (a digest that does not match, a program error)
 * keeps its pod unready, and the reason is in the scorer's log, where nobody
 * deploying would look. The last "[score]" line of one pod, or null.
 */
export async function predictorLogLine(ns: string, name: string): Promise<string | null> {
  try {
    const selector = encodeURIComponent(`serving.kserve.io/inferenceservice=${name}`);
    const pods = await k8sFetch(
      `/api/v1/namespaces/${encodeURIComponent(ns)}/pods?labelSelector=${selector}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!pods.ok) return null;
    const items =
      ((await pods.json()) as { items?: { metadata?: { name?: string } }[] }).items ?? [];
    const pod = items.find((i) => i.metadata?.name)?.metadata?.name;
    if (!pod) return null;
    const log = await k8sFetch(
      `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}/log?container=kserve-container&tailLines=40`,
      { headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!log.ok) return null;
    const lines = (await log.text()).split("\n").map((l) => l.trim());
    const said = lines.filter((l) => l.startsWith("[score]"));
    // A load failure's traceback follows its line and ends in the exception.
    const at = lines
      .map((l) => l.startsWith("[score]") && l.includes("load failed"))
      .lastIndexOf(true);
    if (at >= 0) {
      const after = lines.slice(at + 1).filter((l) => l.length > 0);
      const last = after[after.length - 1];
      return (last ? `${lines[at]} ${last}` : lines[at]).slice(0, 500);
    }
    return said.at(-1)?.slice(0, 500) ?? null;
  } catch {
    return null;
  }
}
