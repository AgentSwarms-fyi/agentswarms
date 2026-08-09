// What to call the person, given everywhere the app stores a name.
//
// There are two stores and they disagree. `profiles` is what the Account page
// WRITES — first_name, last_name, display_name — and what UserMenu and
// OnboardingDialog READ. `auth.user_metadata.full_name` is only ever set at
// sign-up, by an admin invite or an OAuth provider; an ordinary email sign-up
// leaves it empty forever.
//
// The dashboard read only the auth metadata, so it greeted the one real user on
// this instance as "Rghosh044" — mechanically derived from their email — while
// their profile said "Rohan" and the sidebar two inches away said "Rohan
// Ghosh". Filling in your name on the Account page changed nothing.
//
// Pure and separate from the page so the precedence is testable without a
// session, a Supabase client or a render.

export type NameSources = {
  /** profiles.first_name — what the Account page asks for explicitly. */
  firstName?: string | null;
  /** profiles.display_name — may be a full name, or default to the email. */
  displayName?: string | null;
  /** auth user_metadata.full_name / .name — set at sign-up, often absent. */
  metaFullName?: string | null;
  email?: string | null;
};

/** First word of a name, e.g. "Rohan Ghosh" -> "Rohan". */
function firstWord(value: string | null | undefined): string {
  return (value ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * A greeting is a FIRST name, so every source is reduced to one word.
 *
 * Order: what the user typed about themselves, then what a provider claimed,
 * then the email. `display_name` defaults to the email address for accounts
 * created by an admin, so an address there is skipped rather than greeted as a
 * name — otherwise a provisioned user gets "Welcome back, rohan@acme.com".
 */
export function greetingName(sources: NameSources, fallback = "there"): string {
  const first = firstWord(sources.firstName);
  if (first) return first;

  const display = firstWord(sources.displayName);
  if (display && !display.includes("@")) return display;

  const meta = firstWord(sources.metaFullName);
  if (meta) return meta;

  const local = (sources.email ?? "").split("@")[0];
  if (!local) return fallback;
  return local.charAt(0).toUpperCase() + local.slice(1);
}
