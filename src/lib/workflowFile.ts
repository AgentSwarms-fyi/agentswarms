// A workflow as a file in the team's own repository (R541).
//
// The platform holds the running copy of an ML pipeline; the team's GitHub or
// GitLab repository holds the reviewed one. The same definition crosses that
// line in both directions: "Save to repo" writes it, "Update from repo", an
// import and a CI job read it back. So the shape is written down once, here,
// and the editor's own save uses the same step schema, so a file the
// platform wrote always reads back, and a file a person edited is held to
// exactly the rules a save from the editor is.
//
// WHAT GOES IN THE FILE is the definition: steps, arrows, schedule,
// parameters. Whether the workflow is switched on stays in the platform,
// because pausing a pipeline at 2 a.m. should not need a pull request. Ids are
// written, and each step that points at something also carries that thing's
// NAME, so a file read into another workspace can find its own pipeline,
// schedule or connection by name when the id is not there.
//
// Pure: no database, no network, no crypto (the server hashes the text).
import { z } from "zod";

import {
  MAX_NODES,
  NODE_KINDS,
  TARGET_ID_KINDS,
  TRIGGER_RULES,
  WORKFLOW_NAME_MAX,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowParam,
} from "@/lib/workflows";

export const WORKFLOW_FILE_FORMAT = "agentswarms.workflow";
export const WORKFLOW_FILE_VERSION = 1;
/** A workflow file over this is refused before it is parsed. */
export const WORKFLOW_FILE_MAX_BYTES = 512 * 1024;

export const WORKFLOW_SCHEDULES = ["manual", "hourly", "daily", "weekly", "cron"] as const;
export const WORKFLOW_OVERLAPS = ["skip", "queue"] as const;
export const WORKFLOW_NOTIFY = ["never", "failure", "always"] as const;

/** One step, as the editor saves it and as a file holds it. */
export const WORKFLOW_NODE_SCHEMA = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(NODE_KINDS),
  label: z.string().max(200),
  targetId: z.string().max(64).optional(),
  models: z.array(z.string().max(200)).max(200).optional(),
  text: z.string().max(20000).optional(),
  http: z
    .object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      url: z.string().max(2000),
      headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
      body: z.string().max(20000).optional(),
      okStatuses: z.array(z.number().int()).max(50).optional(),
    })
    .optional(),
  kubeflow: z
    .object({
      integrationId: z.string().max(64),
      pipelineId: z.string().max(64),
      versionId: z.string().max(64).optional(),
      pipelineName: z.string().max(200).optional(),
      versionName: z.string().max(200).optional(),
      parameters: z.record(z.string().max(100), z.string().max(2000)).optional(),
      experimentId: z.string().max(64).optional(),
    })
    .optional(),
  waitSeconds: z.number().int().positive().max(86400).optional(),
  continueOnFailure: z.boolean().optional(),
  triggerRule: z.enum(TRIGGER_RULES).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryBackoffSeconds: z.number().int().positive().max(3600).optional(),
  timeoutMinutes: z.number().int().positive().max(10080).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const WORKFLOW_EDGE_SCHEMA = z.object({
  from: z.string().max(64),
  to: z.string().max(64),
  branch: z.enum(["true", "false"]).optional(),
});

export const WORKFLOW_PARAM_SCHEMA = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  default: z.string().max(2000).optional(),
  description: z.string().max(200).optional(),
});

/**
 * The name of what a step points at, written beside its id. An ML schedule's
 * name is only unique within its model, so its model's name comes with it.
 */
const TARGET_HINT = z.object({
  name: z.string().min(1).max(200),
  model: z.string().min(1).max(200).optional(),
});

const FILE_SCHEMA = z.object({
  format: z.literal(WORKFLOW_FILE_FORMAT),
  version: z.literal(WORKFLOW_FILE_VERSION),
  name: z.string().trim().min(1).max(WORKFLOW_NAME_MAX),
  description: z.string().max(2000).nullable().optional(),
  schedule: z.enum(WORKFLOW_SCHEDULES),
  cronExpr: z.string().max(120).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  overlap: z.enum(WORKFLOW_OVERLAPS),
  notifyOn: z.enum(WORKFLOW_NOTIFY),
  timeoutMinutes: z.number().int().min(1).max(10080),
  params: z.array(WORKFLOW_PARAM_SCHEMA).max(30).optional(),
  steps: z.array(WORKFLOW_NODE_SCHEMA.extend({ target: TARGET_HINT.optional() })).max(MAX_NODES),
  edges: z.array(WORKFLOW_EDGE_SCHEMA).max(MAX_NODES * 4),
});

/** Everything a save writes, except whether the workflow is switched on. */
export type WorkflowDefinition = {
  name: string;
  description: string | null;
  schedule: (typeof WORKFLOW_SCHEDULES)[number];
  cronExpr: string | null;
  timezone: string | null;
  overlap: (typeof WORKFLOW_OVERLAPS)[number];
  notifyOn: (typeof WORKFLOW_NOTIFY)[number];
  timeoutMinutes: number;
  graph: WorkflowGraph;
};

export type TargetHint = { name: string; model?: string };
export type WorkflowFileStep = WorkflowNode & { target?: TargetHint };

export type WorkflowFile = {
  format: typeof WORKFLOW_FILE_FORMAT;
  version: typeof WORKFLOW_FILE_VERSION;
  name: string;
  description: string | null;
  schedule: WorkflowDefinition["schedule"];
  cronExpr: string | null;
  timezone: string | null;
  overlap: WorkflowDefinition["overlap"];
  notifyOn: WorkflowDefinition["notifyOn"];
  timeoutMinutes: number;
  params: WorkflowParam[];
  steps: WorkflowFileStep[];
  edges: WorkflowEdge[];
};

/**
 * What a step points at that has to be found again in the workspace reading
 * the file: the table it lives in, and its id. Null for steps that point at
 * nothing (SQL, wait, condition…) or name what they build (SQL models).
 */
export type StepTarget = { kind: TargetKind; id: string };
export type TargetKind =
  | "pipeline"
  | "ml_schedule"
  | "notebook"
  | "swarm"
  | "prep_flow"
  | "dashboard_refresh"
  | "data_monitor"
  | "sub_workflow"
  | "kubeflow_connection";

export function stepTarget(n: WorkflowNode): StepTarget | null {
  if (n.kind === "kubeflow_run") {
    const id = n.kubeflow?.integrationId ?? "";
    return id ? { kind: "kubeflow_connection", id } : null;
  }
  if ((TARGET_ID_KINDS as readonly WorkflowNodeKind[]).includes(n.kind) && n.targetId) {
    return { kind: n.kind as TargetKind, id: n.targetId };
  }
  return null;
}

/** The same step with a different target id (a name found its own copy). */
export function withTargetId(n: WorkflowNode, id: string): WorkflowNode {
  if (n.kind === "kubeflow_run" && n.kubeflow) {
    return { ...n, kubeflow: { ...n.kubeflow, integrationId: id } };
  }
  return { ...n, targetId: id };
}

// A fixed key order, so a file the platform writes twice for the same
// definition is byte-identical and a pull request shows only what changed.
const STEP_KEYS: (keyof WorkflowFileStep)[] = [
  "id",
  "kind",
  "label",
  "target",
  "targetId",
  "models",
  "text",
  "http",
  "kubeflow",
  "waitSeconds",
  "triggerRule",
  "continueOnFailure",
  "retries",
  "retryBackoffSeconds",
  "timeoutMinutes",
  "x",
  "y",
];

function orderedStep(s: WorkflowFileStep): WorkflowFileStep {
  const out: Record<string, unknown> = {};
  for (const k of STEP_KEYS) {
    const v = s[k];
    if (v === undefined || v === null) continue;
    // Canvas positions in whole pixels: a sub-pixel drag is not a change.
    out[k] = k === "x" || k === "y" ? Math.round(v as number) : v;
  }
  return out as WorkflowFileStep;
}

/**
 * The file for a definition. `names` maps a step id to the name of what it
 * points at (from the server, which can read the caller's own rows).
 */
export function toWorkflowFile(
  def: WorkflowDefinition,
  names: Record<string, TargetHint> = {},
): WorkflowFile {
  return {
    format: WORKFLOW_FILE_FORMAT,
    version: WORKFLOW_FILE_VERSION,
    name: def.name,
    description: def.description?.trim() ? def.description : null,
    schedule: def.schedule,
    cronExpr: def.schedule === "cron" ? (def.cronExpr ?? null) : null,
    timezone: def.timezone || null,
    overlap: def.overlap,
    notifyOn: def.notifyOn,
    timeoutMinutes: def.timeoutMinutes,
    params: (def.graph.params ?? []).map((p) => ({
      name: p.name,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.description ? { description: p.description } : {}),
    })),
    steps: def.graph.nodes.map((n) => {
      const hint = names[n.id];
      return orderedStep({
        ...n,
        ...(hint && stepTarget(n)
          ? { target: { name: hint.name, ...(hint.model ? { model: hint.model } : {}) } }
          : {}),
      });
    }),
    edges: def.graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.branch ? { branch: e.branch } : {}),
    })),
  };
}

/** The file's text: two-space JSON and a final newline, as editors leave it. */
export function workflowFileText(file: WorkflowFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ParsedWorkflowFile = { ok: true; file: WorkflowFile } | { ok: false; error: string };

/** Read a file's text, saying what is wrong with it in words a person can fix. */
export function parseWorkflowFile(text: string): ParsedWorkflowFile {
  if (new TextEncoder().encode(text).length > WORKFLOW_FILE_MAX_BYTES) {
    return { ok: false, error: `The file is over ${WORKFLOW_FILE_MAX_BYTES / 1024} KB` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `The file is not valid JSON (${(e as Error).message})` };
  }
  const head = raw as { format?: unknown; version?: unknown } | null;
  if (!head || typeof head !== "object" || head.format !== WORKFLOW_FILE_FORMAT) {
    return {
      ok: false,
      error: `The file is not a workflow file (its "format" is not "${WORKFLOW_FILE_FORMAT}")`,
    };
  }
  if (head.version !== WORKFLOW_FILE_VERSION) {
    return {
      ok: false,
      error: `The file is version ${String(head.version)}; this platform reads version ${WORKFLOW_FILE_VERSION}`,
    };
  }
  const parsed = FILE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "the file";
    return { ok: false, error: `${where}: ${issue?.message ?? "not valid"}` };
  }
  const f = parsed.data;
  return {
    ok: true,
    file: {
      format: WORKFLOW_FILE_FORMAT,
      version: WORKFLOW_FILE_VERSION,
      name: f.name,
      description: f.description ?? null,
      schedule: f.schedule,
      cronExpr: f.cronExpr ?? null,
      timezone: f.timezone ?? null,
      overlap: f.overlap,
      notifyOn: f.notifyOn,
      timeoutMinutes: f.timeoutMinutes,
      params: f.params ?? [],
      steps: f.steps.map((s) => orderedStep(s as WorkflowFileStep)),
      edges: f.edges,
    },
  };
}

/** The definition a file describes, with the name hints set aside. */
export function definitionFromFile(file: WorkflowFile): WorkflowDefinition {
  return {
    name: file.name,
    description: file.description,
    schedule: file.schedule,
    cronExpr: file.schedule === "cron" ? file.cronExpr : null,
    timezone: file.timezone,
    overlap: file.overlap,
    notifyOn: file.notifyOn,
    timeoutMinutes: file.timeoutMinutes,
    graph: {
      nodes: file.steps.map(({ target: _target, ...n }) => n),
      edges: file.edges,
      params: file.params,
    },
  };
}

/** What a step in a file is called, by id: the hints a name lookup uses. */
export function fileTargetNames(file: WorkflowFile): Record<string, TargetHint> {
  const out: Record<string, TargetHint> = {};
  for (const s of file.steps) if (s.target?.name) out[s.id] = s.target;
  return out;
}

export type DefinitionChanges = {
  added: string[];
  removed: string[];
  changed: string[];
  settings: string[];
  /** Arrows added or removed, counted. */
  arrows: number;
};

const stepName = (n: WorkflowNode) => n.label?.trim() || n.kind;
const stepJson = (n: WorkflowNode) => {
  const { x: _x, y: _y, ...rest } = n;
  return JSON.stringify(orderedStep(rest));
};

/**
 * What applying `next` over `current` would change, for the preview before an
 * update from the repo. Moving a step on the canvas is not a change.
 */
export function definitionChanges(
  current: WorkflowDefinition | null,
  next: WorkflowDefinition,
): DefinitionChanges {
  const before = new Map((current?.graph.nodes ?? []).map((n) => [n.id, n]));
  const after = new Map(next.graph.nodes.map((n) => [n.id, n]));
  const added = next.graph.nodes.filter((n) => !before.has(n.id)).map(stepName);
  const removed = [...before.values()].filter((n) => !after.has(n.id)).map(stepName);
  const changed = next.graph.nodes
    .filter((n) => before.has(n.id) && stepJson(before.get(n.id)!) !== stepJson(n))
    .map(stepName);
  const settings: string[] = [];
  if (current) {
    if (current.name !== next.name) settings.push("name");
    if ((current.description ?? "") !== (next.description ?? "")) settings.push("description");
    if (
      current.schedule !== next.schedule ||
      (current.cronExpr ?? "") !== (next.cronExpr ?? "") ||
      (current.timezone ?? "") !== (next.timezone ?? "")
    ) {
      settings.push("schedule");
    }
    if (current.overlap !== next.overlap) settings.push("overlap");
    if (current.notifyOn !== next.notifyOn) settings.push("notifications");
    if (current.timeoutMinutes !== next.timeoutMinutes) settings.push("time limit");
    if (JSON.stringify(current.graph.params ?? []) !== JSON.stringify(next.graph.params ?? [])) {
      settings.push("parameters");
    }
  }
  const edgeKey = (e: WorkflowEdge) => `${e.from}>${e.to}>${e.branch ?? ""}`;
  const was = new Set((current?.graph.edges ?? []).map(edgeKey));
  const now = new Set(next.graph.edges.map(edgeKey));
  const arrows =
    [...now].filter((k) => !was.has(k)).length + [...was].filter((k) => !now.has(k)).length;
  return { added, removed, changed, settings, arrows };
}

/** True when nothing would change. */
export function noChanges(c: DefinitionChanges): boolean {
  return (
    !c.added.length && !c.removed.length && !c.changed.length && !c.settings.length && !c.arrows
  );
}

/** One line for a change summary: "2 steps added, 1 changed, schedule". */
export function changesLine(c: DefinitionChanges): string {
  if (noChanges(c)) return "No changes";
  const parts: string[] = [];
  const steps = (n: number, what: string) => `${n} step${n === 1 ? "" : "s"} ${what}`;
  if (c.added.length) parts.push(steps(c.added.length, "added"));
  if (c.removed.length) parts.push(steps(c.removed.length, "removed"));
  if (c.changed.length) parts.push(steps(c.changed.length, "changed"));
  if (c.arrows) parts.push(`${c.arrows} arrow${c.arrows === 1 ? "" : "s"} changed`);
  parts.push(...c.settings);
  return parts.join(", ");
}

// ── Where files go ──────────────────────────────────────────────────────

/** The repository folder setting, without leading or trailing slashes. */
export function repoBase(basePath: string | null | undefined): string {
  return (basePath ?? "").replace(/^\/+|\/+$/g, "") || "agentswarms";
}

export function fileSlug(name: string, fallback: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback
  );
}

export const pipelinesFolder = (base: string) => `${repoBase(base)}/ml/pipelines`;
export const modelsFolder = (base: string) => `${repoBase(base)}/ml/models`;

/**
 * A new pipeline's file. The plain name when it is free; with the id's first
 * eight characters when another pipeline already uses that name or a file of
 * that name is already in the folder (somebody else's, never overwritten).
 */
export function pipelineFilePath(
  base: string,
  name: string,
  id: string,
  taken: ReadonlySet<string>,
): string {
  const plain = `${pipelinesFolder(base)}/${fileSlug(name, "pipeline")}.json`;
  if (!taken.has(plain)) return plain;
  return `${pipelinesFolder(base)}/${fileSlug(name, "pipeline")}-${id.slice(0, 8)}.json`;
}

export function modelFilePath(base: string, name: string, id: string): string {
  return `${modelsFolder(base)}/${fileSlug(name, "model")}-${id.slice(0, 8)}.json`;
}

/**
 * A git ref a CI job may name: a commit sha or a branch name. Nothing that
 * could walk out of the ref namespace.
 */
export function validRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(ref) &&
    !ref.includes("..") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.startsWith("-")
  );
}

/**
 * Whether a repository name has the owner/name (or group/…/project) shape. A
 * GitLab project may also be named by its numeric id.
 */
export function validRepoName(repo: string, provider: "github" | "gitlab" = "github"): boolean {
  const r = repo.trim().replace(/^\/+|\/+$/g, "");
  if (provider === "gitlab" && /^\d{1,12}$/.test(r)) return true;
  return /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(r) && !r.split("/").includes("..");
}

/** The repository as one key: which provider, which host, which repository. */
export function repoKey(r: { provider: string; repo: string; host?: string | null }): string {
  const host =
    r.provider === "gitlab" ? (r.host?.trim() || "https://gitlab.com").replace(/\/+$/, "") : "";
  return `${r.provider}:${host ? `${host}/` : ""}${r.repo.trim().replace(/^\/+|\/+$/g, "")}`;
}

/**
 * The file's page on GitHub or GitLab, or "" when there is no safe address
 * for it (a host that is not http(s), a GitLab project named by number).
 */
export function repoFileUrl(
  r: { provider: "github" | "gitlab"; repo: string; branch: string; host: string | null },
  path: string,
): string {
  const file = path.split("/").map(encodeURIComponent).join("/");
  const branch = r.branch.split("/").map(encodeURIComponent).join("/");
  if (!validRepoName(r.repo)) return "";
  if (r.provider === "github") return `https://github.com/${r.repo}/blob/${branch}/${file}`;
  const host = (r.host?.trim() || "https://gitlab.com").replace(/\/+$/, "");
  // The host is typed in; only a web address becomes a link (never javascript:).
  if (!/^https?:\/\/[^\s/]+/i.test(host)) return "";
  return `${host}/${r.repo}/-/blob/${branch}/${file}`;
}

// ── What must never be written to a repository ──────────────────────────

const SENSITIVE_NAME =
  /authorization|token|secret|api[-_]?key|apikey|password|passwd|cookie|signature|credential|private[-_]?key|client[-_]?secret/i;
// A value that is only references: {{secret:NAME}}, {{params.x}} or both,
// with an optional scheme word in front ("Bearer {{secret:X}}").
const ONLY_REFERENCES =
  /^\s*(?:[A-Za-z-]+\s+)?(?:\{\{\s*(?:secret:[A-Za-z0-9_.-]+|params\.[A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*)+$/;

const literal = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" && !ONLY_REFERENCES.test(v);

/** Keys with a sensitive name and a typed-in value, anywhere in a JSON body. */
function bodyCredential(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_NAME.test(k) && literal(v)) return k;
    const inner = bodyCredential(v, depth + 1);
    if (inner) return inner;
  }
  return null;
}

/**
 * The first credential an HTTP step holds as typed-in text, as
 * `"step": where`, or null: a header, a query parameter in its address or a
 * field of its JSON body whose name says it is a key, with a value that is
 * not only {{secret:…}} / {{params.…}} references. A file in a repository is
 * read by everyone with access to it and kept forever in its history, so a
 * typed-in key is refused before it is written, not cleaned up after.
 */
export function literalCredential(graph: WorkflowGraph): string | null {
  for (const n of graph.nodes) {
    if (n.kind !== "http" || !n.http) continue;
    for (const [k, v] of Object.entries(n.http.headers ?? {})) {
      if (SENSITIVE_NAME.test(k) && literal(v)) return `"${stepName(n)}": header ${k}`;
    }
    const query = n.http.url.split("?")[1]?.split("#")[0] ?? "";
    for (const pair of query.split("&")) {
      const [rawKey, ...rest] = pair.split("=");
      let key = rawKey;
      let value = rest.join("=");
      try {
        key = decodeURIComponent(rawKey);
        value = decodeURIComponent(value);
      } catch {
        /* judged as written */
      }
      if (key && SENSITIVE_NAME.test(key) && literal(value)) {
        return `"${stepName(n)}": address parameter ${key}`;
      }
    }
    if (n.http.body?.trim()) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(n.http.body);
      } catch {
        // Not JSON: a form body is key=value pairs.
        parsed = Object.fromEntries(
          n.http.body.split("&").map((p) => {
            const [k, ...v] = p.split("=");
            return [k.trim(), v.join("=")];
          }),
        );
      }
      const field = bodyCredential(parsed);
      if (field) return `"${stepName(n)}": body field ${field}`;
    }
  }
  return null;
}

// ── Running it from CI ──────────────────────────────────────────────────

export type CiSnippetInput = {
  /** The platform's address, as the browser sees it. */
  origin: string;
  workflowId: string;
  /** The pipeline's file in the repository. */
  path: string;
  branch: string;
};

/**
 * A job for each provider that, on a push to the branch that changes this
 * pipeline's file, updates the platform's copy from that commit and runs it.
 * Secrets appear only by NAME; the token is created in the workflow's
 * trigger settings and stored in the CI system.
 */
export function ciSnippets(i: CiSnippetInput): { github: string; gitlab: string } {
  const url = `${i.origin.replace(/\/+$/, "")}/api/workflows/run`;
  const body = (ref: string) => `{"workflow_id":"${i.workflowId}","sync":true,"ref":"${ref}"}`;
  const github = [
    "# .github/workflows/agentswarms-pipeline.yml",
    "name: Deploy ML pipeline",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(i.branch)}]`,
    `    paths: [${JSON.stringify(i.path)}]`,
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Update the pipeline from this commit and run it",
    "        env:",
    "          TOKEN: ${{ secrets.AGENTSWARMS_TRIGGER_TOKEN }}",
    "        run: |",
    `          curl -fsS -X POST "${url}" \\`,
    '            -H "Authorization: Bearer $TOKEN" \\',
    '            -H "Content-Type: application/json" \\',
    `            -d '${body("${{ github.sha }}")}'`,
    "",
  ].join("\n");
  const gitlab = [
    "# .gitlab-ci.yml",
    "deploy-ml-pipeline:",
    "  stage: deploy",
    "  image: curlimages/curl:8.11.1",
    "  rules:",
    `    - if: $CI_COMMIT_BRANCH == ${JSON.stringify(i.branch)}`,
    `      changes: [${JSON.stringify(i.path)}]`,
    "  script:",
    "    - >",
    `      curl -fsS -X POST "${url}"`,
    '      -H "Authorization: Bearer $AGENTSWARMS_TRIGGER_TOKEN"',
    '      -H "Content-Type: application/json"',
    `      -d "${body("$CI_COMMIT_SHA").replace(/"/g, '\\"')}"`,
    "",
  ].join("\n");
  return { github, gitlab };
}

// ── A model's configuration, beside the pipelines that train it ─────────

export const MODEL_FILE_FORMAT = "agentswarms.ml_model";

export type ModelConfigInput = {
  model: {
    name: string;
    description: string | null;
    task: string;
    source: unknown;
    prep: unknown;
    target_column: string | null;
    feature_columns: string[] | null;
    time_column: string | null;
    series_column: string | null;
    item_column: string | null;
    user_column: string | null;
    rating_column: string | null;
    sensitive_columns: string[] | null;
    favourable_label: string | null;
    horizon: number | null;
    period: string | null;
    aggregation: string | null;
    n_clusters: number | null;
    contamination: number | null;
    feature_view_id: string | null;
    promotion_approvers: string[] | null;
  };
  schedules: {
    name: string;
    kind: string;
    schedule: string;
    cron_expr: string | null;
    timezone: string | null;
    promote_if_better: boolean;
    is_active: boolean;
    config: unknown;
  }[];
  production: {
    version: number;
    algorithm: string | null;
    metrics: unknown;
    trained_at: string | null;
    training_rows: number | null;
  } | null;
};

const dropEmpty = (o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  );

/**
 * What a model is, for reading in a pull request: its data, columns, how it
 * is retrained and scored, whether production needs a second person's yes,
 * and the version in production now with its scores. Written beside the
 * pipelines that run it; read by people, not by the platform.
 *
 * Nothing that identifies a person (approvers are counted, never named) and
 * no data: no column statistics, no rows, no leaderboard.
 */
export function modelConfigDoc(i: ModelConfigInput): Record<string, unknown> {
  const m = i.model;
  const approvers = (m.promotion_approvers ?? []).length;
  return {
    format: MODEL_FILE_FORMAT,
    version: 1,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    task: m.task,
    source: m.source ?? null,
    ...(m.feature_view_id ? { featureView: m.feature_view_id } : {}),
    columns: dropEmpty({
      target: m.target_column,
      features: m.feature_columns,
      time: m.time_column,
      series: m.series_column,
      item: m.item_column,
      user: m.user_column,
      rating: m.rating_column,
      sensitive: m.sensitive_columns,
    }),
    settings: dropEmpty({
      favourableLabel: m.favourable_label,
      horizon: m.horizon,
      period: m.period,
      aggregation: m.aggregation,
      clusters: m.n_clusters,
      contamination: m.contamination,
    }),
    prep: m.prep ?? {},
    promotion: { needsApproval: approvers > 0, approvers },
    schedules: [...i.schedules]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) =>
        dropEmpty({
          name: s.name,
          kind: s.kind,
          schedule: s.schedule,
          cron: s.cron_expr,
          timezone: s.timezone,
          promoteIfBetter: s.promote_if_better,
          active: s.is_active,
          config: s.config,
        }),
      ),
    production: i.production
      ? dropEmpty({
          version: i.production.version,
          algorithm: i.production.algorithm,
          trainedAt: i.production.trained_at,
          trainingRows: i.production.training_rows,
          metrics: i.production.metrics,
        })
      : null,
  };
}
