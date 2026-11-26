// ML pipelines kept in the team's own repository (R541).
//
// One module for every crossing between a workflow and its file: Save to
// repo, Update from repo, Import from repo and a CI deploy. The page's server
// functions and /api/workflows/run both call it, so a CI job is held to
// exactly what a person pressing "Update from repo" is.
//
// THE REPOSITORY IS THE OWNER'S. Every call reads git_export_config by the
// workflow OWNER's id (never by an id alone), sends the owner's token only to
// the host that config names, and writes through the one definition path an
// editor save takes (definition.server.ts).
import { createHash } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  branchHead,
  commitFiles,
  commitOnBranch,
  listFolder,
  readFileAtRef,
  type ExportFile,
  type GitExportConfig,
} from "@/utils/git/exporter.server";
import { gitTokenForUse, storedGitToken } from "@/utils/git/token.server";
import {
  definitionChanges,
  literalCredential,
  modelConfigDoc,
  modelFilePath,
  parseWorkflowFile,
  pipelineFilePath,
  pipelinesFolder,
  repoBase,
  repoKey,
  toWorkflowFile,
  validRef,
  validRepoName,
  workflowFileText,
  type DefinitionChanges,
  type ModelConfigInput,
  type WorkflowFile,
} from "@/lib/workflowFile";
import {
  applyWorkflowDefinition,
  definitionOfRow,
  resolveFileTargets,
  targetNamesFor,
  validateDefinition,
} from "@/utils/workflows/definition.server";

type Fail = { ok: false; error: string; status?: number };

export type RepoConnection = { cfg: GitExportConfig; token: string; base: string };

export const CONNECT_REPO_HINT = "Connect a repository first, under Integrations → Git repository";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The owner's repository, with the token as it is sent. */
export async function repoConnectionOf(
  userId: string,
): Promise<Fail | { ok: true; conn: RepoConnection }> {
  const { data: row, error } = await supabaseAdmin
    .from("git_export_config")
    .select("provider, repo, branch, base_path, host, token_enc")
    .eq("user_id", userId)
    .maybeSingle();
  if (error)
    return {
      ok: false,
      error: `Could not read the repository settings: ${error.message}`,
      status: 503,
    };
  if (!row) return { ok: false, error: CONNECT_REPO_HINT, status: 409 };
  if (!validRepoName(row.repo, row.provider === "gitlab" ? "gitlab" : "github")) {
    return {
      ok: false,
      error: `The repository "${row.repo}" is not an owner/name path — fix it under Integrations → Git repository`,
      status: 409,
    };
  }
  const stored = await storedGitToken(row.token_enc);
  if (!stored) {
    return {
      ok: false,
      error:
        "No access token is saved for the repository — add one under Integrations → Git repository",
      status: 409,
    };
  }
  const cfg: GitExportConfig = {
    provider: row.provider as GitExportConfig["provider"],
    repo: row.repo.trim(),
    branch: row.branch,
    base_path: row.base_path,
    host: row.host,
  };
  try {
    const token = await gitTokenForUse(userId, cfg, stored);
    return { ok: true, conn: { cfg, token, base: repoBase(row.base_path) } };
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 409 };
  }
}

async function ownWorkflow(userId: string, id: string) {
  const { data } = await supabaseAdmin
    .from("workflows")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

export type RepoLink = {
  workflow_id: string;
  /** Which repository the file is in (repoKey), so a changed setting is noticed. */
  repo: string;
  path: string;
  local_hash: string;
  repo_hash: string;
  synced_commit: string | null;
  synced_at: string;
  synced_by: string;
};

/** Said instead of the database's words when the R541 migration is not applied. */
export const LINKS_MIGRATION_MISSING =
  "Keeping ML pipelines in a repository needs migration 20261204000000, which is not applied yet";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function linksOf(userId: string, workflowIds?: string[]): Promise<RepoLink[]> {
  let q = supabaseAdmin
    .from("workflow_repo_links")
    .select("workflow_id, repo, path, local_hash, repo_hash, synced_commit, synced_at, synced_by")
    .eq("user_id", userId);
  if (workflowIds) q = q.in("workflow_id", workflowIds.length ? workflowIds : [NIL_UUID]);
  const { data, error } = await q;
  if (error) {
    throw new Error(
      /workflow_repo_links/.test(error.message) &&
        /schema cache|does not exist/i.test(error.message)
        ? LINKS_MIGRATION_MISSING
        : `Could not read which pipelines are kept in the repository: ${error.message}`,
    );
  }
  return (data ?? []) as RepoLink[];
}

async function writeLink(
  userId: string,
  workflowId: string,
  link: Omit<RepoLink, "workflow_id" | "synced_at">,
): Promise<string | null> {
  const { error } = await supabaseAdmin.from("workflow_repo_links").upsert(
    {
      workflow_id: workflowId,
      user_id: userId,
      repo: link.repo,
      path: link.path,
      local_hash: link.local_hash,
      repo_hash: link.repo_hash,
      synced_commit: link.synced_commit,
      synced_by: link.synced_by,
      synced_at: new Date().toISOString(),
    },
    { onConflict: "workflow_id" },
  );
  return error ? error.message : null;
}

/** The file the platform would write for this workflow now. */
async function currentFile(userId: string, row: Record<string, unknown>): Promise<WorkflowFile> {
  const def = definitionOfRow(row);
  return toWorkflowFile(def, await targetNamesFor(userId, def.graph));
}

/** The hash of what the platform holds, comparable with a link's local_hash. */
export async function liveHash(userId: string, row: Record<string, unknown>): Promise<string> {
  return sha256(workflowFileText(await currentFile(userId, row)));
}

/**
 * The configuration file of every model a pipeline retrains or scores, read
 * from the owner's own rows.
 */
async function modelFilesFor(
  userId: string,
  file: WorkflowFile,
  base: string,
): Promise<ExportFile[]> {
  const scheduleIds = file.steps
    .filter((s) => s.kind === "ml_schedule" && s.targetId)
    .map((s) => String(s.targetId));
  if (!scheduleIds.length) return [];
  const { data: picked } = await supabaseAdmin
    .from("ml_schedules")
    .select("model_id")
    .eq("user_id", userId)
    .in("id", scheduleIds);
  const modelIds = [...new Set((picked ?? []).map((r) => String(r.model_id)))];
  if (!modelIds.length) return [];
  const [{ data: models }, { data: schedules }] = await Promise.all([
    supabaseAdmin.from("ml_models").select("*").eq("user_id", userId).in("id", modelIds),
    supabaseAdmin
      .from("ml_schedules")
      .select(
        "model_id, name, kind, schedule, cron_expr, timezone, promote_if_better, is_active, config",
      )
      .eq("user_id", userId)
      .in("model_id", modelIds),
  ]);
  const productionIds = (models ?? [])
    .map((m) => m.production_version_id)
    .filter(Boolean) as string[];
  const { data: versions } = productionIds.length
    ? await supabaseAdmin
        .from("ml_model_versions")
        .select("id, version, algorithm, metrics, trained_at, training_rows")
        .eq("user_id", userId)
        .in("id", productionIds)
    : { data: [] };
  const versionById = new Map((versions ?? []).map((v) => [String(v.id), v]));
  return (models ?? []).map((m) => {
    const production = m.production_version_id ? versionById.get(m.production_version_id) : null;
    const input: ModelConfigInput = {
      model: m as unknown as ModelConfigInput["model"],
      schedules: (schedules ?? [])
        .filter((s) => s.model_id === m.id)
        .map((s) => s as unknown as ModelConfigInput["schedules"][number]),
      production: production
        ? {
            version: production.version,
            algorithm: production.algorithm,
            metrics: production.metrics,
            trained_at: production.trained_at,
            training_rows: production.training_rows,
          }
        : null,
    };
    return {
      path: modelFilePath(base, m.name, m.id),
      content: `${JSON.stringify(modelConfigDoc(input), null, 2)}\n`,
    };
  });
}

// ── Save to repo ────────────────────────────────────────────────────────

export type SaveResult = {
  ok: true;
  path: string;
  commit: string;
  commitUrl: string;
  files: number;
};

export async function saveWorkflowToRepo(
  userId: string,
  workflowId: string,
  message?: string,
): Promise<Fail | SaveResult> {
  const row = await ownWorkflow(userId, workflowId);
  if (!row) return { ok: false, error: "Workflow not found", status: 404 };
  const repo = await repoConnectionOf(userId);
  if (!repo.ok) return repo;
  const { cfg, token, base } = repo.conn;

  const def = definitionOfRow(row);
  const credential = literalCredential(def.graph);
  if (credential) {
    return {
      ok: false,
      error: `The HTTP step ${credential} holds a key typed in as text. Pick it from your secrets ({{secret:NAME}}) before saving to the repository — a repository keeps every version forever.`,
    };
  }
  const here = repoKey(cfg);
  const file = await currentFile(userId, row);
  const text = workflowFileText(file);

  try {
    const [existing] = await linksOf(userId, [workflowId]);
    // Kept in another repository before the settings changed: a new file here.
    let path = existing?.repo === here ? existing.path : undefined;
    if (!path) {
      const head = await branchHead(cfg, token);
      const taken = new Set([
        ...(await linksOf(userId)).filter((l) => l.repo === here).map((l) => l.path),
        ...(await listFolder(cfg, token, pipelinesFolder(base), head)).map((f) => f.path),
      ]);
      path = pipelineFilePath(base, def.name, workflowId, taken);
    }
    const files: ExportFile[] = [
      { path, content: text },
      ...(await modelFilesFor(userId, file, base)),
    ];
    const subject = message?.trim() || `Update ML pipeline "${def.name}"`;
    const commit = await commitFiles(cfg, token, files, subject.slice(0, 500));
    const hash = sha256(text);
    const linkError = await writeLink(userId, workflowId, {
      repo: here,
      path,
      local_hash: hash,
      repo_hash: hash,
      synced_commit: commit.sha,
      synced_by: "save",
    });
    if (linkError) {
      return {
        ok: false,
        error: `Saved to the repository (${commit.sha.slice(0, 7)}), but the link could not be recorded: ${linkError}`,
      };
    }
    auditEvent({
      userId,
      action: "workflow.repo.save",
      resourceType: "workflow",
      resourceId: workflowId,
      resourceName: def.name,
      detail: {
        repo: `${cfg.provider}:${cfg.repo}`,
        path,
        commit: commit.sha,
        files: files.length,
      },
    });
    return { ok: true, path, commit: commit.sha, commitUrl: commit.commitUrl, files: files.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 502 };
  }
}

// ── Update from repo, and a CI deploy ───────────────────────────────────

/** A commit sha, as git prints it. */
const SHA = /^[0-9a-f]{7,64}$/i;

async function readLinkedFile(
  conn: RepoConnection,
  path: string,
  ref: string,
): Promise<Fail | { ok: true; file: WorkflowFile; text: string }> {
  let text: string;
  try {
    text = await readFileAtRef(conn.cfg, conn.token, path, ref);
  } catch (e) {
    const msg = (e as Error).message;
    if (/\b404\b/.test(msg)) {
      return {
        ok: false,
        error: `The file ${path} is not in the repository at ${ref.slice(0, 12)}`,
        status: 409,
      };
    }
    return { ok: false, error: msg, status: 502 };
  }
  const parsed = parseWorkflowFile(text);
  if (!parsed.ok) return { ok: false, error: `${path}: ${parsed.error}`, status: 422 };
  return { ok: true, file: parsed.file, text };
}

export type PullPreview = {
  ok: true;
  path: string;
  commit: string;
  changes: DefinitionChanges;
  /** Steps whose target was found by name rather than by id. */
  renamed: number;
};

type PullOptions = {
  /** A commit sha or the configured branch; the branch head when absent. */
  ref?: string;
  /** Write it (true), or only say what would change (false). */
  apply: boolean;
  by: "pull" | "ci";
};

/**
 * Read the workflow's file and, when `apply`, make it the definition. A
 * commit named by a caller must be on the configured branch.
 */
export async function pullWorkflowFromRepo(
  userId: string,
  workflowId: string,
  opts: PullOptions,
): Promise<Fail | PullPreview> {
  const row = await ownWorkflow(userId, workflowId);
  if (!row) return { ok: false, error: "Workflow not found", status: 404 };
  let link: RepoLink | undefined;
  try {
    [link] = await linksOf(userId, [workflowId]);
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 503 };
  }
  if (!link) {
    return {
      ok: false,
      error:
        "This workflow is not kept in a repository yet — Save to repo first, or import it from there",
      status: 409,
    };
  }
  const repo = await repoConnectionOf(userId);
  if (!repo.ok) return repo;
  const { cfg, token } = repo.conn;
  if (link.repo !== repoKey(cfg)) {
    return {
      ok: false,
      error: `This pipeline is kept in ${link.repo}, and the connected repository is now ${repoKey(cfg)}. Save it to the new one first.`,
      status: 409,
    };
  }

  let commit: string;
  try {
    const ref = opts.ref?.trim();
    if (ref && !validRef(ref)) {
      return { ok: false, error: "ref must be a commit sha or the branch name", status: 400 };
    }
    if (!ref || ref === cfg.branch) {
      commit = await branchHead(cfg, token);
    } else if (SHA.test(ref)) {
      if (!(await commitOnBranch(cfg, token, ref))) {
        return {
          ok: false,
          error: `The commit ${ref.slice(0, 12)} is not on ${cfg.branch}; only commits on the branch the repository is connected with are deployed`,
          status: 409,
        };
      }
      commit = ref;
    } else {
      return {
        ok: false,
        error: `Only ${cfg.branch}, or a commit on it, is deployed — not "${ref}"`,
        status: 409,
      };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 502 };
  }

  const read = await readLinkedFile(repo.conn, link.path, commit);
  if (!read.ok) return read;
  const resolved = await resolveFileTargets(userId, read.file);
  if (!resolved.ok) return { ...resolved, status: 422 };
  const changes = definitionChanges(definitionOfRow(row), resolved.def);
  const preview: PullPreview = {
    ok: true,
    path: link.path,
    commit,
    changes,
    renamed: resolved.renamed,
  };
  if (!opts.apply) {
    const invalid = await validateDefinition(userId, resolved.def, workflowId);
    return invalid ? { ok: false, error: invalid, status: 422 } : preview;
  }

  const applied = await applyWorkflowDefinition(userId, workflowId, resolved.def, {
    overwrite: true,
  });
  if (!applied.ok) return { ok: false, error: applied.error, status: 422 };
  const after = await ownWorkflow(userId, workflowId);
  const linkError = await writeLink(userId, workflowId, {
    repo: link.repo,
    path: link.path,
    local_hash: after ? await liveHash(userId, after) : link.local_hash,
    repo_hash: sha256(workflowFileText(read.file)),
    synced_commit: commit,
    synced_by: opts.by,
  });
  auditEvent({
    userId,
    action: opts.by === "ci" ? "workflow.repo.deploy" : "workflow.repo.pull",
    resourceType: "workflow",
    resourceId: workflowId,
    resourceName: resolved.def.name,
    detail: {
      repo: `${cfg.provider}:${cfg.repo}`,
      path: link.path,
      commit,
      changes: {
        added: changes.added.length,
        removed: changes.removed.length,
        changed: changes.changed.length,
        settings: changes.settings,
      },
      ...(linkError ? { link_error: linkError } : {}),
    },
  });
  return preview;
}

// ── Import from repo ────────────────────────────────────────────────────

export type RepoPipelineFile = { path: string; name: string };

/** Pipeline files in the repository's folder that no workflow of the owner keeps. */
export async function unlinkedPipelineFiles(
  userId: string,
): Promise<Fail | { ok: true; commit: string; folder: string; files: RepoPipelineFile[] }> {
  const repo = await repoConnectionOf(userId);
  if (!repo.ok) return repo;
  const { cfg, token, base } = repo.conn;
  try {
    const commit = await branchHead(cfg, token);
    const folder = pipelinesFolder(base);
    const here = repoKey(cfg);
    const linked = new Set(
      (await linksOf(userId)).filter((l) => l.repo === here).map((l) => l.path),
    );
    const files = (await listFolder(cfg, token, folder, commit))
      .filter((f) => f.name.endsWith(".json") && !linked.has(f.path))
      .map((f) => ({ path: f.path, name: f.name.replace(/\.json$/, "") }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, commit, folder, files };
  } catch (e) {
    return { ok: false, error: (e as Error).message, status: 502 };
  }
}

/**
 * Make a new workflow from a file in the repository, kept in that file. It
 * arrives paused: a file with a schedule should not start running the moment
 * it is read, before anybody has looked at it here.
 */
export async function importWorkflowFromRepo(
  userId: string,
  path: string,
  commit: string,
): Promise<Fail | { ok: true; id: string; name: string }> {
  const repo = await repoConnectionOf(userId);
  if (!repo.ok) return repo;
  const { cfg, base } = repo.conn;
  if (
    !path.startsWith(`${pipelinesFolder(base)}/`) ||
    path.includes("..") ||
    !path.endsWith(".json")
  ) {
    return { ok: false, error: `Only files in ${pipelinesFolder(base)} are imported`, status: 400 };
  }
  if (!SHA.test(commit)) return { ok: false, error: "Not a commit", status: 400 };
  const here = repoKey(cfg);
  const taken = (await linksOf(userId)).find((l) => l.repo === here && l.path === path);
  if (taken)
    return { ok: false, error: "A workflow of yours is already kept in that file", status: 409 };

  const read = await readLinkedFile(repo.conn, path, commit);
  if (!read.ok) return read;
  const resolved = await resolveFileTargets(userId, read.file);
  if (!resolved.ok) return resolved;
  const invalid = await validateDefinition(userId, resolved.def, null);
  if (invalid) return { ok: false, error: invalid, status: 422 };

  const def = resolved.def;
  const { data: created, error } = await supabaseAdmin
    .from("workflows")
    .insert({
      user_id: userId,
      name: def.name,
      description: def.description,
      graph: def.graph as unknown as Json,
      schedule: def.schedule,
      cron_expr: def.schedule === "cron" ? def.cronExpr : null,
      timezone: def.timezone,
      overlap: def.overlap,
      notify_on: def.notifyOn,
      timeout_minutes: def.timeoutMinutes,
      params: (def.graph.params ?? []) as unknown as Json,
      is_active: false,
    })
    .select("*")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error:
        error?.code === "23505"
          ? `You already have a workflow named "${def.name}" — rename one of them first`
          : (error?.message ?? "Could not create the workflow"),
    };
  }
  const id = String(created.id);
  const linkError = await writeLink(userId, id, {
    repo: here,
    path,
    local_hash: await liveHash(userId, created as Record<string, unknown>),
    repo_hash: sha256(workflowFileText(read.file)),
    synced_commit: commit,
    synced_by: "import",
  });
  auditEvent({
    userId,
    action: "workflow.repo.import",
    resourceType: "workflow",
    resourceId: id,
    resourceName: def.name,
    detail: {
      repo: `${cfg.provider}:${cfg.repo}`,
      path,
      commit,
      ...(linkError ? { link_error: linkError } : {}),
    },
  });
  return { ok: true, id, name: def.name };
}
