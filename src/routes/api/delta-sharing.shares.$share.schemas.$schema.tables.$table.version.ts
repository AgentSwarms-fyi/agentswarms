// Delta Sharing — GET /api/delta-sharing/shares/{share}/schemas/{schema}/tables/{table}/version
// The version travels in the Delta-Table-Version header; the body is empty.
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateShare,
  requireShare,
  requireShareTable,
  shareHandler,
  sharePathOf,
  tableVersion,
} from "@/utils/lakehouse/shares.server";

export const Route = createFileRoute(
  "/api/delta-sharing/shares/$share/schemas/$schema/tables/$table/version",
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
          const version = await tableVersion(auth.actor, st);
          return new Response(null, {
            status: 200,
            headers: { "Delta-Table-Version": String(version) },
          });
        }),
    },
  },
});
