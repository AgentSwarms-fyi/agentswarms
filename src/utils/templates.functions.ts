// What the template gallery (R530) asks the server: whether the person looking
// has a model and the lakehouse, the two needs a template can be checked for.
// The templates themselves are a client-side list (src/lib/templateGallery.ts).
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type TemplateReadiness = { model: boolean; lakehouse: boolean };

export const templateReadiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(() => ({}))
  .handler(async ({ context }): Promise<TemplateReadiness> => {
    const ctx = context as { supabase: SupabaseClient<Database>; userId: string };
    const { hasModelAccess } = await import("@/utils/tutorials/progress.server");
    const { lakehouseEnabled } = await import("@/utils/lakehouse/core.server");
    return {
      model: await hasModelAccess(ctx.supabase, ctx.userId),
      lakehouse: lakehouseEnabled(),
    };
  });
