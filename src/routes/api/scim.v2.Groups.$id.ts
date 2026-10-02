// SCIM 2.0 — /api/scim/v2/Groups/:id
//   GET / PUT / PATCH / DELETE one group. PATCH carries member changes:
//   add `[{value: userId}]`, remove `members[value eq "userId"]`.
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateScim,
  deleteScimGroup,
  getScimGroup,
  idFromPath,
  patchScimGroup,
  readScimBody,
  replaceScimGroup,
  scimBaseUrl,
  scimHandler,
  scimJson,
} from "@/utils/scim.server";

export const Route = createFileRoute("/api/scim/v2/Groups/$id")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          return scimJson(await getScimGroup(idFromPath(request), scimBaseUrl(request)));
        }),
      PUT: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const body = await readScimBody(request);
          return scimJson(
            await replaceScimGroup(idFromPath(request), body, auth.actor, scimBaseUrl(request)),
          );
        }),
      PATCH: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const body = await readScimBody(request);
          return scimJson(
            await patchScimGroup(idFromPath(request), body, auth.actor, scimBaseUrl(request)),
          );
        }),
      DELETE: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          await deleteScimGroup(idFromPath(request), auth.actor);
          return new Response(null, { status: 204 });
        }),
    },
  },
});
