// Registers global server-fn middleware. Without `attachSupabaseAuth`,
// every protected serverFn call goes out without an Authorization header
// and `requireSupabaseAuth` rejects it with 401 — which silently breaks
// embedding, memory, traces, etc.
//
// Note: any future middleware added here runs on ALL server functions.
// Keep authentication-only concerns here; per-route logic belongs in the
// individual `createServerFn` chain.
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

// Server functions are same-origin RPC, so a call from another site is
// refused with 403 (R359). With no start instance TanStack applies this check
// itself; an instance that sets no requestMiddleware, as this one did, gets no
// check at all, and the warning about it prints only in development, so
// production never said. A browser call passes on Sec-Fetch-Site (or Origin,
// or Referer); a call with none of them is refused too. Nothing calls a
// server function over HTTP but the app's own pages. API routes (/api/…:
// health, the AI gateway, MCP) are not server functions and are not filtered.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [attachSupabaseAuth],
}));
