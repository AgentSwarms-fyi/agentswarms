// Delta Sharing — GET /api/delta-sharing/shares: the share this token names.
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateShare,
  shareHandler,
  shareItem,
  shareJson,
} from "@/utils/lakehouse/shares.server";

export const Route = createFileRoute("/api/delta-sharing/shares")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        shareHandler(async () => {
          const auth = await authenticateShare(request);
          if (!auth.ok) return auth.response;
          return shareJson({ items: [shareItem(auth.actor)] });
        }),
    },
  },
});
