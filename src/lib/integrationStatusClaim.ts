// What a connection badge is entitled to claim about a read it may not have
// completed.
//
// lib/listClaim covers the count-and-empty-state shape: "My skills (0)" plus
// "you haven't created any yet". This page has neither a count nor an empty
// state, and that is exactly why the same defect survived here longer. The
// Integration Hub's entire vocabulary for connection status is a badge and a
// Disconnect button, so ABSENCE is how it says "not connected" — and absence is
// also what it renders when it could not find out.
//
// MEASURED on /integrations, with the failure positively confirmed rather than
// inferred (see docs/ADVERSARIAL_LOG.md, module 16). A 403 injected on the
// `integrations` read alone, re-triggered by a client-side remount so the patch
// stayed installed:
//
//                        | injected 403 | control, same path
//   ---------------------|--------------|-------------------
//   read intercepted     | 2            | 0
//   "Connected" on page  | 0            | 2
//   "Disconnect" on page | 0            | 2
//   any error text       | none         | —
//
// The account had Gemini and OpenRouter connected throughout. Both reads
// discarded their error (`const [{ data: integ }, { data: creds }] = ...`), so
// there was nothing left to report even if the page had wanted to.
//
// The sharp edge is the same one the campaign keeps meeting: the page does not
// merely withhold the connection, it presents a connected provider exactly as
// it presents one that was never configured — beside a Configure button. The
// obvious response is to paste the API key in again.

/** A read that feeds a status badge, and how it went. */
export type StatusReadState = {
  /** The read has returned, one way or the other. */
  loaded: boolean;
  /** Why it failed, or null if it succeeded. */
  error: string | null;
};

/** What the rows say about one provider, once they have actually been read. */
export type ProviderFacts = {
  /** A row exists for this provider and is active. */
  active: boolean;
  /** A row exists at all — saved, but its last live test failed. */
  saved: boolean;
  /** An admin granted use of their credential to this user. */
  shared: boolean;
  /** The last scheduled health check on an active provider failed. */
  unhealthy: boolean;
};

/**
 * Which badge a provider card may show.
 *
 * `"unknown"` is the addition that matters. Before this existed the only way to
 * render "we could not find out" was `null` — the same thing the card renders
 * for a provider nobody has ever configured.
 */
export type ProviderBadge =
  | "connected"
  | "connected-unhealthy"
  | "saved-failed"
  | "shared"
  | "unknown"
  | "none";

export function providerBadge(read: StatusReadState, facts: ProviderFacts): ProviderBadge {
  // A failed read outranks every fact below it, because every fact below it was
  // derived from rows that did not arrive. `active: false` after a 403 is not a
  // finding about the provider.
  if (read.error) return "unknown";

  // Nothing has come back yet. Rendering "not connected" here is the same lie
  // told a few hundred milliseconds earlier, and it is the one users actually
  // hit — first paint happens on every visit.
  if (!read.loaded) return "unknown";

  if (facts.active) return facts.unhealthy ? "connected-unhealthy" : "connected";
  if (facts.saved) return "saved-failed";
  if (facts.shared) return "shared";
  return "none";
}

/**
 * May the page offer to disconnect this provider?
 *
 * Only when a successful read says there is something to disconnect. This is
 * separate from the badge because the button is a WRITE: firing it against a
 * provider whose rows never loaded would resolve `existing` to undefined and
 * do nothing at all, which is a dead control rather than an honest refusal.
 */
export function mayOfferDisconnect(read: StatusReadState, facts: ProviderFacts): boolean {
  return !read.error && read.loaded && facts.active;
}

/**
 * The notice the page owes the user when the reads behind every badge failed.
 *
 * Deliberately reassuring about the state of the account, because the failure
 * mode being fixed is a user concluding their credentials are gone and typing
 * them in again. Nothing was lost; the page just cannot see it.
 */
export function integrationsReadNotice(read: StatusReadState): string | null {
  if (!read.error) return null;
  return `Your connected integrations could not be loaded — ${read.error}. Anything you have connected is still connected; this page just cannot show it right now.`;
}
