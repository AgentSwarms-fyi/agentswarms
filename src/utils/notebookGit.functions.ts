// Git versioning for notebooks: commit one notebook, list its commits, and
// restore it from any of them.
//
// This reuses the per-user git_export_config (repo, branch, encrypted PAT) that
// BI already uses — one connected repository per user, not one per feature.
// Git holds the versions; notebook_git_versions is just an index into it.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { decryptJson } from "@/utils/providers/crypto.server";
import { auditEvent } from "@/utils/audit.server";
import {
  commitFiles,
  gatherNotebookFiles,
  readFileAtRef,
  type GitExportConfig,
} from "@/utils/git/exporter.server";
import {
  notebookContentHash,
  notebookToScript,
  scriptToCells,
  type NotebookCell,
} from "@/utils/git/notebookSource";

function userClient(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Server is missing Supabase configuration");
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function requireUser(accessToken: string) {
  const sb = userClient(accessToken);
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data.user) throw new Error("Unauthorized");
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

  const enc = row.token_enc as { ciphertext?: string; iv?: string } | null;
  if (!enc?.ciphertext || !enc?.iv) {
    return { ok: false, error: "No access token stored — add one in the Git settings" };
  }
  const { token } = await decryptJson<{ token: string }>(enc.ciphertext, enc.iv);
  return {
    ok: true,
    token,
    cfg: {
      provider: row.provider as GitExportConfig["provider"],
      repo: row.repo,
      branch: row.branch,
      base_path: row.base_path,
      host: row.host,
    },
  };
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

export const nbGitHistory = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
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
  .inputValidator((input: unknown) =>
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

        const files = await gatherNotebookFiles(
          sb,
          userId,
          resolved.cfg.base_path,
          data.notebook_id,
        );
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
  .inputValidator((input: unknown) =>
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

      const script = await readFileAtRef(
        resolved.cfg,
        resolved.token,
        version.file_path,
        version.commit_sha,
      );
      const parsed = scriptToCells(script);
      if (parsed.length === 0) {
        return { ok: false, error: "That commit has no notebook cells in it" };
      }
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
