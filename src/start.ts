// Registers global server-fn middleware. Without `attachSupabaseAuth`,
// every protected serverFn call goes out without an Authorization header
// and `requireSupabaseAuth` rejects it with 401 — which silently breaks
// embedding, memory, traces, etc.
//
// Note: any future middleware added here runs on ALL server functions.
// Keep authentication-only concerns here; per-route logic belongs in the
// individual `createServerFn` chain.
import { createStart } from "@tanstack/react-start";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
}));
