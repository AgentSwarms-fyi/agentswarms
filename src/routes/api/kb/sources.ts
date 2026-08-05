// POST /api/kb/sources — create or update a KB connector source.
// DELETE /api/kb/sources — remove one (documents go with it by default).
//
// Credentials are encrypted HERE, server-side, with the same crypto the SaaS
// connections use, and never travel back to the browser: every select in this
// file names its columns and none of them is `credentials`. The UI edits a
// source by sending new credentials or omitting them ("keep what's stored").
//
// Auth follows ingest-url.ts exactly: user JWT proves identity, ownership is
// checked explicitly, then a service-role client does the writes.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { encryptJson, decryptJson } from "@/utils/providers/crypto.server";
import { KB_CONNECTORS, isConnectorKind } from "@/utils/kb/connectors.server";
import { nextSyncAt } from "@/utils/kb/sync.server";

const UpsertBody = z.object({
  action: z.literal("upsert"),
  source_id: z.string().uuid().optional(),
  knowledge_base_id: z.string().uuid(),
  kind: z.enum(["gdrive", "notion", "sharepoint", "dropbox"]),
  label: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Omitted on edit = keep the stored credentials. */
  credentials: z.record(z.string(), z.string()).optional(),
  sync_schedule: z.enum(["manual", "hourly", "daily", "weekly"]).default("manual"),
  access_scope: z.enum(["inherit", "private", "source_acl"]).default("inherit"),
});

const DeleteBody = z.object({
  action: z.literal("delete"),
  source_id: z.string().uuid(),
  /**
   * Default true: a synced document's visibility can depend on its source's
   * access_scope, and deleting the source deletes the restriction. Keeping the
   * documents is the explicit choice — they become plain KB documents visible
   * to whoever can see the KB.
   */
  delete_documents: z.boolean().default(true),
});

const Body = z.discriminatedUnion("action", [UpsertBody, DeleteBody]);

const RETURN_COLUMNS =
  "id, knowledge_base_id, kind, label, config, status, error, last_synced_at, last_sync_stats, sync_schedule, next_sync_at, access_scope, created_at, updated_at";

async function requireUserAndAdmin(request: Request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { error: Response.json({ error: "Not signed in" }, { status: 401 }) };

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { error: Response.json({ error: "Backend misconfigured" }, { status: 500 }) };
  }
  const userClient = createClient(supabaseUrl, process.env.SUPABASE_PUBLISHABLE_KEY || "", {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userRes } = await userClient.auth.getUser();
  if (!userRes?.user) {
    return { error: Response.json({ error: "Not signed in" }, { status: 401 }) };
  }
  return { user: userRes.user, admin: createClient(supabaseUrl, serviceKey) };
}

export const Route = createFileRoute("/api/kb/sources")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ctx = await requireUserAndAdmin(request);
        if ("error" in ctx) return ctx.error;
        const { user, admin } = ctx;

        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Invalid request body" },
            { status: 400 },
          );
        }

        if (body.action === "delete") {
          const { data: source } = await admin
            .from("kb_sources")
            .select("id, user_id")
            .eq("id", body.source_id)
            .maybeSingle();
          if (!source || source.user_id !== user.id) {
            return Response.json({ error: "Source not found" }, { status: 404 });
          }
          if (body.delete_documents) {
            const { error: docErr } = await admin
              .from("knowledge_documents")
              .delete()
              .eq("source_id", body.source_id);
            if (docErr) return Response.json({ error: docErr.message }, { status: 500 });
          }
          const { error: delErr } = await admin
            .from("kb_sources")
            .delete()
            .eq("id", body.source_id);
          if (delErr) return Response.json({ error: delErr.message }, { status: 500 });
          return Response.json({ ok: true });
        }

        // upsert
        if (!isConnectorKind(body.kind)) {
          return Response.json({ error: `Unknown connector "${body.kind}"` }, { status: 400 });
        }
        const connector = KB_CONNECTORS[body.kind];

        const { data: kb } = await admin
          .from("knowledge_bases")
          .select("id, user_id")
          .eq("id", body.knowledge_base_id)
          .maybeSingle();
        if (!kb || kb.user_id !== user.id) {
          return Response.json({ error: "Knowledge base not found" }, { status: 404 });
        }

        // Resolve the credentials this save will run with: fresh from the
        // body, or the stored ones on an edit that leaves them untouched.
        let creds = body.credentials ?? null;
        let existing: { id: string; user_id: string | null; credentials: unknown } | null = null;
        if (body.source_id) {
          const { data: row } = await admin
            .from("kb_sources")
            .select("id, user_id, kind, credentials")
            .eq("id", body.source_id)
            .maybeSingle();
          if (!row || row.user_id !== user.id) {
            return Response.json({ error: "Source not found" }, { status: 404 });
          }
          if (row.kind !== body.kind) {
            return Response.json(
              { error: "A source cannot change provider — create a new source instead." },
              { status: 400 },
            );
          }
          existing = row;
          if (!creds) {
            const enc = row.credentials as { ciphertext?: string; iv?: string } | null;
            if (enc?.ciphertext && enc?.iv) {
              try {
                creds = await decryptJson<Record<string, string>>(enc.ciphertext, enc.iv);
              } catch {
                return Response.json(
                  { error: "Stored credentials no longer decrypt — paste them again." },
                  { status: 400 },
                );
              }
            }
          }
        }
        if (!creds) {
          return Response.json({ error: "Credentials are required" }, { status: 400 });
        }

        // Fail at save time, not at 3am on the first scheduled sync.
        const invalid = connector.validate(body.config, creds);
        if (invalid) return Response.json({ error: invalid }, { status: 400 });

        const encrypted = await encryptJson(creds);
        const scheduleFields = {
          sync_schedule: body.sync_schedule,
          next_sync_at: nextSyncAt(body.sync_schedule),
        };

        if (existing) {
          const { data: updated, error: upErr } = await admin
            .from("kb_sources")
            .update({
              label: body.label,
              config: body.config as never,
              credentials: encrypted as never,
              access_scope: body.access_scope,
              ...scheduleFields,
            })
            .eq("id", existing.id)
            .select(RETURN_COLUMNS)
            .single();
          if (upErr || !updated) {
            return Response.json({ error: upErr?.message ?? "update failed" }, { status: 500 });
          }
          return Response.json({ ok: true, source: updated });
        }

        const { data: created, error: insErr } = await admin
          .from("kb_sources")
          .insert({
            knowledge_base_id: body.knowledge_base_id,
            user_id: user.id,
            kind: body.kind,
            label: body.label,
            config: body.config as never,
            credentials: encrypted as never,
            access_scope: body.access_scope,
            status: "idle",
            ...scheduleFields,
          })
          .select(RETURN_COLUMNS)
          .single();
        if (insErr || !created) {
          return Response.json({ error: insErr?.message ?? "insert failed" }, { status: 500 });
        }
        return Response.json({ ok: true, source: created });
      },
    },
  },
});
