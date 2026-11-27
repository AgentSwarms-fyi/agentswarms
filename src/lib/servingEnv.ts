// Serving and cluster settings that only the server's environment sets
// (R550), as the Admin → Developer runtime page shows them, read-only.
//
// They stay in the environment on purpose. Together they decide which
// Kubernetes namespace, service account and image the app deploys models
// with, and which nodes a GPU training sandbox lands on: wiring the installer
// or Terraform sets up with the cluster's permissions. A page that could
// change them would let an admin login repoint those permissions. So the page
// shows what is in force and where it came from, and says where to change it.
//
// Pure: it reads only the environment it is handed.
import { kserveConfigFrom } from "@/lib/kserve";

export type ServingEnvRow = {
  /** The environment variable. */
  name: string;
  /** The value in force: what the variable says, or the built-in one. */
  value: string;
  /** True when the environment sets it; false when the built-in value is in force. */
  fromEnv: boolean;
};

export type ServingEnvView = {
  /** Where warm endpoints run: KServe, or a sandbox per copy. */
  backend: "kserve" | "sandbox";
  rows: ServingEnvRow[];
  /** What is wrong with the KServe settings, when KServe is on. */
  problems: string[];
};

export function servingEnvView(env: Record<string, string | undefined>): ServingEnvView {
  const { config, problems } = kserveConfigFrom(env);
  const set = (name: string) => Boolean(env[name]?.trim());
  const row = (name: string, value: string | number | null): ServingEnvRow => ({
    name,
    value: value === null || value === "" ? "(none)" : String(value),
    fromEnv: set(name),
  });
  const rows: ServingEnvRow[] = [row("ML_SERVING_BACKEND", config.enabled ? "kserve" : "sandbox")];
  if (config.enabled) {
    rows.push(
      row("KSERVE_NAMESPACE", config.namespace),
      row("KSERVE_MODE", config.mode),
      row("KSERVE_ACCESS", config.access),
      row("KSERVE_SCALE_METRIC", config.scaleMetric),
      row("KSERVE_SCALE_TARGET", config.scaleTarget),
      row("KSERVE_CPU_REQUEST", config.cpuRequest),
      row("KSERVE_CPU_LIMIT", config.cpuLimit),
      row("KSERVE_MEMORY_REQUEST", config.memRequest),
      row("KSERVE_MEMORY_LIMIT", config.memLimit),
      row("KSERVE_SCORER_IMAGE", config.image),
      row("KSERVE_SERVICE_ACCOUNT", config.serviceAccount),
      row("KSERVE_APP_URL", config.appUrl),
      row("KSERVE_READY_TIMEOUT_SECONDS", config.readyTimeoutSeconds),
    );
  }
  rows.push(
    row("NOTEBOOK_K8S_GPU_NODE_SELECTOR", env.NOTEBOOK_K8S_GPU_NODE_SELECTOR?.trim() ?? null),
    row("NOTEBOOK_K8S_GPU_TOLERATIONS", env.NOTEBOOK_K8S_GPU_TOLERATIONS?.trim() ?? null),
  );
  return {
    backend: config.enabled ? "kserve" : "sandbox",
    rows,
    problems: config.enabled ? problems : [],
  };
}
