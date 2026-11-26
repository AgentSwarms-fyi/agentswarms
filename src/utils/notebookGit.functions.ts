// Git versioning for notebooks: commit one notebook, list its commits, and
// restore it from any of them. Since R543 also the other way: import a
// notebook file from the repository (percent .py or Jupyter .ipynb), commit a
// linked notebook back to its own file in its own format, and update it from
// the file at the head of the branch.
//
// This reuses the per-user git_export_config (repo, branch, encrypted PAT) that
// BI already uses — one connected repository per user, not one per feature.
// Git holds the versions; notebook_git_versions is just an index into it.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { gitTokenForUse, storedGitToken } from "@/utils/git/token.server";
import { auditEvent } from "@/utils/audit.server";
import {
  branchHead,
  commitFiles,
  gatherNotebookFiles,
  listFolder,
  readFileAtRef,
  type GitExportConfig,
} from "@/utils/git/exporter.server";
import {
  cellChanges,
  cellsToIpynb,
  notebookFileFormat,
  parseNotebookFile,
  validRepoFolder,
  type CellChanges,
} from "@/lib/notebookFiles";
import {
  notebookContentHash,
  notebookToScript,
  scriptToCells,
  type NotebookCell,
} from "@/utils/git/notebookSource";
import { callerFailure } from "@/utils/callerLookup.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(
    url,
    key,
    withNulSafeFetch({
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Unauthorized"));
  return { sb, userId: data.user.id };
}

type Fail = { ok: false; error: string };

export type NbGitVersion = {
  id: string;
  commit_sha: string;
  commit_url: string | null;
  message: string;
  content_hash: string;
  file_path: string;
  created_at: string;
};

/** Load the caller's git config and decrypt its token, or explain what's missing. */
async function resolveGitConfig(
  sb: ReturnType<typeof userClient>,
  userId: string,
): Promise<{ ok: true; cfg: GitExportConfig; token: string } | Fail> {
  const { data: row, error } = await sb
    .from("git_export_config")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!row) return { ok: false, error: "Connect a Git repository first" };

  const stored = await storedGitToken(row.token_enc);
  if (!stored) {
    return { ok: false, error: "No access token stored — add one in the Git settings" };
  }
  const cfg: GitExportConfig = {
    provider: row.provider as GitExportConfig["provider"],
    repo: row.repo,
    branch: row.branch,
    base_path: row.base_path,
    host: row.host,
  };
  try {
    return { ok: true, token: await gitTokenForUse(userId, cfg, stored), cfg };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "The access token could not be read",
    };
  }
}

/** The notebook's current content hash — what "uncommitted changes" compares against. */
async function liveHash(
  sb: ReturnType<typeof userClient>,
  userId: string,
  notebookId: string,
): Promise<{ hash: string; title: string } | null> {
  const { data } = await sb
    .from("user_python_notebooks")
    .select("id, title, description, cells")
    .eq("id", notebookId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  const script = notebookToScript(Array.isArray(data.cells) ? (data.cells as NotebookCell[]) : [], {
    id: data.id,
    title: data.title,
    description: data.description,
  });
  return { hash: notebookContentHash(script), title: data.title };
}

/** The repository file a notebook is kept in: its newest version's. */
async function linkedPath(
  sb: ReturnType<typeof userClient>,
  userId: string,
  notebookId: string,
): Promise<{ path: string; contentHash: string } | null> {
  const { data } = await sb
    .from("notebook_git_versions")
    .select("file_path, content_hash")
    .eq("notebook_id", notebookId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { path: data.file_path, contentHash: data.content_hash } : null;
}

/**
 * A path the platform chose (`<folder>/notebooks/<title>-<id8>.py`), as
 * against a file the notebook was imported from. Commits of the first keep
 * writing the generated file and its manifest, as they always have; commits
 * of the second go back to that file, in its own format.
 */
function isGeneratedPath(path: string, notebookId: string): boolean {
  return path.endsWith(`-${notebookId.slice(0, 8)}.py`);
}

/** The text a linked file gets: Jupyter for an .ipynb, percent Python otherwise. */
function renderForFile(
  path: string,
  cells: NotebookCell[],
  meta: { id: string; title: string; description: string | null },
): string {
  return notebookFileFormat(path) === "ipynb"
    ? cellsToIpynb(cells, { title: meta.title })
    : notebookToScript(cells, meta);
}

/** Cells from a file at a commit, in the file's own format. */
async function readNotebookAt(
  cfg: GitExportConfig,
  token: string,
  path: string,
  ref: string,
): Promise<Fail | { ok: true; title: string; cells: NotebookCell[] }> {
  const text = await readFileAtRef(cfg, token, path, ref);
  if (notebookFileFormat(path) === "py" && text.includes("# AgentSwarms notebook")) {
    // A file this platform wrote reads back with the parser that wrote it.
    const cells = scriptToCells(text);
    return cells.length
      ? { ok: true, title: "", cells }
      : { ok: false, error: "That file has no notebook cells in it" };
  }
  const parsed = parseNotebookFile(path, text);
  if (!parsed.ok) return parsed;
  if (!parsed.cells.length) return { ok: false, error: "That file has no notebook cells in it" };
  return { ok: true, title: parsed.title, cells: parsed.cells };
}

const SHA = /^[0-9a-f]{7,64}$/i;

export const nbGitHistory = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), notebook_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          connected: boolean;
          repo: string | null;
          branch: string | null;
          versions: NbGitVersion[];
          dirty: boolean;
        }
    > => {
      try {
        const { sb, userId } = await requireUser(data.access_token);

        const { data: cfgRow } = await sb
          .from("git_export_config")
          .select("repo, branch, token_enc")
          .eq("user_id", userId)
          .maybeSingle();

        const { data: rows, error } = await sb
          .from("notebook_git_versions")
          .select("id, commit_sha, commit_url, message, content_hash, file_path, created_at")
          .eq("notebook_id", data.notebook_id)
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) return { ok: false, error: error.message };

        const versions = (rows ?? []) as NbGitVersion[];
        const live = await liveHash(sb, userId, data.notebook_id);
        // No commits yet means everything is uncommitted, not "clean".
        const dirty = live
          ? versions.length === 0 || versions[0].content_hash !== live.hash
          : false;

        return {
          ok: true,
          connected: Boolean(cfgRow?.repo && cfgRow?.token_enc),
          repo: cfgRow?.repo ?? null,
          branch: cfgRow?.branch ?? null,
          versions,
          dirty,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

export const nbGitCommit = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        notebook_id: z.string().uuid(),
        message: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; commit_url: string; sha: string; files: number }> => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        const resolved = await resolveGitConfig(sb, userId);
        if (!resolved.ok) return resolved;

        // A notebook imported from a file goes back to that file, in its
        // own format (R543); one the platform created keeps its generated
        // file and manifest.
        const linked = await linkedPath(sb, userId, data.notebook_id);
        let files: { path: string; content: string }[];
        if (linked && !isGeneratedPath(linked.path, data.notebook_id)) {
          const { data: nb } = await sb
            .from("user_python_notebooks")
            .select("id, title, description, cells")
            .eq("id", data.notebook_id)
            .eq("user_id", userId)
            .maybeSingle();
          if (!nb) return { ok: false, error: "Notebook not found" };
          const cells = Array.isArray(nb.cells) ? (nb.cells as NotebookCell[]) : [];
          files = [
            {
              path: linked.path,
              content: renderForFile(linked.path, cells, {
                id: nb.id,
                title: nb.title,
                description: nb.description,
              }),
            },
          ];
        } else {
          files = await gatherNotebookFiles(sb, userId, resolved.cfg.base_path, data.notebook_id);
        }
        if (files.length === 0) return { ok: false, error: "Notebook not found" };

        const live = await liveHash(sb, userId, data.notebook_id);
        const title = live?.title ?? "notebook";
        const message =
          data.message?.trim() || `chore(agentswarms): update notebook "${title.slice(0, 80)}"`;

        const res = await commitFiles(resolved.cfg, resolved.token, files, message);

        const { error: insErr } = await sb.from("notebook_git_versions").insert({
          user_id: userId,
          notebook_id: data.notebook_id,
          commit_sha: res.sha,
          commit_url: res.commitUrl,
          message,
          content_hash: live?.hash ?? "",
          // The .py file, not the manifest — that's what a restore reads back.
          file_path: files[0].path,
          provider: resolved.cfg.provider,
          repo: resolved.cfg.repo,
          branch: resolved.cfg.branch,
        });
        if (insErr) return { ok: false, error: insErr.message };

        auditEvent({
          userId,
          action: "notebook.git_commit",
          resourceType: "user_python_notebooks",
          resourceId: data.notebook_id,
          resourceName: title,
          detail: { commit: res.commitUrl, repo: resolved.cfg.repo, branch: resolved.cfg.branch },
        });

        return { ok: true, commit_url: res.commitUrl, sha: res.sha, files: res.files };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Commit failed" };
      }
    },
  );

export const nbGitRestore = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        notebook_id: z.string().uuid(),
        version_id: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; cells: number }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const resolved = await resolveGitConfig(sb, userId);
      if (!resolved.ok) return resolved;

      const { data: version } = await sb
        .from("notebook_git_versions")
        .select("commit_sha, file_path, notebook_id")
        .eq("id", data.version_id)
        .eq("user_id", userId)
        .eq("notebook_id", data.notebook_id)
        .maybeSingle();
      if (!version) return { ok: false, error: "Version not found" };

      const read = await readNotebookAt(
        resolved.cfg,
        resolved.token,
        version.file_path,
        version.commit_sha,
      );
      if (!read.ok) return { ok: false, error: read.error.replace("file", "commit") };
      const parsed = read.cells;
      // Fresh ids: the editor keys cells by id, and reusing ids from a file that
      // may have been hand-edited in git would collide with the live notebook.
      const cells = parsed.map((c) => ({ ...c, id: crypto.randomUUID() }));

      const { error } = await sb
        .from("user_python_notebooks")
        .update({
          cells:
            cells as unknown as Database["public"]["Tables"]["user_python_notebooks"]["Update"]["cells"],
        })
        .eq("id", data.notebook_id)
        .eq("user_id", userId);
      if (error) return { ok: false, error: error.message };

      auditEvent({
        userId,
        action: "notebook.git_restore",
        resourceType: "user_python_notebooks",
        resourceId: data.notebook_id,
        detail: { commit: version.commit_sha, cells: cells.length },
      });

      return { ok: true, cells: cells.length };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Restore failed" };
    }
  });

// ── From the repository (R543) ──────────────────────────────────────────

export type NbRepoFile = {
  path: string;
  name: string;
  format: "py" | "ipynb";
  /** The notebook of the caller's already kept in this file, if any. */
  notebookId: string | null;
};

/** Notebook files in one folder of the repository, at the head of the branch. */
export const nbGitRepoFiles = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({ access_token: z.string().min(1), folder: z.string().max(300).optional() })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; commit: string; folder: string; files: NbRepoFile[] }> => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        const resolved = await resolveGitConfig(sb, userId);
        if (!resolved.ok) return resolved;
        const base = (resolved.cfg.base_path || "agentswarms").replace(/^\/+|\/+$/g, "");
        const folder = (data.folder?.trim() || `${base}/notebooks`).replace(/^\/+|\/+$/g, "");
        if (!validRepoFolder(folder)) {
          return { ok: false, error: "That is not a folder in the repository" };
        }
        const commit = await branchHead(resolved.cfg, resolved.token);
        const found = (await listFolder(resolved.cfg, resolved.token, folder, commit))
          .map((f) => ({ ...f, format: notebookFileFormat(f.path) }))
          .filter((f): f is { name: string; path: string; format: "py" | "ipynb" } =>
            Boolean(f.format),
          );
        const { data: kept } = found.length
          ? await sb
              .from("notebook_git_versions")
              .select("notebook_id, file_path, created_at")
              .eq("user_id", userId)
              .in(
                "file_path",
                found.map((f) => f.path),
              )
              .order("created_at", { ascending: false })
          : { data: [] as { notebook_id: string; file_path: string }[] };
        const keptBy = new Map<string, string>();
        for (const k of kept ?? [])
          if (!keptBy.has(k.file_path)) keptBy.set(k.file_path, k.notebook_id);
        return {
          ok: true,
          commit,
          folder,
          files: found
            .map((f) => ({ ...f, notebookId: keptBy.get(f.path) ?? null }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Could not list the folder" };
      }
    },
  );

/** A new notebook from a file in the repository, kept in that file. */
export const nbGitImport = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        path: z.string().min(1).max(400),
        commit: z.string().regex(SHA),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; notebook_id: string; cells: number }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const resolved = await resolveGitConfig(sb, userId);
      if (!resolved.ok) return resolved;
      const path = data.path.trim().replace(/^\/+/, "");
      const folder = path.split("/").slice(0, -1).join("/");
      if (!notebookFileFormat(path) || (folder && !validRepoFolder(folder))) {
        return { ok: false, error: "Only .py and .ipynb files in the repository are imported" };
      }
      const read = await readNotebookAt(resolved.cfg, resolved.token, path, data.commit);
      if (!read.ok) return read;
      const title = (read.title || path.split("/").pop() || "Notebook").slice(0, 200);
      const description = `From ${path} in ${resolved.cfg.repo}`.slice(0, 500);
      const cells = read.cells.map((c) => ({ ...c, id: crypto.randomUUID() }));
      const { data: nb, error } = await sb
        .from("user_python_notebooks")
        .insert({
          user_id: userId,
          title,
          description,
          cells:
            cells as unknown as Database["public"]["Tables"]["user_python_notebooks"]["Insert"]["cells"],
        })
        .select("id")
        .single();
      if (error || !nb)
        return { ok: false, error: error?.message ?? "Could not create the notebook" };
      // The hash the editor compares against: this notebook as it is now, so
      // a fresh import reads "no uncommitted changes".
      const hash = notebookContentHash(notebookToScript(cells, { id: nb.id, title, description }));
      const { error: verErr } = await sb.from("notebook_git_versions").insert({
        user_id: userId,
        notebook_id: nb.id,
        commit_sha: data.commit,
        commit_url: null,
        message: `Imported from ${path}`,
        content_hash: hash,
        file_path: path,
        provider: resolved.cfg.provider,
        repo: resolved.cfg.repo,
        branch: resolved.cfg.branch,
      });
      if (verErr) {
        return {
          ok: false,
          error: `The notebook was created, but its link to ${path} could not be recorded: ${verErr.message}`,
        };
      }
      auditEvent({
        userId,
        action: "notebook.git_import",
        resourceType: "user_python_notebooks",
        resourceId: nb.id,
        resourceName: title,
        detail: { repo: resolved.cfg.repo, path, commit: data.commit, cells: cells.length },
      });
      return { ok: true, notebook_id: nb.id, cells: cells.length };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Import failed" };
    }
  });

/** What updating a notebook from its file at the head of the branch would change. */
export const nbGitPullPreview = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), notebook_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          path: string;
          commit: string;
          changes: CellChanges;
          /** Edits made here since the last commit, which an update replaces. */
          dirty: boolean;
        }
    > => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        const resolved = await resolveGitConfig(sb, userId);
        if (!resolved.ok) return resolved;
        const linked = await linkedPath(sb, userId, data.notebook_id);
        if (!linked) {
          return {
            ok: false,
            error: "This notebook is not in the repository yet: commit it, or import it from there",
          };
        }
        const { data: nb } = await sb
          .from("user_python_notebooks")
          .select("id, cells")
          .eq("id", data.notebook_id)
          .eq("user_id", userId)
          .maybeSingle();
        if (!nb) return { ok: false, error: "Notebook not found" };
        const commit = await branchHead(resolved.cfg, resolved.token);
        const read = await readNotebookAt(resolved.cfg, resolved.token, linked.path, commit);
        if (!read.ok) return read;
        const live = await liveHash(sb, userId, data.notebook_id);
        return {
          ok: true,
          path: linked.path,
          commit,
          changes: cellChanges(
            Array.isArray(nb.cells) ? (nb.cells as NotebookCell[]) : [],
            read.cells,
          ),
          dirty: Boolean(live && live.hash !== linked.contentHash),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed";
        return {
          ok: false,
          error: /\b404\b/.test(msg) ? "The notebook's file is not on the branch any more" : msg,
        };
      }
    },
  );

/** Make the notebook its file at the commit the preview read. */
export const nbGitPull = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        notebook_id: z.string().uuid(),
        commit: z.string().regex(SHA),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; cells: number }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const resolved = await resolveGitConfig(sb, userId);
      if (!resolved.ok) return resolved;
      const linked = await linkedPath(sb, userId, data.notebook_id);
      if (!linked) return { ok: false, error: "This notebook is not in the repository yet" };
      const read = await readNotebookAt(resolved.cfg, resolved.token, linked.path, data.commit);
      if (!read.ok) return read;
      const cells = read.cells.map((c) => ({ ...c, id: crypto.randomUUID() }));
      const { data: nb, error } = await sb
        .from("user_python_notebooks")
        .update({
          cells:
            cells as unknown as Database["public"]["Tables"]["user_python_notebooks"]["Update"]["cells"],
        })
        .eq("id", data.notebook_id)
        .eq("user_id", userId)
        .select("id, title, description")
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!nb) return { ok: false, error: "Notebook not found" };
      const hash = notebookContentHash(
        notebookToScript(cells, { id: nb.id, title: nb.title, description: nb.description }),
      );
      const { error: verErr } = await sb.from("notebook_git_versions").insert({
        user_id: userId,
        notebook_id: data.notebook_id,
        commit_sha: data.commit,
        commit_url: null,
        message: `Updated from ${resolved.cfg.branch} at ${data.commit.slice(0, 7)}`,
        content_hash: hash,
        file_path: linked.path,
        provider: resolved.cfg.provider,
        repo: resolved.cfg.repo,
        branch: resolved.cfg.branch,
      });
      if (verErr) {
        return {
          ok: false,
          error: `The notebook was updated, but the version could not be recorded: ${verErr.message}`,
        };
      }
      auditEvent({
        userId,
        action: "notebook.git_pull",
        resourceType: "user_python_notebooks",
        resourceId: data.notebook_id,
        resourceName: nb.title,
        detail: {
          repo: resolved.cfg.repo,
          path: linked.path,
          commit: data.commit,
          cells: cells.length,
        },
      });
      return { ok: true, cells: cells.length };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Update failed" };
    }
  });
