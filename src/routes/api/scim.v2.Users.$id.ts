// SCIM 2.0 — /api/scim/v2/Users/:id
//   GET     the user
//   PUT     replace the attributes this server stores
//   PATCH   change some (Okta and Entra both deactivate this way: active=false)
//   DELETE  remove the account (204). A superadmin is refused with 403.
import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateScim,
  deleteScimUser,
  getScimUser,
  idFromPath,
  patchScimUser,
  readScimBody,
  replaceScimUser,
  scimBaseUrl,
  scimHandler,
  scimJson,
} from "@/utils/scim.server";

export const Route = createFileRoute("/api/scim/v2/Users/$id")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          return scimJson(await getScimUser(idFromPath(request), scimBaseUrl(request)));
        }),
      PUT: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const body = await readScimBody(request);
          return scimJson(
            await replaceScimUser(idFromPath(request), body, auth.actor, scimBaseUrl(request)),
          );
        }),
      PATCH: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          const body = await readScimBody(request);
          return scimJson(
            await patchScimUser(idFromPath(request), body, auth.actor, scimBaseUrl(request)),
          );
        }),
      DELETE: async ({ request }) =>
        scimHandler(async () => {
          const auth = await authenticateScim(request);
          if (!auth.ok) return auth.response;
          await deleteScimUser(idFromPath(request), auth.actor);
          return new Response(null, { status: 204 });
        }),
    },
  },
});
