// Who is signed in, from the browser's own session (R298).
//
// Browser code asked the auth client for the user (`getUser`), a round trip to the
// auth server, and read any error from it as "nobody is signed in". With that
// one request failing, a signed-in person was told "Not signed in" on Save in
// the skill editor; "Duplicate to my skills" did nothing at all; and the SQL
// engine, deciding by the caller's id which tables are shared with them, read
// a shared dataset as their own - which RLS no longer serves - so it came back
// empty without a word.
//
// The browser already holds the session it signs every request with; the
// server checks the token on each of those requests anyway. The user is read
// from that session, with no round trip to fail.
import type { User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

/** The signed-in user from the stored session, or null when there is none. */
export async function sessionUser(): Promise<User | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}
