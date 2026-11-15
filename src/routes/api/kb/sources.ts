// POST /api/kb/sources — create or update a KB connector source.
// DELETE /api/kb/sources — remove one (documents go with it by default).
//
// Credentials are encrypted HERE, server-side, with the same crypto the SaaS
// connections use, and never travel back to the browser: every select in this
// file names its columns and none of them is `credentials`. The UI edits a
// source by sending the credential fields it changed; a field left out keeps
// what is stored. A credential may be a `{{secret:NAME}}` picked from the
// owner's secrets (R494), resolved at sync time; `action: "credentials"` tells
// the edit form which secret each field names, and never a value.
//
// Auth follows ingest-url.ts exactly: user JWT proves identity, ownership is
// checked explicitly, then a service-role client does the writes.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { encryptJson, decryptJson } from "@/utils/providers/crypto.server";
import { KB_CONNECTORS, isConnectorKind } from "@/utils/kb/connectors.server";
import { nextSyncAt } from "@/utils/kb/sync.server";
import { callerFailure, callerFailureStatus } from "@/utils/callerLookup.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";

const UpsertBody = z.object({
  action: z.literal("upsert"),
  source_id: z.string().uuid().optional(),
  knowledge_base_id: z.string().uuid(),
  kind: z.enum(["gdrive", "notion", "sharepoint", "dropbox", "web", "confluence"]),
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

const CredentialsBody = z.object({
  action: z.literal("credentials"),
  source_id: z.string().uuid(),
});

const Body = z.discriminatedUnion("action", [UpsertBody, DeleteBody, CredentialsBody]);

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
  const userClient = createClient(
    supabaseUrl,
    process.env.SUPABASE_PUBLISHABLE_KEY || "",
    withNulSafeFetch({
      global: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const { data: userRes, error: authError } = await userClient.auth.getUser();
  if (!userRes?.user) {
    return {
      error: Response.json(
        { error: callerFailure(authError, "Not signed in") },
        { status: callerFailureStatus(authError) },
      ),
    };
  }
  return { user: userRes.user, admin: createClient(supabaseUrl, serviceKey, withNulSafeFetch()) };
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

        if (body.action === "credentials") {
          // Which secret each stored field names, and which hold a value typed
          // in before: what the edit form shows as picked, or as a key saved
          // in the field. Names only; a value never leaves the server.
          const { data: source } = await admin
            .from("kb_sources")
            .select("id, user_id, credentials")
            .eq("id", body.source_id)
            .maybeSingle();
          if (!source || source.user_id !== user.id) {
            return Response.json({ error: "Source not found" }, { status: 404 });
          }
          const { encryptedSecretFields } = await import("@/utils/credentialRefs.server");
          return Response.json({ ok: true, ...(await encryptedSecretFields(source.credentials)) });
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
          const enc = row.credentials as {
            ciphertext?: string;
            iv?: string;
            kid?: string;
          } | null;
          if (enc?.ciphertext && enc?.iv) {
            let stored: Record<string, string> | null = null;
            try {
              stored = await decryptJson<Record<string, string>>(enc.ciphertext, enc.iv, enc.kid);
            } catch {
              // Nothing to keep: a full set from the body still saves.
              if (!creds) {
                return Response.json(
                  { error: "Stored credentials no longer decrypt — enter them again." },
                  { status: 400 },
                );
              }
            }
            // R494: the fields sent replace their stored values and the rest
            // are kept, as the form says. Sending only a new token used to
            // replace the whole set, dropping the email or client id beside it.
            if (stored) creds = { ...stored, ...(creds ?? {}) };
          }
        }
        if (!creds) {
          // A website has nothing to paste; everything else does.
          if (connector.credentialless) creds = {};
          else return Response.json({ error: "Credentials are required" }, { status: 400 });
        }

        // Fail at save time, not at 3am on the first scheduled sync.
        const invalid = connector.validate(body.config, creds);
        if (invalid) return Response.json({ error: invalid }, { status: 400 });

        const encrypted = await encryptJson(creds, { owner: user.id });
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
