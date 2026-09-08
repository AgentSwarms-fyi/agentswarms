// SCIM 2.0 — /api/scim/v2/ResourceTypes: User and Group, nothing else.
import { createFileRoute } from "@tanstack/react-router";

import { listResponse, resourceTypes } from "@/lib/scim";
import { authenticateScim, scimBaseUrl, scimHandler, scimJson } from "@/utils/scim.server";

export const Route = createFileRoute("/api/scim/v2/ResourceTypes")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const types = resourceTypes(scimBaseUrl(request));
          return scimJson(listResponse(types, { startIndex: 1, count: types.length }));
        }),
    },
  },
});
