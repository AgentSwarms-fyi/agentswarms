// SCIM 2.0 — /api/scim/v2/Groups
//   GET   list groups, or look one up with ?filter=displayName eq "x"
//   POST  create a group with its members (201)
// A SCIM group is an IAM group: grants and model rules may name it, and a
// member the IdP adds inherits both at once.
import { createFileRoute } from "@tanstack/react-router";

import { listResponse, readPage } from "@/lib/scim";
import {
  authenticateScim,
  createScimGroup,
  listScimGroups,
  readScimBody,
  scimBaseUrl,
  scimHandler,
  scimJson,
} from "@/utils/scim.server";

export const Route = createFileRoute("/api/scim/v2/Groups")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const url = new URL(request.url);
          const groups = await listScimGroups(url.searchParams.get("filter"), scimBaseUrl(request));
          return scimJson(listResponse(groups, readPage(url)));
        }),
      POST: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const body = await readScimBody(request);
          const group = await createScimGroup(body, auth.actor, scimBaseUrl(request));
          return scimJson(group, 201, { Location: group.meta.location });
        }),
    },
  },
});
