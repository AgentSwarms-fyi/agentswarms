// What the app knows about a stored file without opening it (R441): whose
// it is, which key its content type says it is under, and how a pass over
// them reads. Pure, so the admin card and the audit log print the same line
// the server writes.

/** The Supabase Storage buckets whose files the app seals. */
export const STORED_FILE_BUCKETS = ["chat-docs", "datasets"] as const;
export type StoredFileBucket = (typeof STORED_FILE_BUCKETS)[number];

/** A sealed object's content type, with the key it is under as a parameter. */
export const SEALED_CONTENT_TYPE = "application/vnd.agentswarms.sealed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Whose file this is: its path's first folder, which both buckets name after
 * the user (as their storage policies do). Null for anything else.
 */
export function ownerOfPath(path: string): string | null {
  const [first, ...rest] = path.split("/");
  if (!first || !UUID_RE.test(first) || rest.length === 0) return null;
  if (rest.some((p) => p === "" || p === "." || p === "..")) return null;
  return first.toLowerCase();
}

export function sealedContentType(kid: string): string {
  return KID_RE.test(kid) ? `${SEALED_CONTENT_TYPE}; kid=${kid}` : SEALED_CONTENT_TYPE;
}

/**
 * The key a listed object's content type says it is under: the fingerprint;
 * null for a sealed type that names none (open it to know); undefined when
 * the type is not a sealed one (a file from before R441, or another kind).
 */
export function kidOfContentType(
  contentType: string | null | undefined,
): string | null | undefined {
  if (!contentType) return undefined;
  const [type, ...params] = contentType.split(";").map((s) => s.trim());
  if (type?.toLowerCase() !== SEALED_CONTENT_TYPE) return undefined;
  for (const p of params) {
    const m = /^kid=(.+)$/i.exec(p);
    if (m) {
      const kid = m[1]!.replace(/^"(.*)"$/, "$1");
      return KID_RE.test(kid) ? kid : null;
    }
  }
  return null;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** One line for a pass over the stored files, from its audit detail. */
export function storedFilesPassLine(d: Record<string, unknown>): string {
  const docs = n(d.documents);
  const copies = n(d.copies);
  const parts = [
    `${plural(n(d.files), "file")} checked (${plural(docs, "document")}, ${plural(copies, "dataset copy", "dataset copies")})`,
  ];
  if (n(d.files_sealed_now))
    parts.push(`${n(d.files_sealed_now)} encrypted under their owner's key`);
  if (n(d.copies_rebuilt))
    parts.push(`${plural(n(d.copies_rebuilt), "dataset copy", "dataset copies")} rebuilt under it`);
  if (n(d.files_already_right)) parts.push(`${n(d.files_already_right)} already under it`);
  if (n(d.files_unreadable))
    parts.push(`${n(d.files_unreadable)} under a key that is gone, left as they are`);
  if (n(d.copies_not_rebuilt))
    parts.push(
      n(d.copies_not_rebuilt) === 1
        ? "1 dataset copy not rebuilt (its dataset answers from its rows meanwhile)"
        : `${n(d.copies_not_rebuilt)} dataset copies not rebuilt (their datasets answer from their rows meanwhile)`,
    );
  if (n(d.files_not_owned)) parts.push(`${n(d.files_not_owned)} outside an owner's folder, left`);
  if (n(d.files_vanished)) parts.push(`${n(d.files_vanished)} deleted while the pass ran`);
  if (n(d.files_left)) parts.push(`${n(d.files_left)} left for the next pass`);
  if (n(d.files_failed)) parts.push(`${n(d.files_failed)} failed`);
  // What agents kept before R445, sealed by the same pass.
  const memory = [
    n(d.memory_items_sealed) ? plural(n(d.memory_items_sealed), "memory item") : null,
    n(d.summaries_sealed)
      ? plural(n(d.summaries_sealed), "conversation summary", "conversation summaries")
      : null,
    n(d.scratchpads_sealed) ? plural(n(d.scratchpads_sealed), "scratchpad") : null,
  ].filter(Boolean);
  if (memory.length)
    parts.push(`${memory.join(", ")} of agent memory encrypted under their owner's key`);
  if (n(d.memory_unreadable))
    parts.push(
      `${n(d.memory_unreadable)} of agent memory whose owner's key cannot be had now, left as they are`,
    );
  if (d.memory_left === true) parts.push("more agent memory left for the next pass");
  if (n(d.memory_failed)) parts.push(`${n(d.memory_failed)} of agent memory failed`);
  // And Agent Chat history kept before R446.
  const chat = [
    n(d.messages_sealed) ? plural(n(d.messages_sealed), "chat message") : null,
    n(d.titles_sealed) ? plural(n(d.titles_sealed), "chat title") : null,
    n(d.swarm_chats_sealed) ? plural(n(d.swarm_chats_sealed), "swarm chat") : null,
    n(d.analyst_threads_sealed) ? plural(n(d.analyst_threads_sealed), "AI Analyst thread") : null,
  ].filter(Boolean);
  if (chat.length) parts.push(`${chat.join(", ")} encrypted under their owner's key`);
  if (n(d.chat_unreadable))
    parts.push(
      `${n(d.chat_unreadable)} of chat history whose owner's key cannot be had now, left as they are`,
    );
  if (d.chat_left === true) parts.push("more chat history left for the next pass");
  if (n(d.chat_failed)) parts.push(`${n(d.chat_failed)} of chat history failed`);
  // And approval requests and notifications kept before R450.
  const inbox = [
    n(d.approvals_sealed) ? plural(n(d.approvals_sealed), "approval request") : null,
    n(d.notifications_sealed) ? plural(n(d.notifications_sealed), "notification") : null,
  ].filter(Boolean);
  if (inbox.length) parts.push(`${inbox.join(", ")} encrypted under their owner's key`);
  if (n(d.inbox_unreadable))
    parts.push(
      `${n(d.inbox_unreadable)} of approvals and notifications whose owner's key cannot be had now, left as they are`,
    );
  if (d.inbox_left === true) parts.push("more approvals and notifications left for the next pass");
  if (d.approvals_need_migration === true)
    parts.push("older approval requests wait for migration 20261108000000");
  if (n(d.inbox_failed)) parts.push(`${n(d.inbox_failed)} of approvals and notifications failed`);
  // And swarm run traces kept before R449.
  const runs = [
    n(d.swarm_runs_sealed) ? plural(n(d.swarm_runs_sealed), "swarm run") : null,
    n(d.run_steps_sealed) ? plural(n(d.run_steps_sealed), "run step") : null,
    n(d.run_links_sealed) ? plural(n(d.run_links_sealed), "run link") : null,
    n(d.run_checkpoints_sealed) ? plural(n(d.run_checkpoints_sealed), "run state") : null,
  ].filter(Boolean);
  if (runs.length) parts.push(`${runs.join(", ")} encrypted under their owner's key`);
  if (n(d.runs_unreadable))
    parts.push(
      `${n(d.runs_unreadable)} of swarm run traces whose owner's key cannot be had now, left as they are`,
    );
  if (d.runs_left === true) parts.push("more swarm run traces left for the next pass");
  if (n(d.runs_failed)) parts.push(`${n(d.runs_failed)} of swarm run traces failed`);
  // And model call traces kept before R448.
  if (n(d.traces_sealed))
    parts.push(
      `${plural(n(d.traces_sealed), "model call trace")} encrypted under their owner's key`,
    );
  if (n(d.traces_unreadable))
    parts.push(
      `${plural(n(d.traces_unreadable), "model call trace")} whose owner's key cannot be had now, left as they are`,
    );
  if (d.traces_left === true) parts.push("more model call traces left for the next pass");
  if (n(d.traces_failed)) parts.push(`${plural(n(d.traces_failed), "model call trace")} failed`);
  if (typeof d.skipped === "string" && d.skipped) parts.push(d.skipped);
  return parts.join(" · ");
}
