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

/**
 * Terms that suggest personal data, matched as whole `_`/`-`/space-delimited
 * words so `order_id` does not match on "id".
 */
const PII_RE =
  /(^|[_\s-])(email|e[-_]?mail|phone|mobile|ssn|social[-_]?security|passport|dob|birth|birth[-_]?date|birthday|address|street|zip[-_]?code|postal[-_]?code|salary|income|iban|swift|credit[-_]?card|card[-_]?number|cvv|tax[-_]?id|national[-_]?id|driver[-_]?license|first[-_]?name|last[-_]?name|full[-_]?name|surname|gender|ip[-_]?address)([_\s-]|$)/i;

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

/** True when a column name suggests it holds personal data. */
export function isPiiColumnName(name: string): boolean {
  return PII_RE.test(toWords(name));
}
