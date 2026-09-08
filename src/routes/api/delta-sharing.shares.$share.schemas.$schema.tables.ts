// Delta Sharing — GET /api/delta-sharing/shares/{share}/schemas/{schema}/tables
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateShare,
  requireShare,
  shareHandler,
  shareJson,
  sharePathOf,
  shareTables,
  tableItem,
} from "@/utils/lakehouse/shares.server";

export const Route = createFileRoute("/api/delta-sharing/shares/$share/schemas/$schema/tables")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        shareHandler(async () => {
          const auth = await authenticateShare(request);
          if (!auth.ok) return auth.response;
          const path = sharePathOf(request);
          requireShare(auth.actor, path.share);
          const tables = await shareTables(auth.actor, path.schema);
          return shareJson({ items: tables.map((t) => tableItem(auth.actor, t)) });
        }),
    },
  },
});
