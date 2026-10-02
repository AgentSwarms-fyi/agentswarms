// Delta Sharing — GET /api/delta-sharing/shares/{share}
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateShare,
  requireShare,
  shareHandler,
  shareItem,
  shareJson,
  sharePathOf,
} from "@/utils/lakehouse/shares.server";

export const Route = createFileRoute("/api/delta-sharing/shares/$share")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        shareHandler(async () => {
          const auth = await authenticateShare(request);
          if (!auth.ok) return auth.response;
          requireShare(auth.actor, sharePathOf(request).share);
          return shareJson({ share: shareItem(auth.actor) });
        }),
    },
  },
});
