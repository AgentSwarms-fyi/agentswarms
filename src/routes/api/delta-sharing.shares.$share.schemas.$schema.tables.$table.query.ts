// Delta Sharing — POST /api/delta-sharing/shares/{share}/schemas/{schema}/tables/{table}/query
// NDJSON: protocol, metaData, then one file line per Parquet object, each
// with a presigned URL the client fetches directly. What is behind the URL
// is a governed snapshot — never the lakehouse's own files.
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateShare,
  queryShareTable,
  requireShare,
  requireShareTable,
  shareHandler,
  shareNdjson,
  sharePathOf,
} from "@/utils/lakehouse/shares.server";

const MAX_BODY_BYTES = 64 * 1024;

export const Route = createFileRoute(
  "/api/delta-sharing/shares/$share/schemas/$schema/tables/$table/query",
)({
  server: {
    handlers: {
      POST: async ({ request }) =>
        shareHandler(async () => {
          const auth = await authenticateShare(request);
          if (!auth.ok) return auth.response;
          const path = sharePathOf(request);
          requireShare(auth.actor, path.share);
          const st = await requireShareTable(auth.actor, path.schema, path.table);
          const text = await request.text();
          let body: unknown = {};
          if (text.trim() && text.length <= MAX_BODY_BYTES) {
            try {
              body = JSON.parse(text);
            } catch {
              body = {};
            }
          }
          const result = await queryShareTable(auth.actor, st, body);
          return shareNdjson(result.actions, { "Delta-Table-Version": String(result.version) });
        }),
    },
  },
});
