// SCIM 2.0 — /api/scim/v2/ServiceProviderConfig: what this server supports,
// stated so an IdP does not try bulk or sorting and read the 4xx as a fault.
import { createFileRoute } from "@tanstack/react-router";

import { serviceProviderConfig } from "@/lib/scim";
import { authenticateScim, scimBaseUrl, scimHandler, scimJson } from "@/utils/scim.server";

export const Route = createFileRoute("/api/scim/v2/ServiceProviderConfig")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          return scimJson(serviceProviderConfig(scimBaseUrl(request)));
        }),
    },
  },
});
