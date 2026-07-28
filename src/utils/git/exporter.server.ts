// Git export: serialize BI dashboards, semantic models and published notebooks
// and commit them to a GitHub or GitLab repo in a single commit. Definitions
// only — widget data snapshots (`rows`) are stripped so no warehouse DATA is
// written to git; the access token is passed in already-decrypted and is never
// logged.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { isBlockedAlways } from "@/utils/ssrfGuard.server";
import { notebookFilePath, notebookToScript, type NotebookCell } from "@/utils/git/notebookSource";

export type GitProvider = "github" | "gitlab";

export type GitExportConfig = {
  provider: GitProvider;
  repo: string;
  branch: string;
  base_path: string;
  host?: string | null;
};

export type ExportFile = { path: string; content: string };

export type CommitResult = { commitUrl: string; sha: string; files: number };

/** GitLab API base, SSRF-checked because a self-hosted host is user-supplied. */
function gitlabBase(cfg: GitExportConfig): string {
  const base = (cfg.host?.trim() || "https://gitlab.com").replace(/\/+$/, "");
  try {
    if (isBlockedAlways(new URL(base).hostname)) {
      throw new Error("GitLab: refusing to connect to a blocked host");
    }
  } catch {
    throw new Error("GitLab: invalid host URL");
  }
  return base;
}

function gitlabProjectId(cfg: GitExportConfig): string {
  return encodeURIComponent(cfg.repo.replace(/^\/+|\/+$/g, ""));
}

/** Decode base64 (as GitHub returns file contents) into a UTF-8 string. */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Slug for a filename component. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "item"
  );
}

/** Drop widget row-snapshots (actual data) from a dashboard, keeping the
 *  definition (sql, chart, columns, source kind, layout, theme, filters). */
function stripWidgetRows(widgets: unknown): unknown {
  if (!Array.isArray(widgets)) return widgets;
  return widgets.map((w) => {
    if (!w || typeof w !== "object") return w;
    const { rows: _rows, ...rest } = w as Record<string, unknown>;
    return rest;
  });
}

function sanitizeDashboard(row: Record<string, unknown>): Record<string, unknown> {
  const pages = Array.isArray(row.pages)
    ? (row.pages as Record<string, unknown>[]).map((p) => ({
        ...p,
        widgets: stripWidgetRows((p as { widgets?: unknown }).widgets),
      }))
    : row.pages;
  return {
    kind: "bi_dashboard",
    id: row.id,
    name: row.name,
    description: row.description,
    widgets: stripWidgetRows(row.widgets),
    layout: row.layout,
    pages,
    filters: row.filters,
    theme: row.theme,
    ai_model: row.ai_model,
    exported_at: new Date().toISOString(),
  };
}

function sanitizeModel(row: Record<string, unknown>): Record<string, unknown> {
  // Semantic models are pure definitions (no secrets); export the row minus the
  // owner id + housekeeping timestamps.
  const { user_id: _u, created_at: _c, updated_at: _up, ...rest } = row;
  return { kind: "semantic_model", ...rest, exported_at: new Date().toISOString() };
}

/**
 * Files for one notebook: the source as a percent-format Python script, plus a
 * sidecar manifest describing how it is published.
 *
 * The manifest carries key *prefixes* only — never a hash, never a plaintext
 * key. It exists so a reviewer can see that this file is a live endpoint and
 * which function answers it, which is the thing you actually want in review.
 */
export function notebookExportFiles(
  basePath: string,
  nb: { id: string; title: string; description: string | null; cells: unknown },
  keys: { name: string; key_prefix: string; entrypoint: string; revoked_at: string | null }[],
): ExportFile[] {
  const cells = Array.isArray(nb.cells) ? (nb.cells as NotebookCell[]) : [];
  const scriptPath = notebookFilePath(basePath, nb.title, nb.id);
  const script = notebookToScript(cells, {
    id: nb.id,
    title: nb.title,
    description: nb.description,
  });

  const live = keys.filter((k) => !k.revoked_at);
  const manifest = {
    kind: "notebook",
    id: nb.id,
    title: nb.title,
    description: nb.description,
    source: scriptPath.split("/").pop(),
    cells: cells.length,
    published: live.length > 0,
    // Sorted so the file is byte-stable between exports that changed nothing.
    api_keys: live
      .map((k) => ({
        name: k.name,
        key_prefix: k.key_prefix,
        entrypoint: k.entrypoint || null,
      }))
      .sort((a, b) => a.key_prefix.localeCompare(b.key_prefix)),
  };

  return [
    { path: scriptPath, content: script },
    { path: scriptPath.replace(/\.py$/, ".json"), content: JSON.stringify(manifest, null, 2) },
  ];
}

/**
 * Published notebooks — those with at least one live API key. An unpublished
 * notebook is a scratchpad; a published one is a running endpoint, and that is
 * what belongs in the repo alongside the rest of your code.
 */
export async function gatherNotebookFiles(
  sb: SupabaseClient<Database>,
  userId: string,
  basePath: string,
  notebookId?: string,
): Promise<ExportFile[]> {
  const base = basePath.replace(/^\/+|\/+$/g, "") || "agentswarms";

  let q = sb
    .from("user_python_notebooks")
    .select("id, title, description, cells")
    .eq("user_id", userId);
  if (notebookId) q = q.eq("id", notebookId);
  const { data: notebooks, error } = await q;
  if (error) throw new Error(error.message);
  if (!notebooks?.length) return [];

  const { data: keys, error: kErr } = await sb
    .from("notebook_api_keys")
    .select("notebook_id, name, key_prefix, entrypoint, revoked_at")
    .eq("user_id", userId)
    .in(
      "notebook_id",
      notebooks.map((n) => n.id),
    );
  if (kErr) throw new Error(kErr.message);

  const byNotebook = new Map<string, NonNullable<typeof keys>>();
  for (const k of keys ?? []) {
    const list = byNotebook.get(k.notebook_id) ?? [];
    list.push(k);
    byNotebook.set(k.notebook_id, list);
  }

  const files: ExportFile[] = [];
  for (const nb of notebooks) {
    const nbKeys = byNotebook.get(nb.id) ?? [];
    // An explicit single-notebook commit exports it whether or not it is
    // published; a bulk sync only picks up the published ones.
    if (!notebookId && !nbKeys.some((k) => !k.revoked_at)) continue;
    files.push(...notebookExportFiles(base, nb, nbKeys));
  }
  return files;
}

/** Collect the sanitized files to write (owned dashboards + semantic models). */
export async function gatherExportFiles(
  sb: SupabaseClient<Database>,
  userId: string,
  basePath: string,
): Promise<ExportFile[]> {
  const base = basePath.replace(/^\/+|\/+$/g, "") || "agentswarms";
  const files: ExportFile[] = [];

  const { data: dashboards, error: dErr } = await sb
    .from("bi_dashboards")
    .select("*")
    .eq("user_id", userId);
  if (dErr) throw new Error(dErr.message);
  for (const d of dashboards ?? []) {
    const doc = sanitizeDashboard(d as Record<string, unknown>);
    files.push({
      path: `${base}/dashboards/${slug(String(d.name))}-${String(d.id).slice(0, 8)}.json`,
      content: JSON.stringify(doc, null, 2),
    });
  }

  const { data: models, error: mErr } = await sb
    .from("semantic_models")
    .select("*")
    .eq("user_id", userId);
  if (mErr) throw new Error(mErr.message);
  for (const m of models ?? []) {
    const doc = sanitizeModel(m as Record<string, unknown>);
    files.push({
      path: `${base}/semantic-models/${slug(String(m.name))}-${String(m.id).slice(0, 8)}.json`,
      content: JSON.stringify(doc, null, 2),
    });
  }

  files.push(...(await gatherNotebookFiles(sb, userId, base)));

  return files;
}

async function ghFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentswarms",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

async function ghError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { message?: string };
  return `GitHub ${res.status}: ${j.message ?? res.statusText}`;
}

/** Single-commit export via the GitHub Git Data API. */
async function commitToGitHub(
  cfg: GitExportConfig,
  token: string,
  files: ExportFile[],
  message: string,
): Promise<CommitResult> {
  const api = "https://api.github.com";
  const repo = cfg.repo.replace(/^\/+|\/+$/g, "");
  const branch = cfg.branch;

  const refRes = await ghFetch(
    `${api}/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    token,
  );
  if (refRes.status === 404) {
    throw new Error(`GitHub: branch "${branch}" not found — create it in the repo first`);
  }
  if (!refRes.ok) throw new Error(await ghError(refRes));
  const ref = (await refRes.json()) as { object: { sha: string } };
  const baseSha = ref.object.sha;

  const commitRes = await ghFetch(`${api}/repos/${repo}/git/commits/${baseSha}`, token);
  if (!commitRes.ok) throw new Error(await ghError(commitRes));
  const baseCommit = (await commitRes.json()) as { tree: { sha: string } };

  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const f of files) {
    const blobRes = await ghFetch(`${api}/repos/${repo}/git/blobs`, token, {
      method: "POST",
      body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
    });
    if (!blobRes.ok) throw new Error(await ghError(blobRes));
    const blob = (await blobRes.json()) as { sha: string };
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeRes = await ghFetch(`${api}/repos/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  if (!treeRes.ok) throw new Error(await ghError(treeRes));
  const newTree = (await treeRes.json()) as { sha: string };

  const newCommitRes = await ghFetch(`${api}/repos/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
  });
  if (!newCommitRes.ok) throw new Error(await ghError(newCommitRes));
  const newCommit = (await newCommitRes.json()) as { sha: string; html_url?: string };

  const updateRes = await ghFetch(
    `${api}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    token,
    { method: "PATCH", body: JSON.stringify({ sha: newCommit.sha }) },
  );
  if (!updateRes.ok) throw new Error(await ghError(updateRes));

  return {
    commitUrl: newCommit.html_url ?? `https://github.com/${repo}/commit/${newCommit.sha}`,
    sha: newCommit.sha,
    files: files.length,
  };
}

/** Single-commit export via the GitLab Commits API (one action per file). */
async function commitToGitLab(
  cfg: GitExportConfig,
  token: string,
  files: ExportFile[],
  message: string,
): Promise<CommitResult> {
  const base = gitlabBase(cfg);
  const projectId = gitlabProjectId(cfg);
  const headers = { "PRIVATE-TOKEN": token, "Content-Type": "application/json" };

  // Determine create vs update per file (GitLab has no upsert action).
  const actions = [];
  for (const f of files) {
    const check = await fetch(
      `${base}/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(cfg.branch)}`,
      { method: "HEAD", headers: { "PRIVATE-TOKEN": token } },
    );
    actions.push({
      action: check.ok ? "update" : "create",
      file_path: f.path,
      content: f.content,
    });
  }

  const res = await fetch(`${base}/api/v4/projects/${projectId}/repository/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({ branch: cfg.branch, commit_message: message, actions }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(
      `GitLab ${res.status}: ${typeof j.message === "string" ? j.message : res.statusText}`,
    );
  }
  const commit = (await res.json()) as { web_url?: string; id: string };
  return {
    commitUrl: commit.web_url ?? `${base}/${cfg.repo}/-/commit/${commit.id}`,
    sha: commit.id,
    files: files.length,
  };
}

/** Commit a set of files in one commit, whichever provider is configured. */
export async function commitFiles(
  cfg: GitExportConfig,
  token: string,
  files: ExportFile[],
  message: string,
): Promise<CommitResult> {
  return cfg.provider === "github"
    ? commitToGitHub(cfg, token, files, message)
    : commitToGitLab(cfg, token, files, message);
}

/**
 * Read one file as it was at a given ref — how a restore gets the old content
 * back. Git stays the source of truth: nothing about a past version is kept
 * here beyond the sha needed to ask for it.
 */
export async function readFileAtRef(
  cfg: GitExportConfig,
  token: string,
  path: string,
  ref: string,
): Promise<string> {
  if (cfg.provider === "github") {
    const repo = cfg.repo.replace(/^\/+|\/+$/g, "");
    const res = await ghFetch(
      `https://api.github.com/repos/${repo}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (!res.ok) throw new Error(await ghError(res));
    const j = (await res.json()) as { content?: string; encoding?: string };
    if (!j.content) throw new Error("GitHub returned no file content");
    return decodeBase64Utf8(j.content);
  }

  const base = gitlabBase(cfg);
  const res = await fetch(
    `${base}/api/v4/projects/${gitlabProjectId(cfg)}/repository/files/${encodeURIComponent(
      path,
    )}/raw?ref=${encodeURIComponent(ref)}`,
    { headers: { "PRIVATE-TOKEN": token } },
  );
  if (!res.ok) throw new Error(`GitLab ${res.status}: ${res.statusText}`);
  return res.text();
}

export async function runGitExport(
  sb: SupabaseClient<Database>,
  userId: string,
  cfg: GitExportConfig,
  token: string,
): Promise<{ commitUrl: string; files: number }> {
  const files = await gatherExportFiles(sb, userId, cfg.base_path);
  if (files.length === 0)
    throw new Error(
      "Nothing to export yet — create a dashboard, model or published notebook first",
    );
  return commitFiles(cfg, token, files, `chore(agentswarms): export ${files.length} artifact(s)`);
}
