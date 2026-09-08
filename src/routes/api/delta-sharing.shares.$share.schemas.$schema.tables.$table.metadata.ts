// Delta Sharing — GET /api/delta-sharing/shares/{share}/schemas/{schema}/tables/{table}/metadata
// NDJSON: the protocol line, then the table's metaData (schema, files, size).
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateShare,
  requireShare,
  requireShareTable,
  shareHandler,
  shareNdjson,
  sharePathOf,
  tableMetadata,
} from "@/utils/lakehouse/shares.server";

export const Route = createFileRoute(
  "/api/delta-sharing/shares/$share/schemas/$schema/tables/$table/metadata",
)({
  server: {
    handlers: {
      GET: async ({ request }) =>
        shareHandler(async () => {
          const auth = await authenticateShare(request);
          if (!auth.ok) return auth.response;
          const path = sharePathOf(request);
          requireShare(auth.actor, path.share);
          const st = await requireShareTable(auth.actor, path.schema, path.table);
          const meta = await tableMetadata(auth.actor, st);
          return shareNdjson(meta.actions, { "Delta-Table-Version": String(meta.version) });
        }),
    },
  },
});
