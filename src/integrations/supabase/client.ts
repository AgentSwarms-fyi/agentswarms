// This file was generated, and has since been edited on purpose (R301): the
// client's fetch strips NUL characters from writes (see ./nulSafeFetch), and
// (R464) the browser's URL and key come from publicConfig, which reads them at
// runtime (PUBLIC_*) before falling back to the build-time VITE_* values.
// Keep both if it is regenerated.
import { createClient } from "@supabase/supabase-js";
import { publicConfig } from "@/lib/publicConfig";
import { nulSafeFetch } from "./nulSafeFetch";
import type { Database } from "./types";

function createSupabaseClient() {
  // The browser's values first (runtime PUBLIC_*, then build-time VITE_*).
  // During server rendering, the server's own SUPABASE_* are the fallback;
  // `process` does not exist in the browser, hence the typeof guard.
  const { supabaseUrl, supabasePublishableKey } = publicConfig();
  const serverEnv = typeof process !== "undefined" ? process.env : {};
  const SUPABASE_URL = supabaseUrl || serverEnv.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = supabasePublishableKey || serverEnv.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "Missing Supabase environment variables. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, and for the browser PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY (or the build-time VITE_ versions), in your .env file.",
    );
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: typeof window !== "undefined" ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    },
    global: { fetch: nulSafeFetch },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
