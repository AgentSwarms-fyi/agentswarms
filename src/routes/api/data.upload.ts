// POST /api/data/upload — stream a file straight into a dataset.
//
// The body is the raw file; the table name, filename and content type travel
// as query parameters and headers so nothing has to be buffered to find them.
// (multipart/form-data would force the whole file through a form parser before
// the first row could be written, which defeats the purpose.)
//
// SECURITY:
//   • Requires a real Supabase session; the token is verified before a single
//     byte is read, so an unauthenticated request cannot make us parse
//     anything.
//   • Rows are written with the service role, but ONLY ever under the
//     authenticated caller's user_id — there is no path here that writes to
//     another user's dataset.
//   • Per-user rate limit: parsing is the most CPU-expensive thing an
//     unprivileged user can ask this server to do.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectFormat, safeTableName, UPLOAD_ACCEPT } from "@/lib/datasetParse";
import { auditEvent } from "@/utils/audit.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";
import { ingestUpload, uploadMaxBytes, uploadMaxRows } from "@/utils/data/ingest.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return json(401, { error: "Unauthorized" });
  const { data: auth } = await supabaseAdmin.auth.getUser(bearer);
  const userId = auth.user?.id;
  if (!userId) return json(401, { error: "Unauthorized" });

  if (await rateLimitedGlobal(`upload:${userId}`, envInt("UPLOAD_PER_MINUTE", 10))) {
    return json(429, { error: "Too many uploads — wait a minute and try again." });
  }

  const url = new URL(request.url);
  const filename = (url.searchParams.get("filename") ?? "").slice(0, 200);
  const requestedName = url.searchParams.get("name") ?? filename.replace(/\.[^.]+$/, "");
  if (!filename) return json(400, { error: "Missing filename" });

  const format = detectFormat(filename, request.headers.get("Content-Type"));
  if (!format) {
    return json(400, {
      error: `Unsupported file type. Accepted formats: ${UPLOAD_ACCEPT.replace(/\./g, "").toUpperCase()}.`,
    });
  }

  const tableName = safeTableName(requestedName || "dataset");
  if (tableName.startsWith("__")) {
    return json(400, { error: "That table name is reserved." });
  }
  if (!request.body) return json(400, { error: "Empty request body" });

  // Reject an oversized upload from the declared length before reading it,
  // rather than streaming 2 GB only to refuse at the end.
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > uploadMaxBytes()) {
    return json(413, {
      error: `This file is larger than the ${(uploadMaxBytes() / (1024 * 1024)).toFixed(0)} MB upload limit.`,
    });
  }

  try {
    const result = await ingestUpload({
      userId,
      tableName,
      sourceFilename: filename,
      format,
      body: request.body,
    });
    auditEvent({
      userId,
      action: "dataset.upload",
      resourceType: "data_table",
      resourceName: result.tableName,
      resourceId: result.tableId,
      detail: {
        format: result.format,
        rows: result.rowCount,
        columns: result.columns.length,
        skipped: result.skipped,
        filename,
      },
    });
    return json(200, {
      ok: true,
      tableId: result.tableId,
      tableName: result.tableName,
      rowCount: result.rowCount,
      columns: result.columns,
      format: result.format,
      skipped: result.skipped,
    });
  } catch (e) {
    return json(400, { error: (e as Error).message, maxRows: uploadMaxRows() });
  }
}

export const Route = createFileRoute("/api/data/upload")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
