// Generated documents and dataset copies, sealed by the app under their
// owner's key (R441).
//
// Supabase Storage keeps the bytes, and it cannot encrypt under a customer's
// own key the way S3 does for lakehouse files (R440). So the app does: every
// file it stores in the `chat-docs` and `datasets` buckets is sealed
// (storage/sealedFile) under the owner's user key, which a customer key wraps
// when the owner is a customer's member. That holds for every kind of
// customer key, held by the app or in any KMS, and erasing one user's key
// leaves that user's files unreadable. Moving a user between customer keys
// re-wraps the user key, so no file is rewritten.
//
// The owner is the path's first folder: both buckets keep a user's files
// under `<user id>/`.
//
// Files stored before R441 are plaintext, and read as they are. The pass
// (`sealOlderStoredFiles`) finds them, and any file under a key other than
// its owner's current one, from the listing (a sealed object's content type
// names its key), and puts each under its owner's key: a document is sealed
// in place, since a document is written once and never rewritten; a dataset
// copy is rebuilt from the dataset's rows, since sealing one in place could
// put an older copy over a newer one written meanwhile. A file under a key
// that is gone (erased, destroyed, refused) is left as it is: no pass moves a
// file off a key that can no longer open it.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { DataKeyUnavailableError } from "@/utils/kms/keyHierarchy.server";
import { KMS_AUDIT_ACTOR } from "@/utils/kms/keyring.server";
import {
  assertStoredFileKey,
  openStoredFile,
  sealStoredFile,
  storedFileKidFor,
} from "@/utils/providers/crypto.server";
import { isSealed, SealedFileError, sealedKid } from "@/utils/storage/sealedFile";
import {
  kidOfContentType,
  ownerOfPath,
  sealedContentType,
  STORED_FILE_BUCKETS,
  type StoredFileBucket,
} from "@/utils/storage/storedFiles";

export const STORED_FILES_PASS = "security.stored_files.seal";

/** Store `bytes` at `bucket/path`, sealed under the key of the path's owner. */
export async function putStoredFile(
  bucket: StoredFileBucket,
  path: string,
  bytes: Uint8Array,
): Promise<{ kid: string }> {
  const owner = ownerOfPath(path);
  if (!owner) throw new Error(`"${path}" is not in an owner's folder`);
  const { sealed, kid } = await sealStoredFile(bytes, { owner, where: `${bucket}/${path}` });
  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(path, sealed, { upsert: true, contentType: sealedContentType(kid) });
  if (error) throw new Error(error.message);
  return { kid };
}

/** Whether a storage error says the object is not there. */
export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  return (
    e.status === 404 ||
    e.statusCode === "404" ||
    e.code === "NoSuchKey" ||
    e.code === "not_found" ||
    (typeof e.message === "string" && /not[\s_]?found/i.test(e.message))
  );
}

export type OpenedFile = {
  bytes: Uint8Array;
  /** The key it was under; null for a plaintext file from before R441. */
  kid: string | null;
};

/**
 * The file at `bucket/path`, opened: null when there is none. Throws
 * DataKeyUnavailableError when its key is gone and SealedFileError when it
 * does not open; a plaintext file from before R441 comes back as it is.
 */
export async function getStoredFile(
  bucket: StoredFileBucket,
  path: string,
): Promise<OpenedFile | null> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
  if (error || !data) {
    if (!error || isNotFound(error)) return null;
    throw new Error(error.message);
  }
  const raw = new Uint8Array(await data.arrayBuffer());
  if (!isSealed(raw)) return { bytes: raw, kid: null };
  return { bytes: await openStoredFile(raw, `${bucket}/${path}`), kid: sealedKid(raw) };
}

const sentence = (m: string) => (/[.!?]$/.test(m) ? m : `${m}.`);

/** Whether a stored file failed on its key or its bytes (the caller's to hear), not the store. */
export function isStoredFileKeyError(e: unknown): boolean {
  return e instanceof DataKeyUnavailableError || e instanceof SealedFileError;
}

/**
 * Why a stored file cannot be read or stored, in words, for `what` ("This
 * document"). The key hierarchy's erasure message asks for a value to be
 * entered again, which a file cannot be.
 */
export function describeStoredFileError(
  e: unknown,
  what: string,
  doing: "read" | "stored" = "read",
): string {
  if (e instanceof DataKeyUnavailableError && e.reason === "erased" && doing === "read") {
    return `${e.message.replace(/^This was stored/, `${what} was stored`).replace(/; enter it again$/, "")}; it cannot be read.`;
  }
  if (isStoredFileKeyError(e))
    return sentence(`${what} cannot be ${doing}: ${(e as Error).message}`);
  return sentence(`${what} could not be ${doing}: ${(e as Error).message}`);
}

// ── The pass ─────────────────────────────────────────────────────────────────

export type StoredFilesPass = {
  files: number;
  documents: number;
  copies: number;
  sealedNow: number;
  rebuilt: number;
  alreadyRight: number;
  unreadable: number;
  notRebuilt: number;
  notOwned: number;
  vanished: number;
  left: number;
  failed: number;
  errors: string[];
};

type Listed = { bucket: StoredFileBucket; path: string; contentType: string | null };

const PAGE = 1000;
const MAX_ERRORS = 5;

/** Every object in a bucket, two folders deep (both buckets are `<user>/<file>`). */
async function listBucket(bucket: StoredFileBucket): Promise<Listed[]> {
  const out: Listed[] = [];
  const walk = async (prefix: string, depth: number): Promise<void> => {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabaseAdmin.storage
        .from(bucket)
        .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`${bucket}: ${error.message}`);
      for (const o of data ?? []) {
        const path = prefix ? `${prefix}/${o.name}` : o.name;
        if (o.id === null) {
          if (depth < 2) await walk(path, depth + 1);
          continue;
        }
        const mimetype = (o.metadata as { mimetype?: unknown } | null)?.mimetype;
        out.push({ bucket, path, contentType: typeof mimetype === "string" ? mimetype : null });
      }
      if ((data ?? []).length < PAGE) return;
    }
  };
  await walk("", 0);
  return out;
}

/** How many files one background pass changes; the button's pass has no limit. */
export function storedFilesPerPass(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.STORED_FILES_PER_PASS ?? "").trim();
  if (!raw) return 25;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : 25;
}

/**
 * Put every stored file under its owner's current key. `limit` bounds how
 * many files are changed (sealed or rebuilt); the rest are counted as left.
 */
export async function sealOlderStoredFiles(
  opts: { limit?: number } = {},
): Promise<StoredFilesPass> {
  const r: StoredFilesPass = {
    files: 0,
    documents: 0,
    copies: 0,
    sealedNow: 0,
    rebuilt: 0,
    alreadyRight: 0,
    unreadable: 0,
    notRebuilt: 0,
    notOwned: 0,
    vanished: 0,
    left: 0,
    failed: 0,
    errors: [],
  };
  const fail = (what: string, e: unknown) => {
    r.failed++;
    if (r.errors.length < MAX_ERRORS) r.errors.push(`${what}: ${(e as Error).message}`);
  };
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let changed = 0;
  const targets = new Map<string, Promise<string>>();
  const targetFor = (owner: string) => {
    let t = targets.get(owner);
    if (!t) {
      t = storedFileKidFor(owner);
      targets.set(owner, t);
    }
    return t;
  };

  for (const bucket of STORED_FILE_BUCKETS) {
    let listed: Listed[];
    try {
      listed = await listBucket(bucket);
    } catch (e) {
      fail(bucket, e);
      continue;
    }
    for (const f of listed) {
      r.files++;
      if (bucket === "chat-docs") r.documents++;
      else r.copies++;
      const owner = ownerOfPath(f.path);
      if (!owner) {
        r.notOwned++;
        continue;
      }
      let target: string;
      try {
        target = await targetFor(owner);
      } catch (e) {
        fail(f.path, e);
        continue;
      }
      const listedKid = kidOfContentType(f.contentType);
      if (listedKid === target) {
        r.alreadyRight++;
        continue;
      }
      if (changed >= limit) {
        r.left++;
        continue;
      }
      try {
        if (bucket === "chat-docs") {
          const outcome = await resealDocument(f.path, target);
          if (outcome === "right") r.alreadyRight++;
          else if (outcome === "gone") r.unreadable++;
          else if (outcome === "missing") r.vanished++;
          else {
            r.sealedNow++;
            changed++;
          }
        } else {
          const outcome = await rebuildCopy(f.path, listedKid, target);
          if (outcome === "right") r.alreadyRight++;
          else if (outcome === "gone") r.unreadable++;
          else if (outcome === "missing") r.vanished++;
          else if (outcome === "rebuilt") {
            r.rebuilt++;
            changed++;
          } else r.notRebuilt++;
        }
      } catch (e) {
        fail(`${bucket}/${f.path}`, e);
      }
    }
  }
  return r;
}

/** A document under a key other than `target`, sealed in place under it. */
async function resealDocument(
  path: string,
  target: string,
): Promise<"right" | "gone" | "sealed" | "missing"> {
  let opened: OpenedFile | null;
  try {
    opened = await getStoredFile("chat-docs", path);
  } catch (e) {
    if (e instanceof DataKeyUnavailableError) return "gone";
    throw e;
  }
  if (!opened) return "missing";
  // The listing's type can lag the bytes (a store that drops the parameter):
  // the header is what counts.
  if (opened.kid === target) return "right";
  const put = await putStoredFile("chat-docs", path, opened.bytes);
  if (put.kid !== target) throw new Error(`sealed under ${put.kid}, not ${target}`);
  return "sealed";
}

/**
 * A dataset copy not under its owner's current key, rebuilt from the
 * dataset's rows. One under a key that is gone is left: its dataset answers
 * from its rows, and its next refresh writes a copy under the new key.
 */
async function rebuildCopy(
  path: string,
  listedKid: string | null | undefined,
  target: string,
): Promise<"right" | "gone" | "missing" | "rebuilt" | "not"> {
  if (listedKid === null) {
    // A sealed type naming no key: the header says which. Without this, a
    // store that dropped the parameter would have every copy rebuilt on
    // every pass.
    const { data, error } = await supabaseAdmin.storage.from("datasets").download(path);
    if (error || !data) {
      if (!error || isNotFound(error)) return "missing";
      throw new Error(error.message);
    }
    listedKid = sealedKid(new Uint8Array(await data.arrayBuffer())) ?? undefined;
    if (listedKid === target) return "right";
  }
  if (typeof listedKid === "string") {
    try {
      await assertStoredFileKey(listedKid);
    } catch (e) {
      if (e instanceof DataKeyUnavailableError) return "gone";
      throw e;
    }
  }
  const owner = ownerOfPath(path)!;
  const m = /^[^/]+\/([0-9a-f-]{36})\.parquet$/i.exec(path);
  if (!m) return "not";
  const { refreshDatasetMirror } = await import("@/utils/data/parquet.server");
  const res = await refreshDatasetMirror({ userId: owner, tableId: m[1]!.toLowerCase() });
  return res ? "rebuilt" : "not";
}

/** The audit detail of a pass: the counts, as the card and the audit log print them. */
export function storedFilesPassDetail(r: StoredFilesPass): Record<string, unknown> {
  return {
    files: r.files,
    documents: r.documents,
    copies: r.copies,
    files_sealed_now: r.sealedNow,
    copies_rebuilt: r.rebuilt,
    files_already_right: r.alreadyRight,
    files_unreadable: r.unreadable,
    copies_not_rebuilt: r.notRebuilt,
    files_not_owned: r.notOwned,
    files_vanished: r.vanished,
    files_left: r.left,
    files_failed: r.failed,
    ...(r.errors.length ? { errors: r.errors } : {}),
  };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastSweep = 0;

/**
 * The background pass, from the scheduler: at most once an hour, at most
 * STORED_FILES_PER_PASS files changed, and what agents kept about each user
 * before R445 (memory items, summaries, scratchpads; MEMORY_SEAL_PER_PASS).
 * Audited, as one row, when it changed or failed something; a pass with
 * nothing to do leaves no row.
 */
export async function sweepStoredFiles(force = false): Promise<StoredFilesPass | null> {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_INTERVAL_MS) return null;
  lastSweep = now;
  const r = await sealOlderStoredFiles({ limit: storedFilesPerPass() });
  const { memoryPassDetail, memorySealPerPass, sealOlderMemory } =
    await import("@/utils/memory/sealed.server");
  const m = await sealOlderMemory({ limit: memorySealPerPass() });
  const memoryChanged = m.items + m.summaries + m.scratchpads + m.failed;
  if (r.sealedNow + r.rebuilt + r.failed + memoryChanged > 0) {
    auditEvent({
      userId: null,
      actorEmail: KMS_AUDIT_ACTOR,
      action: STORED_FILES_PASS,
      resourceType: "security",
      resourceName: "stored files",
      detail: { trigger: "scheduled", ...storedFilesPassDetail(r), ...memoryPassDetail(m) },
    });
  }
  if (r.failed) console.warn(`[stored-files] ${r.failed} failed`, r.errors);
  if (m.failed) console.warn(`[agent-memory] ${m.failed} failed`, m.errors);
  return r;
}
