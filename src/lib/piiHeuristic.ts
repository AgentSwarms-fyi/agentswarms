// Column-name heuristic for "this probably holds personal data".
//
// ONE implementation, imported by both the crawler (which stores the flag) and
// the catalog UI (which shows it for columns the crawler has not classified).
// It lived in two places before: `lib/dataCatalog` imports the browser Supabase
// client so `utils/catalog/crawler.server` could not import it, and the copy
// there was labelled "client-side mirror of the crawler's heuristic".
//
// The two copies happened to be identical, and nothing would have said so if
// they were not — which is precisely how the warehouse read-only guard ended up
// missing its mutation denylist while a comment claimed both copies were "in
// sync in spirit". A mirror with no test is a divergence waiting for its first
// edit.
//
// ADVISORY, AND DELIBERATELY OVER-INCLUSIVE. The flag marks a column for a
// human to look at; it masks nothing by itself. So a false positive costs
// someone a glance (`email_campaign_id` is flagged, and that is fine) while a
// false negative means a column of dates of birth is never surfaced for review.
// When in doubt, match.

/** What a column name suggests it holds (R521). */
export type PiiNameKind =
  | "email"
  | "ip"
  | "card"
  | "bank_account"
  | "national_id"
  | "phone"
  | "birth_date"
  | "person_name"
  | "address"
  | "pay"
  | "gender";

/**
 * Terms that suggest personal data, by what they suggest, matched as whole
 * `_`/`-`/space-delimited words so `order_id` does not match on "id".
 *
 * MOST SPECIFIC FIRST: `email_address` and `ip_address` also hold the word
 * "address", and are email addresses and IP addresses, not postal ones.
 */
const TERMS: ReadonlyArray<readonly [PiiNameKind, string]> = [
  ["email", "email|e[-_]?mail"],
  ["ip", "ip[-_]?address"],
  ["card", "credit[-_]?card|card[-_]?number|cvv"],
  ["bank_account", "iban|swift"],
  ["national_id", "ssn|social[-_]?security|passport|tax[-_]?id|national[-_]?id|driver[-_]?license"],
  ["phone", "phone|mobile"],
  ["birth_date", "dob|birth|birth[-_]?date|birthday"],
  ["person_name", "first[-_]?name|last[-_]?name|full[-_]?name|surname"],
  ["address", "address|street|zip[-_]?code|postal[-_]?code"],
  ["pay", "salary|income"],
  ["gender", "gender"],
];

const word = (terms: string) => new RegExp(`(^|[_\\s-])(${terms})([_\\s-]|$)`, "i");
const BY_KIND = TERMS.map(([kind, terms]) => [kind, word(terms)] as const);

/**
 * Split camelCase and PascalCase into delimited words.
 *
 * Without this the heuristic missed `emailAddress` and `EmailAddress` entirely:
 * the term list is anchored on `_`/`-`/space boundaries, and a camelCase name
 * has none, so "email" was never at a word edge. Databases that name columns
 * that way had no PII detection at all.
 */
function toWords(name: string): string {
  return (name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** What kind of personal data a column name suggests, or null. */
export function piiNameKind(name: string): PiiNameKind | null {
  const words = toWords(name);
  for (const [kind, re] of BY_KIND) if (re.test(words)) return kind;
  return null;
}

/** True when a column name suggests it holds personal data. */
export function isPiiColumnName(name: string): boolean {
  return piiNameKind(name) !== null;
}
