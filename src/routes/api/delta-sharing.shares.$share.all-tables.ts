// Delta Sharing — GET /api/delta-sharing/shares/{share}/all-tables
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

export const Route = createFileRoute("/api/delta-sharing/shares/$share/all-tables")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        shareHandler(async () => {
          const auth = await authenticateShare(request);
          if (!auth.ok) return auth.response;
          requireShare(auth.actor, sharePathOf(request).share);
          const tables = await shareTables(auth.actor);
          return shareJson({ items: tables.map((t) => tableItem(auth.actor, t)) });
        }),
    },
  },
});
