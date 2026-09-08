// Delta Sharing — GET /api/delta-sharing/shares/{share}/schemas
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateShare,
  requireShare,
  shareHandler,
  shareJson,
  sharePathOf,
  shareTables,
} from "@/utils/lakehouse/shares.server";

export const Route = createFileRoute("/api/delta-sharing/shares/$share/schemas")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        shareHandler(async () => {
          const auth = await authenticateShare(request);
          if (!auth.ok) return auth.response;
          const share = requireShare(auth.actor, sharePathOf(request).share);
          const schemas = [...new Set((await shareTables(auth.actor)).map((t) => t.schema_name))];
          return shareJson({ items: schemas.map((name) => ({ name, share: share.name })) });
        }),
    },
  },
});
