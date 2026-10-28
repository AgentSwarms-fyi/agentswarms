// POST /api/public/hooks/refresh-model-registry — refresh the Model Registry
// from AIMLAPI.
//
// A refresh fetches the upstream catalogue and upserts or deletes every
// registry row, so it is not anyone's to start. It took POST with no auth and
// no throttle (VA-2026-10-25-19). It now answers the operator's external cron
// holding BI_CRON_TOKEN — the bearer /api/bi/cron takes — or a superadmin's
// session, as the registry page's own Sync does; and at most
// MODEL_REGISTRY_SYNC_PER_MIN refreshes run a minute (default 2). The GET
// probe stays public: it reads nothing and starts nothing.
import { createFileRoute } from "@tanstack/react-router";
import { staticCronCaller } from "@/utils/cronCaller.server";
import { syncModelRegistryFromAimlapi } from "@/utils/modelRegistry.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const Route = createFileRoute("/api/public/hooks/refresh-model-registry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.replace(/^Bearer\s+/i, "").trim();
        if (!bearer) return json({ error: "Unauthorized" }, 401);

        // The operator's cron, compared in constant time; otherwise a session,
        // which must be a superadmin's.
        const byCron =
          staticCronCaller(bearer, { cronToken: process.env.BI_CRON_TOKEN }) === "cron";
        if (!byCron) {
          const { requireSuperadmin } = await import("@/utils/iam.server");
          const guard = await requireSuperadmin(bearer);
          if (!guard.ok) {
            return json(
              { error: "Only the operator's cron or a superadmin can refresh the model registry" },
              403,
            );
          }
        }

        if (
          await rateLimitedGlobal("model-registry-sync", envInt("MODEL_REGISTRY_SYNC_PER_MIN", 2))
        ) {
          return json(
            { error: "The model registry was refreshed moments ago — try again in a minute" },
            429,
          );
        }

        console.log(`[refresh-model-registry] refresh by ${byCron ? "cron" : "a superadmin"}`);
        const result = await syncModelRegistryFromAimlapi();
        return json(result, result.ok ? 200 : 500);
      },
      // A probe: says the hook is here, starts nothing.
      GET: async () => json({ ok: true, message: "POST to trigger a refresh" }, 200),
    },
  },
});
