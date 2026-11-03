// /api/chat-docs — keep and fetch a document the chat generated (R441).
//
//   POST ?doc=<uuid>&format=pptx|docx|xlsx   body: the file
//        → { ok, path }   stored at chat-docs/<caller>/<doc>.<format>
//   GET  ?path=<caller>/<doc>.<format>&filename=<name>
//        → the file, as an attachment
//
// The browser used to put the file into the bucket itself and fetch it back
// through a signed URL, so the store held it as it was. Now the app seals it
// under the caller's user key (storage/storedFiles.server) before it is
// stored, and opens it on the way back: the store holds ciphertext only, a
// customer key covers its members' documents whatever kind of key it is, and
// an erased user key leaves that user's documents unreadable.
//
// SECURITY:
//   • A real Supabase session, verified before a byte is read.
//   • Only the caller's own folder, as the bucket's storage policies allow:
//     the path is built here on a write, and checked against the caller on a
//     read. Nobody fetches another user's document through this route.
//   • A document a key no longer opens says why (erased, destroyed, refused),
//     not "expired".
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure, callerFailureStatus } from "@/utils/callerLookup.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";
import {
  describeStoredFileError,
  getStoredFile,
  isStoredFileKeyError,
  putStoredFile,
} from "@/utils/storage/storedFiles.server";

const DOC_MIME = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
type DocFormat = keyof typeof DOC_MIME;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DOC_RE = new RegExp(`^${UUID}$`, "i");
const PATH_RE = new RegExp(`^(${UUID})/(${UUID})\\.(pptx|docx|xlsx)$`, "i");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The largest document this route stores; CHAT_DOC_MAX_BYTES, 50 MB by default. */
export function chatDocMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.CHAT_DOC_MAX_BYTES ?? "").trim();
  if (!raw) return 50 * 1024 * 1024;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 50 * 1024 * 1024;
}

/** A filename safe to put in Content-Disposition, keeping the document's extension. */
export function attachmentName(raw: string | null, format: DocFormat): string {
  const base = (raw ?? "")
    .replace(/[\r\n"\\/]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim()
    .slice(0, 150);
  const name = base || `document.${format}`;
  return name.toLowerCase().endsWith(`.${format}`) ? name : `${name}.${format}`;
}

async function caller(request: Request): Promise<{ userId: string } | Response> {
  const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return json(401, { error: "Unauthorized" });
  const { data: auth, error } = await supabaseAdmin.auth.getUser(bearer);
  const userId = auth.user?.id;
  if (!userId)
    return json(callerFailureStatus(error), { error: callerFailure(error, "Unauthorized") });
  return { userId };
}

async function store(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  if (await rateLimitedGlobal(`chat-doc:${who.userId}`, envInt("CHAT_DOC_PER_MINUTE", 30))) {
    return json(429, { error: "Too many documents stored — wait a minute and try again." });
  }
  const url = new URL(request.url);
  const doc = url.searchParams.get("doc") ?? "";
  const format = (url.searchParams.get("format") ?? "").toLowerCase();
  if (!DOC_RE.test(doc)) return json(400, { error: "Missing or malformed document id" });
  if (!Object.hasOwn(DOC_MIME, format)) {
    return json(400, { error: "A document is a pptx, docx or xlsx file" });
  }
  const max = chatDocMaxBytes();
  const declared = Number(request.headers.get("Content-Length") ?? "");
  const tooLarge = () =>
    json(413, {
      error: `This document is larger than ${(max / (1024 * 1024)).toFixed(0)} MB, the most this server stores (CHAT_DOC_MAX_BYTES).`,
    });
  if (Number.isFinite(declared) && declared > max) return tooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return json(400, { error: "Empty document" });
  if (bytes.length > max) return tooLarge();
  const path = `${who.userId}/${doc.toLowerCase()}.${format}`;
  try {
    await putStoredFile("chat-docs", path, bytes);
    return json(200, { ok: true, path });
  } catch (e) {
    return json(isStoredFileKeyError(e) ? 409 : 502, {
      error: describeStoredFileError(e, "This document", "stored"),
    });
  }
}

async function fetchDoc(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  const url = new URL(request.url);
  const m = PATH_RE.exec(url.searchParams.get("path") ?? "");
  if (!m || m[1]!.toLowerCase() !== who.userId.toLowerCase()) {
    return json(404, { error: "This document has expired or is no longer available." });
  }
  const format = m[3]!.toLowerCase() as DocFormat;
  try {
    const file = await getStoredFile("chat-docs", url.searchParams.get("path")!);
    if (!file) return json(404, { error: "This document has expired or is no longer available." });
    const body = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": DOC_MIME[format],
        "Content-Disposition": `attachment; filename="${attachmentName(url.searchParams.get("filename"), format)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return json(isStoredFileKeyError(e) ? 409 : 502, {
      error: describeStoredFileError(e, "This document"),
    });
  }
}

export const Route = createFileRoute("/api/chat-docs")({
  server: {
    handlers: {
      POST: ({ request }) => store(request),
      GET: ({ request }) => fetchDoc(request),
    },
  },
});
