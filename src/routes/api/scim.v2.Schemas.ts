// SCIM 2.0 — /api/scim/v2/Schemas: the attributes of User and Group this
// server stores. An IdP reads it to know what to send; what is not here
// is accepted and ignored.
import { createFileRoute } from "@tanstack/react-router";

import { listResponse, schemas } from "@/lib/scim";
import { authenticateScim, scimBaseUrl, scimHandler, scimJson } from "@/utils/scim.server";

export const Route = createFileRoute("/api/scim/v2/Schemas")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const list = schemas(scimBaseUrl(request));
          return scimJson(listResponse(list, { startIndex: 1, count: list.length }));
        }),
    },
  },
});
