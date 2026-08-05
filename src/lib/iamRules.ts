// Model allow-list matching, in one place.
//
// This decides whether a user may call a given model. It was implemented three
// times — the server check in iam.server.ts, the client mirror in
// use-iam.ts, and a provider-agnostic variant for catalog pickers — each a
// hand-copied version of the same eight lines.
//
// They agree today; I diffed them. Nothing keeps them in step, and the failure
// mode is the quiet kind: the UI offers a model the server then refuses, or
// worse, the UI hides one the server would have allowed and an admin concludes
// the rule works when it does not. This is the same argument that put the SQL
// read-only guard and the shared-dataset restriction each in a single module.
//
// FAIL CLOSED on the rules themselves: an EMPTY rule list allows nothing. The
// "no restriction" case is `null`, and the distinction matters — see
// isModelAllowed.

/** The shape both the server row and the client row satisfy. */
export type ModelRuleLike = { provider: string; model_pattern: string };

/**
 * Does one pattern cover this model id?
 *
 * Supported forms, deliberately only these: `*` (everything), an exact id, and
 * a trailing-`*` prefix. No regex and no mid-string wildcards — an admin
 * writing an allow-list should not have to reason about catastrophic
 * backtracking or about what `.` means, and a pattern language nobody can
 * predict is a security control nobody can audit.
 */
export function modelPatternMatches(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  if (pattern === model) return true;
  // `"*"` alone is handled above, so a lone `*` cannot reach here as a prefix.
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * May this user call `provider`/`model` under these rules?
 *
 * `rules` is the list of rules that APPLY to the user. Callers must pass
 * `null` — not `[]` — to mean "this user is unrestricted": an empty array is
 * a real allow-list that permits nothing, and conflating the two would turn a
 * user with no applicable rules into a user who may call anything. The loaders
 * return `null` for the unrestricted case for exactly this reason.
 */
export function isModelAllowed(
  rules: ModelRuleLike[] | null | undefined,
  provider: string,
  model: string,
): boolean {
  if (rules == null) return true;
  return rules.some((r) => r.provider === provider && modelPatternMatches(r.model_pattern, model));
}

/**
 * Provider-agnostic match, for pickers that list a catalogue before the
 * calling provider is known. Looser than isModelAllowed BY DESIGN, so it must
 * never be used to authorise a call — only to decide what to show.
 */
export function modelMatchesAnyRule(
  rules: ModelRuleLike[] | null | undefined,
  model: string,
): boolean {
  if (rules == null) return true;
  return rules.some((r) => modelPatternMatches(r.model_pattern, model));
}

/** Providers with at least one rule; null when unrestricted. */
export function allowedProviders(rules: ModelRuleLike[] | null | undefined): Set<string> | null {
  if (rules == null) return null;
  return new Set(rules.map((r) => r.provider));
}

/** Instance-wide default for users with NO applicable model rules. */
export type ModelAccessDefault = "allow" | "deny";

/**
 * Collapse instance policy + role + applicable rules into the one value
 * isModelAllowed understands: `null` (unrestricted), a real allow-list, or
 * `[]` (deny everything — see the fail-closed note above).
 *
 * One function, used by the server loader AND the browser hook, because the
 * whole point of a default-deny mode is lost if the two disagree about what
 * "no rules" means.
 *
 *   allow mode — exactly the historical behaviour: no rules ⇒ null.
 *   deny mode  — no rules ⇒ [] for regular users: nothing is callable until
 *                an admin grants it. Superadmins collapse to null — they
 *                administer the allow-lists, so rules never lock THEM out —
 *                and that bypass applies in deny mode only: in allow mode a
 *                rule written against an admin still applies, as it always
 *                has.
 */
export function collapseModelPolicy(opts: {
  mode: ModelAccessDefault;
  isSuperadmin: boolean;
  applicable: ModelRuleLike[];
}): ModelRuleLike[] | null {
  if (opts.mode === "deny") {
    if (opts.isSuperadmin) return null;
    return opts.applicable.length > 0 ? opts.applicable : [];
  }
  return opts.applicable.length > 0 ? opts.applicable : null;
}
