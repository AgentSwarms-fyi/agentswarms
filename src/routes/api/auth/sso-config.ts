// Public (pre-auth) endpoint the login page uses to decide which sign-in
// options to render. Exposes only the two instance-level SSO flags — no
// provider details.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/auth/sso-config")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { data } = await supabaseAdmin
            .from("iam_settings")
            .select("sso_enabled, sso_enforced")
            .eq("id", true)
            .maybeSingle();
          return Response.json({
            enabled: data?.sso_enabled ?? false,
            enforced: data?.sso_enforced ?? false,
          });
        } catch {
          // Fail open to the native login experience.
          return Response.json({ enabled: false, enforced: false });
        }
      },
    },
  },
});
