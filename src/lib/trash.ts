// The trash: what can go in it, how long it stays, and what to tell someone
// when the database says no.
//
// The database decides what goes in (public.trash_kinds() in migration
// 20261122000000_trash.sql) and this list mirrors it so the app can say, before
// asking, whether a delete can be undone. A test reads both and fails when
// they differ.
import type { ObjectKindId } from "@/lib/objectKinds";

/**
 * Kinds whose delete moves them to the trash. The rest are deleted for good,
 * because deleting them also removes something outside the database that a
 * copy of its rows cannot bring back (files, vectors, a running service).
 */
export const TRASHABLE_KINDS = [
  "agent",
  "swarm",
  "prompt",
  "skill",
  "evaluation",
  "semantic_model",
  "data_monitor",
  "ai_analyst",
  "dashboard",
  "report",
  "workbook",
  "workflow",
  "sql_model",
  "notebook",
  "embed",
] as const satisfies readonly ObjectKindId[];

export type TrashableKind = (typeof TRASHABLE_KINDS)[number];

export function isTrashable(kind: string): kind is TrashableKind {
  return (TRASHABLE_KINDS as readonly string[]).includes(kind);
}

/** How long something stays in the trash before it is deleted for good. */
export const TRASH_RETENTION_DAYS = 30;

/** The sentence a delete confirmation ends with. */
export const RESTORE_HINT = `You can restore it from Trash for ${TRASH_RETENTION_DAYS} days.`;

/** One entry of the reader's trash, as my_trash() returns it. */
export type TrashEntry = {
  id: string;
  kind: ObjectKindId;
  objectId: string;
  name: string;
  deletedAt: string;
  purgeAfter: string;
  rowCount: number;
};

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** A row of my_trash(); null when it is not one, or names a kind the app has lost. */
export function trashEntryFromRow(
  row: unknown,
  known: (kind: string) => kind is ObjectKindId,
): TrashEntry | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (!text(r.id) || !known(text(r.kind)) || !text(r.object_id)) return null;
  return {
    id: text(r.id),
    kind: text(r.kind) as ObjectKindId,
    objectId: text(r.object_id),
    name: text(r.name),
    deletedAt: text(r.deleted_at),
    purgeAfter: text(r.purge_after),
    rowCount: typeof r.row_count === "number" ? r.row_count : 0,
  };
}

/**
 * Whole days until an entry is deleted for good, never below zero. Rounded
 * up: an entry with a day and a half left has two days, not one.
 */
export function daysLeft(purgeAfter: string, now: number = Date.now()): number {
  const t = Date.parse(purgeAfter);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

/** "Deleted for good in 3 days", "… tomorrow", "… today". */
export function purgeLabel(purgeAfter: string, now: number = Date.now()): string {
  const d = daysLeft(purgeAfter, now);
  if (d <= 0) return "Deleted for good today";
  if (d === 1) return "Deleted for good tomorrow";
  return `Deleted for good in ${d} days`;
}

type DbError = { code?: string; message?: string } | null | undefined;

/**
 * The trash functions are not in this database: it runs a newer app than its
 * migrations. PostgREST answers a missing function with PGRST202.
 */
export function trashMissing(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return (
    /(trash_object|restore_trash|my_trash|empty_trash)/.test(error.message ?? "") &&
    /could not find|does not exist/i.test(error.message ?? "")
  );
}

/**
 * What to tell someone when moving to or restoring from the trash failed. The
 * database already words its refusals for a person; anything else is said
 * plainly with what it was.
 */
export function trashErrorText(error: DbError, doing: "move" | "restore" | "delete"): string {
  if (trashMissing(error)) {
    return "The trash is not set up on this database yet. Apply the latest migrations, then try again.";
  }
  const msg = (error?.message ?? "").trim();
  // Raised by the trash functions themselves, in words meant for the reader.
  const worded = [
    "Sign in to",
    "This kind of thing",
    "It is not here any more",
    "It is not here any more, or it is not yours",
    "A bundled sample",
    "This cannot be moved to the trash yet",
    "This is too large for the trash",
    "It is not in your trash",
    "Something else has taken its place",
    "It cannot come back",
  ];
  if (worded.some((w) => msg.startsWith(w))) return msg;
  const what =
    doing === "move"
      ? "It could not be moved to the trash"
      : doing === "restore"
        ? "It could not be restored"
        : "It could not be deleted";
  return msg ? `${what}: ${msg}` : `${what}.`;
}
