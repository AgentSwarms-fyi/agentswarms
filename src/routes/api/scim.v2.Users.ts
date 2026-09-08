// SCIM 2.0 — /api/scim/v2/Users
//   GET   list users, or look one up with ?filter=userName eq "x"
//   POST  create a user (201 with the resource)
// Every request carries the provisioning token from the SSO tab. See
// docs/IAM.md § Users and groups pushed from the IdP.
import { createFileRoute } from "@tanstack/react-router";

import { listResponse, readPage } from "@/lib/scim";
import {
  authenticateScim,
  createScimUser,
  listScimUsers,
  readScimBody,
  scimBaseUrl,
  scimHandler,
  scimJson,
} from "@/utils/scim.server";

export const Route = createFileRoute("/api/scim/v2/Users")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const url = new URL(request.url);
          const users = await listScimUsers(url.searchParams.get("filter"), scimBaseUrl(request));
          return scimJson(listResponse(users, readPage(url)));
        }),
      POST: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const body = await readScimBody(request);
          const user = await createScimUser(body, auth.actor, scimBaseUrl(request));
          return scimJson(user, 201, { Location: user.meta.location });
        }),
    },
  },
});
