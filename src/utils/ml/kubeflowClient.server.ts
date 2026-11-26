// A small client for a Kubeflow Pipelines server's REST API, v2beta1 (R540).
//
// The platform does not run its own pipeline engine for Kubeflow work: a
// team that already keeps its ML pipelines there connects the server under
// Integrations, and a workflow step runs one of those pipelines, passes it
// parameters and waits for it, beside the platform's own steps.
//
// The address is the one the Pipelines UI opens at. A standalone install
// serves the API under it (/apis/v2beta1); a full Kubeflow serves both under
// /pipeline, behind its sign-in, which takes a bearer token. Every call goes
// through the SSRF guard (a team's server usually lives on a private
// network, which the deployment may allow), never follows a redirect (the
// token would go with it), reads at most 2 MB, and checks every id the
// server hands back before it goes into a path or a link.
import { safeFetch } from "@/utils/ssrfGuard.server";

export type KubeflowConnection = {
  /** The Pipelines UI's address, e.g. http://kfp.internal or https://kf.example.com/pipeline. */
  api_url: string;
  /** "none" | "token" */
  auth?: string;
  token?: string;
  /** Multi-user Kubeflow: the profile namespace pipelines and runs belong to. */
  namespace?: string;
};

export class KubeflowError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "KubeflowError";
    this.status = status;
  }
}

const API_TIMEOUT_MS = 20_000;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * The server's base URL, or null when it is not one we will call: http(s)
 * only, no credentials in it (they belong in the token field, where they are
 * encrypted), no query or fragment.
 */
export function kubeflowBase(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/** A namespace as Kubernetes allows it, or null. */
export function kubeflowNamespace(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s && NAMESPACE_RE.test(s) ? s : null;
}

export function kubeflowHeaders(c: KubeflowConnection): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const auth = c.auth ?? (c.token ? "token" : "none");
  if (auth === "token" && c.token?.trim()) {
    h.Authorization = `Bearer ${c.token.trim().replace(/^Bearer\s+/i, "")}`;
  }
  return h;
}

/** An id the server handed back, safe to put in a path or a link. */
export function kubeflowId(v: unknown, what: string): string {
  const s = typeof v === "string" ? v : "";
  if (!ID_RE.test(s)) throw new KubeflowError(`Kubeflow returned an unexpected ${what}.`);
  return s;
}

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new KubeflowError("Kubeflow's answer was larger than expected.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Kubeflow's own reason, from either shape its errors come in. */
export function kubeflowErrorText(json: unknown, text: string, status: number): string {
  const j = (json ?? {}) as { error_message?: unknown; message?: unknown; error?: unknown };
  const said = [j.message, j.error_message, j.error].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  const why = (said ?? text ?? "").toString().replace(/\s+/g, " ").trim();
  return why.slice(0, 300) || `Kubeflow answered ${status}.`;
}

/** One REST call under /apis/v2beta1; a non-2xx answer becomes a KubeflowError. */
export async function kubeflowCall<T = Record<string, unknown>>(
  c: KubeflowConnection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = kubeflowBase(c.api_url);
  if (!base) {
    throw new KubeflowError(
      "The Kubeflow address must be an http(s) address with no credentials in it.",
    );
  }
  let res: Response;
  try {
    res = await safeFetch(`${base}/apis/v2beta1${path}`, {
      method,
      headers: {
        ...kubeflowHeaders(c),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      maxRedirects: 0,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    if (/Too many redirects/i.test(m)) {
      throw new KubeflowError(
        "Kubeflow answered with a redirect, usually to a sign-in page. Use the address it redirects to, or a token that its sign-in accepts.",
      );
    }
    if ((e as Error).name === "TimeoutError" || /aborted|timeout/i.test(m)) {
      throw new KubeflowError(`Kubeflow did not answer within ${API_TIMEOUT_MS / 1000} s.`);
    }
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
    const host = (() => {
      try {
        return new URL(base).host;
      } catch {
        return base;
      }
    })();
    if (cause === "ECONNREFUSED") {
      throw new KubeflowError(
        `Nothing is answering at ${host}: Kubeflow Pipelines is not running there.`,
      );
    }
    if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") {
      throw new KubeflowError(`${host} does not resolve from this server. Check the address.`);
    }
    throw new KubeflowError(`Could not reach Kubeflow: ${m.slice(0, 200)}`);
  }
  const text = await readBounded(res);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new KubeflowError("Kubeflow refused the credentials.", res.status);
    }
    throw new KubeflowError(kubeflowErrorText(json, text, res.status), res.status);
  }
  if (json === null) {
    // A sign-in page answers 200 with HTML; say that rather than "not JSON".
    throw new KubeflowError(
      /<html/i.test(text)
        ? "Kubeflow answered with a web page, not its API: usually its sign-in. Add a token it accepts, or check the address."
        : "Kubeflow's answer was not JSON.",
      res.status,
    );
  }
  return json as T;
}

/** What the server says it is: version, and whether it is multi-user. */
export async function kubeflowHealth(
  c: KubeflowConnection,
): Promise<{ version: string | null; multiUser: boolean }> {
  const h = await kubeflowCall<{ tag_name?: unknown; multi_user?: unknown }>(c, "GET", "/healthz");
  const tag = typeof h.tag_name === "string" ? h.tag_name.trim() : "";
  return {
    version: /^[A-Za-z0-9.+_-]{1,40}$/.test(tag) ? tag : null,
    multiUser: h.multi_user === true,
  };
}

const nsQuery = (c: KubeflowConnection) => {
  const ns = kubeflowNamespace(c.namespace);
  return ns ? `&namespace=${encodeURIComponent(ns)}` : "";
};

export type KubeflowPipeline = { id: string; name: string; description: string | null };

/** The pipelines on the server (newest first, at most 200). */
export async function kubeflowPipelines(c: KubeflowConnection): Promise<KubeflowPipeline[]> {
  const out: KubeflowPipeline[] = [];
  let token = "";
  for (let page = 0; page < 4; page++) {
    const r = await kubeflowCall<{ pipelines?: unknown[]; next_page_token?: unknown }>(
      c,
      "GET",
      `/pipelines?page_size=50&sort_by=${encodeURIComponent("created_at desc")}${nsQuery(c)}${
        token ? `&page_token=${encodeURIComponent(token)}` : ""
      }`,
    );
    for (const p of r.pipelines ?? []) {
      const row = p as { pipeline_id?: unknown; display_name?: unknown; description?: unknown };
      try {
        out.push({
          id: kubeflowId(row.pipeline_id, "pipeline id"),
          name: typeof row.display_name === "string" ? row.display_name.slice(0, 200) : "pipeline",
          description:
            typeof row.description === "string" && row.description
              ? row.description.slice(0, 500)
              : null,
        });
      } catch {
        // One malformed row is skipped, not the whole list.
      }
    }
    token = typeof r.next_page_token === "string" ? r.next_page_token : "";
    if (!token) break;
  }
  return out;
}

export type KubeflowParamType =
  "STRING" | "NUMBER_INTEGER" | "NUMBER_DOUBLE" | "BOOLEAN" | "LIST" | "STRUCT";

export type KubeflowVersion = {
  id: string;
  name: string;
  createdAt: string | null;
  /** The pipeline's own inputs, from its spec: what a run may be given. */
  /** `default` is the declared default as text (JSON for a list or object), or null. */
  parameters: {
    name: string;
    type: KubeflowParamType;
    default: string | null;
    optional: boolean;
  }[];
};

const PARAM_TYPES: readonly KubeflowParamType[] = [
  "STRING",
  "NUMBER_INTEGER",
  "NUMBER_DOUBLE",
  "BOOLEAN",
  "LIST",
  "STRUCT",
];

/** A version's input parameters, read from its compiled spec. */
export function specParameters(spec: unknown): KubeflowVersion["parameters"] {
  const root = (spec as { root?: { inputDefinitions?: { parameters?: unknown } } } | null)?.root;
  const params = root?.inputDefinitions?.parameters;
  if (!params || typeof params !== "object") return [];
  return Object.entries(params as Record<string, unknown>)
    .slice(0, 100)
    .map(([name, def]) => {
      const d = (def ?? {}) as {
        parameterType?: unknown;
        defaultValue?: unknown;
        isOptional?: unknown;
      };
      const type = PARAM_TYPES.includes(d.parameterType as KubeflowParamType)
        ? (d.parameterType as KubeflowParamType)
        : "STRING";
      return {
        name: name.slice(0, 100),
        type,
        default:
          d.defaultValue === undefined || d.defaultValue === null
            ? null
            : typeof d.defaultValue === "string"
              ? d.defaultValue.slice(0, 500)
              : JSON.stringify(d.defaultValue).slice(0, 500),
        optional: d.isOptional === true || d.defaultValue !== undefined,
      };
    });
}

/** A pipeline's versions, newest first (at most 50). */
export async function kubeflowVersions(
  c: KubeflowConnection,
  pipelineId: string,
): Promise<KubeflowVersion[]> {
  const id = kubeflowId(pipelineId, "pipeline id");
  const r = await kubeflowCall<{ pipeline_versions?: unknown[] }>(
    c,
    "GET",
    `/pipelines/${id}/versions?page_size=50&sort_by=${encodeURIComponent("created_at desc")}`,
  );
  const out: KubeflowVersion[] = [];
  for (const v of r.pipeline_versions ?? []) {
    const row = v as {
      pipeline_version_id?: unknown;
      display_name?: unknown;
      created_at?: unknown;
      pipeline_spec?: unknown;
    };
    try {
      out.push({
        id: kubeflowId(row.pipeline_version_id, "version id"),
        name: typeof row.display_name === "string" ? row.display_name.slice(0, 200) : "version",
        createdAt: typeof row.created_at === "string" ? row.created_at : null,
        parameters: specParameters(row.pipeline_spec),
      });
    } catch {
      // skipped
    }
  }
  return out;
}

/**
 * A parameter's text as the type the pipeline declared. A workflow's values
 * are text (they may come from {{params.x}}); Kubeflow checks a run's
 * parameters against the spec, so "3" sent for an integer input fails the
 * run before it starts.
 */
export function coerceParameter(
  name: string,
  raw: string,
  type: KubeflowParamType,
): string | number | boolean | unknown[] | Record<string, unknown> {
  const v = raw.trim();
  switch (type) {
    case "NUMBER_INTEGER": {
      // "5.0" is how the KFP SDK itself writes an integer's default.
      if (!/^-?\d+(\.0+)?$/.test(v))
        throw new KubeflowError(
          `Parameter ${name} must be a whole number, not "${raw.slice(0, 40)}".`,
        );
      return Number.parseInt(v, 10);
    }
    case "NUMBER_DOUBLE": {
      const n = Number(v);
      if (!v || !Number.isFinite(n))
        throw new KubeflowError(`Parameter ${name} must be a number, not "${raw.slice(0, 40)}".`);
      return n;
    }
    case "BOOLEAN": {
      if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
      throw new KubeflowError(
        `Parameter ${name} must be true or false, not "${raw.slice(0, 40)}".`,
      );
    }
    case "LIST":
    case "STRUCT": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        throw new KubeflowError(
          `Parameter ${name} must be JSON (${type === "LIST" ? "a list" : "an object"}).`,
        );
      }
      if (
        type === "LIST"
          ? !Array.isArray(parsed)
          : !parsed || typeof parsed !== "object" || Array.isArray(parsed)
      ) {
        throw new KubeflowError(
          `Parameter ${name} must be JSON ${type === "LIST" ? "list" : "object"}.`,
        );
      }
      return parsed as unknown[] | Record<string, unknown>;
    }
    default:
      return raw;
  }
}

/** The parameters a run is given, typed against the version's own inputs. */
export function runParameters(
  values: Record<string, string>,
  declared: KubeflowVersion["parameters"],
): Record<string, unknown> {
  const byName = new Map(declared.map((p) => [p.name, p]));
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(values)) {
    const d = byName.get(name);
    if (!d) {
      throw new KubeflowError(
        `The pipeline has no parameter named ${name}${
          declared.length ? `; it takes ${declared.map((p) => p.name).join(", ")}` : ""
        }.`,
      );
    }
    out[name] = coerceParameter(name, raw, d.type);
  }
  const missing = declared.filter((p) => !p.optional && !(p.name in out)).map((p) => p.name);
  if (missing.length) throw new KubeflowError(`The pipeline needs ${missing.join(", ")}.`);
  return out;
}

/** Start a run of one version. Returns its id. */
export async function kubeflowStartRun(
  c: KubeflowConnection,
  args: {
    pipelineId: string;
    versionId: string;
    displayName: string;
    parameters: Record<string, unknown>;
    experimentId?: string | null;
  },
): Promise<string> {
  const body: Record<string, unknown> = {
    display_name: args.displayName.slice(0, 200),
    pipeline_version_reference: {
      pipeline_id: kubeflowId(args.pipelineId, "pipeline id"),
      pipeline_version_id: kubeflowId(args.versionId, "version id"),
    },
    runtime_config: { parameters: args.parameters },
  };
  if (args.experimentId) body.experiment_id = kubeflowId(args.experimentId, "experiment id");
  const r = await kubeflowCall<{ run_id?: unknown }>(c, "POST", "/runs", body);
  return kubeflowId(r.run_id, "run id");
}

/** Where a run stands, in the workflow's words. */
export type KubeflowRunState =
  | { done: false; state: string }
  | { done: true; ok: true; state: string }
  | { done: true; ok: false; state: string; error: string };

/** Kubeflow's run states, mapped once (RuntimeState in its API). */
export function runOutcome(run: {
  state?: unknown;
  error?: unknown;
  run_details?: unknown;
}): KubeflowRunState {
  const state = typeof run.state === "string" ? run.state : "RUNTIME_STATE_UNSPECIFIED";
  if (state === "SUCCEEDED" || state === "SKIPPED") return { done: true, ok: true, state };
  if (state === "FAILED" || state === "CANCELED") {
    const err = run.error as { message?: unknown } | undefined;
    // The run's own message, else the first failed task's.
    const tasks = ((run.run_details as { task_details?: unknown[] } | undefined)?.task_details ??
      []) as { state?: unknown; display_name?: unknown; error?: { message?: unknown } }[];
    const failed = tasks.find((t) => t.state === "FAILED" && typeof t.error?.message === "string");
    const said =
      typeof err?.message === "string" && err.message.trim()
        ? err.message.trim()
        : failed
          ? `${typeof failed.display_name === "string" ? `${failed.display_name}: ` : ""}${String(failed.error?.message)}`
          : null;
    // MEASURED on Kubeflow Pipelines 2.18.0 (R540): a failed run carries no
    // message at all, on the run or on any task; the reason is only in the
    // step's log. Say WHICH step failed. The task list is flat and mixes the
    // pipeline's own steps with its machinery (root, executor, drivers, the
    // workflow, "(0)" copies); a step of the pipeline is a name that has a
    // "<name>-driver" task beside it.
    const names = new Set(
      tasks.map((t) => (typeof t.display_name === "string" ? t.display_name : "")),
    );
    const failedSteps = [
      ...new Set(
        tasks
          .filter((t) => t.state === "FAILED" && typeof t.display_name === "string")
          .map((t) => String(t.display_name))
          .filter((n) => n !== "root" && names.has(`${n}-driver`)),
      ),
    ].slice(0, 5);
    const where = failedSteps.length
      ? ` at the step${failedSteps.length === 1 ? "" : "s"} ${failedSteps.map((s) => `"${s.slice(0, 80)}"`).join(", ")}; its log in Kubeflow says why`
      : "";
    return {
      done: true,
      ok: false,
      state,
      error:
        state === "CANCELED"
          ? "The run was cancelled in Kubeflow."
          : said
            ? `The Kubeflow run failed: ${said.replace(/\s+/g, " ").slice(0, 400)}`
            : `The Kubeflow run failed${where}.`,
    };
  }
  // PENDING, RUNNING, CANCELING, PAUSED, unspecified: not over yet.
  return { done: false, state };
}

export async function kubeflowRun(c: KubeflowConnection, runId: string): Promise<KubeflowRunState> {
  const run = await kubeflowCall<Record<string, unknown>>(
    c,
    "GET",
    `/runs/${kubeflowId(runId, "run id")}`,
  );
  return runOutcome(run);
}

/** Stop a run (POST :terminate). */
export async function kubeflowStopRun(c: KubeflowConnection, runId: string): Promise<void> {
  await kubeflowCall(c, "POST", `/runs/${kubeflowId(runId, "run id")}:terminate`, {});
}

/** The run's page in the Pipelines UI. */
export function kubeflowRunUrl(c: KubeflowConnection, runId: string): string | null {
  const base = kubeflowBase(c.api_url);
  if (!base || !ID_RE.test(runId)) return null;
  return `${base}/#/runs/details/${runId}`;
}
