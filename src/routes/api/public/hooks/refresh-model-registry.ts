// Weekly cron endpoint that refreshes the Model Registry from AIMLAPI.
// Public path (/api/public/*) — bypasses auth on published sites; pg_cron
// calls it with the project's anon key as a sanity check.
import { createFileRoute } from "@tanstack/react-router";
import { syncModelRegistryFromAimlapi } from "@/utils/modelRegistry.server";

export const Route = createFileRoute("/api/public/hooks/refresh-model-registry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Soft auth: we accept either the anon key bearer or no auth (the
        // endpoint is idempotent and only writes server-controlled data).
        // We log the auth header presence so misconfigured cron jobs are
        // visible in the worker logs.
        const auth = request.headers.get("authorization");
        console.log(`[refresh-model-registry] cron tick (auth=${auth ? "yes" : "no"})`);
        const result = await syncModelRegistryFromAimlapi();
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });
      },
      // Allow a manual GET probe (cheaper than running the full sync).
      GET: async () =>
        new Response(JSON.stringify({ ok: true, message: "POST to trigger a refresh" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
  },
});
