// Reconcile a source's documents against what was just fetched.
//
// The URL and GitHub ingest routes used to do this:
//
//     await admin.from("knowledge_documents").delete().eq("source_id", id);
//     await admin.from("knowledge_documents").insert(docs);
//
// which is wrong in three ways that only show up on the SECOND sync:
//
//   1. Every document gets a new id. Anything keyed to a document id is
//      silently orphaned — including `acl_principals`, the per-document access
//      control, so a re-sync quietly drops who was allowed to see what.
//   2. Every document is re-embedded, whether or not its text changed.
//      Embedding is metered; a repo that re-syncs hourly pays hourly for
//      nothing. docs/knowledge promises the opposite ("Content skip — unchanged
//      text is not re-embedded … Embedding spend follows actual content
//      change, nothing else").
//   3. `last_sync_stats` stays null, so the source card's promised
//      "+added ~updated =unchanged −removed" line has nothing to show.
//
// Measured before this existed: re-syncing github/gitignore replaced all four
// documents — 959c1544 → fa5fb09b and so on — with fresh created_at and
// content_hash still null.
//
// The connector engine (sync.server.ts) already did this correctly, but it is
// built around the connector interface — listItems/fetchItem — which the two
// ingest routes do not implement. So the RECONCILIATION lives here, shared by
// both, using the same sha256Hex; what differs between them (how documents are
// obtained) stays where it belongs.
import { sha256Hex } from "./dedup";

/** One document as the caller just fetched it. */
export type IncomingDoc = {
  /** Stable identity of the remote item — a repo path, a URL. */
  externalId: string;
  name: string;
  content: string;
  metadata: Record<string, unknown>;
};

export type ReconcileStats = {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
};

/** Documents whose text actually changed, so the caller can embed just those. */
export type ReconcileResult = {
  stats: ReconcileStats;
  toEmbed: Array<{
    id: string;
    knowledge_base_id: string;
    user_id: string | null;
    is_sample: boolean;
    content: string;
  }>;
};

type Client = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export async function reconcileSourceDocuments(
  sb: Client,
  opts: {
    sourceId: string;
    knowledgeBaseId: string;
    userId: string;
    incoming: IncomingDoc[];
  },
): Promise<ReconcileResult> {
  const stats: ReconcileStats = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const toEmbed: ReconcileResult["toEmbed"] = [];

  const { data: existingRows, error: readErr } = await sb
    .from("knowledge_documents")
    .select("id, external_id, content_hash, knowledge_base_id, user_id, is_sample")
    .eq("source_id", opts.sourceId);
  if (readErr) throw new Error(`reading existing documents: ${readErr.message}`);
  const existing = new Map(
    (existingRows ?? []).map((d: { external_id: string | null }) => [d.external_id, d]),
  );

  const seen = new Set<string>();
  for (const item of opts.incoming) {
    seen.add(item.externalId);
    const hash = sha256Hex(item.content);
    const prior = existing.get(item.externalId) as
      | {
          id: string;
          content_hash: string | null;
          knowledge_base_id: string;
          user_id: string | null;
          is_sample: boolean | null;
        }
      | undefined;

    if (prior && prior.content_hash === hash) {
      // Same text. Refresh the display name and metadata, keep the chunks.
      const { error } = await sb
        .from("knowledge_documents")
        .update({ name: item.name, metadata: item.metadata })
        .eq("id", prior.id);
      if (error) throw new Error(`refreshing ${item.name}: ${error.message}`);
      stats.unchanged += 1;
      continue;
    }

    if (prior) {
      // Changed. Update IN PLACE so the id — and everything keyed to it —
      // survives.
      const { error } = await sb
        .from("knowledge_documents")
        .update({
          name: item.name,
          content: item.content,
          content_hash: hash,
          metadata: item.metadata,
        })
        .eq("id", prior.id);
      if (error) throw new Error(`updating ${item.name}: ${error.message}`);
      stats.updated += 1;
      toEmbed.push({
        id: prior.id,
        knowledge_base_id: prior.knowledge_base_id,
        user_id: prior.user_id,
        is_sample: !!prior.is_sample,
        content: item.content,
      });
      continue;
    }

    const { data: inserted, error } = await sb
      .from("knowledge_documents")
      .insert({
        knowledge_base_id: opts.knowledgeBaseId,
        user_id: opts.userId,
        source_id: opts.sourceId,
        external_id: item.externalId,
        name: item.name,
        content: item.content,
        content_hash: hash,
        metadata: item.metadata,
      })
      .select("id, knowledge_base_id, user_id, is_sample")
      .single();
    if (error) throw new Error(`adding ${item.name}: ${error.message}`);
    stats.added += 1;
    toEmbed.push({
      id: inserted.id,
      knowledge_base_id: inserted.knowledge_base_id,
      user_id: inserted.user_id,
      is_sample: !!inserted.is_sample,
      content: item.content,
    });
  }

  // Gone at the remote → gone here. kb_chunks cascade on the FK.
  const stale = (existingRows ?? [])
    .map((d: { external_id: string | null }) => d.external_id)
    .filter((id: string | null): id is string => !!id && !seen.has(id));
  if (stale.length > 0) {
    const { error } = await sb
      .from("knowledge_documents")
      .delete()
      .eq("source_id", opts.sourceId)
      .in("external_id", stale);
    if (error) throw new Error(`removing deleted items: ${error.message}`);
    stats.removed = stale.length;
  }

  return { stats, toEmbed };
}
