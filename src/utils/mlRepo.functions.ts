// What ML pipelines and Integrations → Git repository ask of the team's
// repository (R541): which pipelines are kept there and whether either side
// changed since, Save to repo, Update from repo (preview, then apply the
// commit that was previewed), Import from repo, and a connection check.
//
// Every one re-resolves the caller and works only on the caller's own
// workflows and the caller's own repository settings.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure } from "@/utils/callerLookup.server";
import { repoFileUrl, type DefinitionChanges } from "@/lib/workflowFile";

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Not signed in"));
  return data.user.id;
}

type Fail = { ok: false; error: string };
const fail = (r: { error: string }): Fail => ({ ok: false, error: r.error });

export type RepoSummary = {
  provider: "github" | "gitlab";
  repo: string;
  branch: string;
  folder: string;
  host: string | null;
  hasToken: boolean;
};

export type RepoLinkView = {
  workflowId: string;
  path: string;
  /** The file on the provider's site, at the branch. */
  url: string;
  syncedAt: string;
  syncedBy: string;
  commit: string | null;
  /** The workflow was edited here after the last save or update. */
  changedHere: boolean;
};

export const mlRepoOverview = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          repo: RepoSummary | null;
          links: RepoLinkView[];
          /** Why which pipelines are kept could not be read (the repository is still shown). */
          linksError?: string;
        }
    > => {
      const userId = await resolveCaller(data.accessToken);
      const { data: cfg, error } = await supabaseAdmin
        .from("git_export_config")
        .select("provider, repo, branch, base_path, host, token_enc")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) {
        return { ok: false, error: `Could not read the repository settings: ${error.message}` };
      }
      const repo: RepoSummary | null = cfg
        ? {
            provider: cfg.provider as RepoSummary["provider"],
            repo: cfg.repo,
            branch: cfg.branch,
            folder: cfg.base_path,
            host: cfg.host,
            hasToken: Boolean((cfg.token_enc as { ciphertext?: string } | null)?.ciphertext),
          }
        : null;
      const { linksOf, liveHash } = await import("@/utils/mlRepo.server");
      let links;
      try {
        links = await linksOf(userId);
      } catch (e) {
        // FOUND FROM THE UI (R541): an error here hid the repository bar,
        // and with it the hint that says where to connect one.
        return { ok: true, repo, links: [], linksError: (e as Error).message };
      }
      if (!links.length) return { ok: true, repo, links: [] };
      const { data: rows } = await supabaseAdmin
        .from("workflows")
        .select("*")
        .eq("user_id", userId)
        .in(
          "id",
          links.map((l) => l.workflow_id),
        );
      const byId = new Map((rows ?? []).map((r) => [String(r.id), r as Record<string, unknown>]));
      const views: RepoLinkView[] = [];
      for (const l of links) {
        const row = byId.get(l.workflow_id);
        if (!row) continue;
        views.push({
          workflowId: l.workflow_id,
          path: l.path,
          url: repo ? repoFileUrl(repo, l.path) : "",
          syncedAt: l.synced_at,
          syncedBy: l.synced_by,
          commit: l.synced_commit,
          changedHere: (await liveHash(userId, row)) !== l.local_hash,
        });
      }
      return { ok: true, repo, links: views };
    },
  );

export const mlRepoSave = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        workflowId: z.string().uuid(),
        message: z.string().trim().max(500).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      Fail | { ok: true; path: string; commit: string; commitUrl: string; files: number }
    > => {
      const userId = await resolveCaller(data.accessToken);
      const { saveWorkflowToRepo } = await import("@/utils/mlRepo.server");
      const res = await saveWorkflowToRepo(userId, data.workflowId, data.message);
      return res.ok ? res : fail(res);
    },
  );

export const mlRepoPullPreview = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), workflowId: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      Fail | { ok: true; path: string; commit: string; changes: DefinitionChanges; renamed: number }
    > => {
      const userId = await resolveCaller(data.accessToken);
      const { pullWorkflowFromRepo } = await import("@/utils/mlRepo.server");
      const res = await pullWorkflowFromRepo(userId, data.workflowId, { apply: false, by: "pull" });
      return res.ok ? res : fail(res);
    },
  );

export const mlRepoPull = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        workflowId: z.string().uuid(),
        // The commit the preview read, so what is applied is what was shown.
        commit: z.string().regex(/^[0-9a-f]{7,64}$/i),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<Fail | { ok: true; commit: string; changes: DefinitionChanges }> => {
      const userId = await resolveCaller(data.accessToken);
      const { pullWorkflowFromRepo } = await import("@/utils/mlRepo.server");
      const res = await pullWorkflowFromRepo(userId, data.workflowId, {
        ref: data.commit,
        apply: true,
        by: "pull",
      });
      return res.ok ? { ok: true, commit: res.commit, changes: res.changes } : fail(res);
    },
  );

export const mlRepoFiles = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      Fail | { ok: true; commit: string; folder: string; files: { path: string; name: string }[] }
    > => {
      const userId = await resolveCaller(data.accessToken);
      const { unlinkedPipelineFiles } = await import("@/utils/mlRepo.server");
      const res = await unlinkedPipelineFiles(userId);
      return res.ok ? res : fail(res);
    },
  );

export const mlRepoImport = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        path: z.string().min(1).max(400),
        commit: z.string().regex(/^[0-9a-f]{7,64}$/i),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; id: string; name: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const { importWorkflowFromRepo } = await import("@/utils/mlRepo.server");
    const res = await importWorkflowFromRepo(userId, data.path, data.commit);
    return res.ok ? res : fail(res);
  });

/** Integrations → Git repository: can the saved settings reach the branch? */
export const gitCheckConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<Fail | { ok: true; branch: string; commit: string }> => {
    const userId = await resolveCaller(data.accessToken);
    const { repoConnectionOf } = await import("@/utils/mlRepo.server");
    const repo = await repoConnectionOf(userId);
    if (!repo.ok) return fail(repo);
    const { branchHead } = await import("@/utils/git/exporter.server");
    try {
      const commit = await branchHead(repo.conn.cfg, repo.conn.token);
      return { ok: true, branch: repo.conn.cfg.branch, commit };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
