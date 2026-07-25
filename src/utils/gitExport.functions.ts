// Server functions for Git-based versioning: configure a GitHub/GitLab repo and
// export BI dashboards + semantic models as sanitized JSON in one commit. The
// access token is AES-GCM encrypted at rest and never returned to the client.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { encryptJson, decryptJson } from "@/utils/providers/crypto.server";
import { auditEvent } from "@/utils/audit.server";
import { runGitExport, type GitExportConfig } from "@/utils/git/exporter.server";

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

type GitError = { ok: false; error: string };

/** Non-secret config for the client (token presence only, never the token). */
export const gitGetConfig = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | GitError
      | {
          ok: true;
          config: {
            provider: string;
            repo: string;
            branch: string;
            base_path: string;
            host: string | null;
            has_token: boolean;
            last_export_at: string | null;
            last_status: string | null;
            last_error: string | null;
          } | null;
        }
    > => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        const { data: row, error } = await sb
          .from("git_export_config")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();
        if (error) return { ok: false, error: error.message };
        if (!row) return { ok: true, config: null };
        return {
          ok: true,
          config: {
            provider: row.provider,
            repo: row.repo,
            branch: row.branch,
            base_path: row.base_path,
            host: row.host,
            has_token: Boolean(row.token_enc),
            last_export_at: row.last_export_at,
            last_status: row.last_status,
            last_error: row.last_error,
          },
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );

export const gitSaveConfig = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        provider: z.enum(["github", "gitlab"]),
        repo: z.string().min(1).max(255),
        branch: z.string().min(1).max(255),
        base_path: z.string().max(255).optional(),
        host: z.string().url().max(255).optional().or(z.literal("")),
        // Omit to keep the existing token; empty string clears it.
        token: z.string().max(4096).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<GitError | { ok: true }> => {
    try {
      const { sb, userId } = await requireUser(data.access_token);
      const { data: existing } = await sb
        .from("git_export_config")
        .select("token_enc")
        .eq("user_id", userId)
        .maybeSingle();

      let token_enc = existing?.token_enc ?? null;
      if (data.token !== undefined) {
        token_enc = data.token
          ? ((await encryptJson({
              token: data.token,
            })) as unknown as Database["public"]["Tables"]["git_export_config"]["Row"]["token_enc"])
          : null;
      }

      const { error } = await sb.from("git_export_config").upsert(
        {
          user_id: userId,
          provider: data.provider,
          repo: data.repo.trim(),
          branch: data.branch.trim(),
          base_path: (data.base_path?.trim() || "agentswarms").replace(/^\/+|\/+$/g, ""),
          host: data.host?.trim() || null,
          token_enc,
        },
        { onConflict: "user_id" },
      );
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Failed" };
    }
  });

export const gitExportNow = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(
    async ({ data }): Promise<GitError | { ok: true; commit_url: string; files: number }> => {
      try {
        const { sb, userId } = await requireUser(data.access_token);
        const { data: row, error } = await sb
          .from("git_export_config")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();
        if (error) return { ok: false, error: error.message };
        if (!row) return { ok: false, error: "Configure a Git repository first" };

        const enc = row.token_enc as { ciphertext?: string; iv?: string } | null;
        if (!enc?.ciphertext || !enc?.iv) {
          return { ok: false, error: "No access token stored — add one in the Git settings" };
        }
        const { token } = await decryptJson<{ token: string }>(enc.ciphertext, enc.iv);

        const cfg: GitExportConfig = {
          provider: row.provider as GitExportConfig["provider"],
          repo: row.repo,
          branch: row.branch,
          base_path: row.base_path,
          host: row.host,
        };

        try {
          const res = await runGitExport(sb, userId, cfg, token);
          await sb
            .from("git_export_config")
            .update({
              last_export_at: new Date().toISOString(),
              last_status: "ok",
              last_error: null,
            })
            .eq("user_id", userId);
          auditEvent({
            userId,
            action: "git.export",
            resourceType: "git_export_config",
            resourceName: `${cfg.provider}:${cfg.repo}`,
            detail: { files: res.files, commit: res.commitUrl },
          });
          return { ok: true, commit_url: res.commitUrl, files: res.files };
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Export failed";
          await sb
            .from("git_export_config")
            .update({ last_status: "error", last_error: msg })
            .eq("user_id", userId);
          return { ok: false, error: msg };
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Failed" };
      }
    },
  );
