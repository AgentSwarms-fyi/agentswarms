// Sync engine for KB connector sources (Drive / Notion / SharePoint / Dropbox).
//
// The dedup contract has two levels, and both exist to make scheduled
// ingestion safe to run forever:
//
//   1. `version` — the provider's cheap change marker (mtime, revision,
//      native hash), stamped on the document at ingest. If it matches, the
//      item is skipped WITHOUT downloading. This is what makes an hourly sync
//      over a 400-file folder cost a listing, not 400 downloads.
//   2. `content_hash` — sha256 of the ingested text. Providers bump mtimes
//      without content changes (moves, permission edits, comment activity);
//      when the downloaded text hashes to what is already stored, the version
//      stamp is refreshed and the document is NOT re-embedded. Embedding spend
//      follows actual content change, nothing else.
//
// Documents are updated IN PLACE (stable document id) so kb_chunks replacement
// stays keyed by document_id, exactly as embedAndStoreDocuments expects.
// Remotely-deleted items delete their documents; kb_chunks cascade.
//
// Mirrors saas/sync.server.ts's shape on purpose — same schedule vocabulary,
// same "record the outcome on the row" contract, same notification policy.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { decryptJson } from "@/utils/providers/crypto.server";
import { nextSyncAt } from "@/utils/saas/sync.server";
import { embedAndStoreDocuments } from "@/utils/tools/embedding.server";
import { KB_CONNECTORS, isConnectorKind } from "./connectors.server";
import { diffRemoteItems, sha256Hex } from "./dedup";

export { nextSyncAt, diffRemoteItems, sha256Hex };

export type KbSyncStats = {
  listed: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Items the connector saw but did not ingest, with reasons — never silent. */
  skipped: Array<{ name: string; reason: string }>;
  /** Items whose provider exposes no ACL while the source wants source_acl. */
  acl_unavailable: number;
};

export type KbSyncOutcome = {
  ok: boolean;
  status: "ok" | "error" | "embedding_failed";
  error: string | null;
  stats: KbSyncStats;
};

type SourceRow = {
  id: string;
  user_id: string | null;
  knowledge_base_id: string;
  kind: string;
  label: string | null;
  config: unknown;
  credentials: unknown;
  access_scope: string;
};

/** Sync one connector source and record the outcome on its row. */
export async function syncKbSource(
  sb: SupabaseClient<Database>,
  source: SourceRow,
): Promise<KbSyncOutcome> {
  const stats: KbSyncStats = {
    listed: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: [],
    acl_unavailable: 0,
  };

  const fail = async (message: string): Promise<KbSyncOutcome> => {
    await sb
      .from("kb_sources")
      .update({
        status: "error",
        error: message.slice(0, 2000),
        last_synced_at: new Date().toISOString(),
        last_sync_stats: stats as unknown as Json,
      })
      .eq("id", source.id);
    return { ok: false, status: "error", error: message, stats };
  };

  if (!isConnectorKind(source.kind)) {
    return fail(`"${source.kind}" is not a connector source`);
  }
  const connector = KB_CONNECTORS[source.kind];

  const enc = source.credentials as { ciphertext?: string; iv?: string } | null;
  if (!enc?.ciphertext || !enc?.iv) {
    return fail("No stored credentials — edit this source and save them again.");
  }
  let creds: Record<string, string>;
  try {
    creds = await decryptJson<Record<string, string>>(enc.ciphertext, enc.iv);
  } catch {
    return fail("Stored credentials no longer decrypt — re-save this source.");
  }
  const config = (source.config ?? {}) as Record<string, unknown>;
  const invalid = connector.validate(config, creds);
  if (invalid) return fail(invalid);

  await sb.from("kb_sources").update({ status: "syncing", error: null }).eq("id", source.id);

  try {
    const { items, skipped } = await connector.listItems(config, creds);
    stats.listed = items.length;
    stats.skipped = skipped;

    const { data: existingDocs } = await sb
      .from("knowledge_documents")
      .select("id, external_id, content_hash, metadata")
      .eq("source_id", source.id);
    const existing = (existingDocs ?? []).map((d) => ({
      id: d.id,
      external_id: d.external_id,
      content_hash: d.content_hash,
      version:
        ((d.metadata as { connector_version?: string } | null)?.connector_version as string) ??
        null,
    }));

    const { toFetch, unchanged, toRemoveExternalIds } = diffRemoteItems(items, existing);
    stats.unchanged = unchanged.length;

    // Remote deletions → document deletions (kb_chunks cascade on the FK).
    if (toRemoveExternalIds.length > 0) {
      const { error: delErr } = await sb
        .from("knowledge_documents")
        .delete()
        .eq("source_id", source.id)
        .in("external_id", toRemoveExternalIds);
      if (delErr) throw new Error(`removing deleted items: ${delErr.message}`);
      stats.removed = toRemoveExternalIds.length;
    }

    const wantAcl = source.access_scope === "source_acl" && connector.supportsAcl;
    if (source.access_scope === "source_acl" && !connector.supportsAcl) {
      // The provider cannot answer "who may see this". Documents keep
      // acl_principals = null and retrieval falls back to owner-only — the
      // stats surface it so the choice of scope is an informed one.
      stats.acl_unavailable = toFetch.length;
    }

    const byExternalId = new Map(existing.map((e) => [e.external_id, e]));
    const docsToEmbed: Array<{
      id: string;
      knowledge_base_id: string;
      user_id: string | null;
      is_sample: boolean;
      content: string;
    }> = [];

    for (const item of toFetch) {
      const fetched = await connector.fetchItem(config, creds, item, wantAcl);
      if (wantAcl && fetched.aclPrincipals === null) stats.acl_unavailable += 1;
      const hash = sha256Hex(fetched.text);
      const prior = byExternalId.get(item.externalId);

      if (prior && prior.content_hash === hash) {
        // Content identical — refresh the change marker (and ACL, which can
        // change without content changing) but do not touch chunks.
        const { error: upErr } = await sb
          .from("knowledge_documents")
          .update({
            name: item.name,
            metadata: {
              source: source.kind,
              connector_version: item.version,
              ingested_at: new Date().toISOString(),
            },
            ...(wantAcl ? { acl_principals: fetched.aclPrincipals } : {}),
          })
          .eq("id", prior.id);
        if (upErr) throw new Error(`updating ${item.name}: ${upErr.message}`);
        stats.unchanged += 1;
        continue;
      }

      if (prior) {
        const { error: upErr } = await sb
          .from("knowledge_documents")
          .update({
            name: item.name,
            content: fetched.text,
            content_hash: hash,
            acl_principals: wantAcl ? fetched.aclPrincipals : null,
            metadata: {
              source: source.kind,
              connector_version: item.version,
              ingested_at: new Date().toISOString(),
            },
          })
          .eq("id", prior.id);
        if (upErr) throw new Error(`updating ${item.name}: ${upErr.message}`);
        docsToEmbed.push({
          id: prior.id,
          knowledge_base_id: source.knowledge_base_id,
          user_id: source.user_id,
          is_sample: false,
          content: fetched.text,
        });
        stats.updated += 1;
      } else {
        const { data: inserted, error: insErr } = await sb
          .from("knowledge_documents")
          .insert({
            knowledge_base_id: source.knowledge_base_id,
            user_id: source.user_id,
            source_id: source.id,
            external_id: item.externalId,
            name: item.name,
            content: fetched.text,
            content_hash: hash,
            acl_principals: wantAcl ? fetched.aclPrincipals : null,
            metadata: {
              source: source.kind,
              connector_version: item.version,
              ingested_at: new Date().toISOString(),
            },
          })
          .select("id")
          .single();
        if (insErr || !inserted) {
          throw new Error(`inserting ${item.name}: ${insErr?.message ?? "no row returned"}`);
        }
        docsToEmbed.push({
          id: inserted.id,
          knowledge_base_id: source.knowledge_base_id,
          user_id: source.user_id,
          is_sample: false,
          content: fetched.text,
        });
        stats.added += 1;
      }
    }

    // Embed only what changed — the whole point of the content hash.
    let embedError: string | null = null;
    if (docsToEmbed.length > 0) {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        embedError =
          "OPENAI_API_KEY not configured — documents saved, semantic search not updated.";
      } else {
        try {
          await embedAndStoreDocuments({
            sb,
            docs: docsToEmbed,
            openaiKey,
            userId: source.user_id ?? undefined,
            surface: `KB: Sync ${connector.label}`,
          });
        } catch (err) {
          embedError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const status: KbSyncOutcome["status"] = embedError ? "embedding_failed" : "ok";
    await sb
      .from("kb_sources")
      .update({
        status,
        error: embedError,
        last_synced_at: new Date().toISOString(),
        last_sync_stats: stats as unknown as Json,
      })
      .eq("id", source.id);
    return { ok: !embedError, status, error: embedError, stats };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
