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

/** What a column name suggests it holds (R521; passwords, keys and places of birth R558). */
export type PiiNameKind =
  | "email"
  | "ip"
  | "card"
  | "bank_account"
  | "national_id"
  | "password"
  | "secret"
  | "phone"
  | "birth_place"
  | "birth_date"
  | "person_name"
  | "address"
  | "pay"
  | "gender";

/**
 * Terms that suggest personal data, by what they suggest, matched as whole
 * `_`/`-`/space-delimited words so `order_id` does not match on "id". A term
 * may be numbered (`address2`, `phone_1`).
 *
 * MOST SPECIFIC FIRST: `email_address` and `ip_address` also hold the word
 * "address", and are email addresses and IP addresses, not postal ones; a
 * token sent to confirm an email change (`email_change_token_new`) is a key,
 * not an address; `birth_country` is a place, not a date. Within a kind the
 * longer spelling comes first, so the match ends where the term does.
 *
 * Passwords and keys have no shape the values could show (a hash is a hash),
 * so their names are all there is (FOUND R558: every password column of the
 * public schemas in `piiNameCorpus.test.ts` went unmarked, and the catalog
 * kept one of its values as the column's sample).
 */
const TERMS: ReadonlyArray<readonly [PiiNameKind, string]> = [
  ["password", "password|passwd|pwd|passcode"],
  ["secret", "api[-_]?key|apikey|secret[-_]?key|client[-_]?secret|private[-_]?key|secret|token"],
  ["email", "e[-_]?mail"],
  ["ip", "ip(?:v[46])?[-_]?address"],
  ["card", "credit[-_]?card|card[-_]?number|cvv"],
  ["bank_account", "iban|swift"],
  [
    "national_id",
    "social[-_]?security|national[-_]?insurance|national[-_]?id|ssn|passport|tax[-_]?id|" +
      "driver[-_]?license|aadhaar|aadhar|pan[-_]?(?:number|no|card)",
  ],
  ["phone", "phone|mobile|fax"],
  [
    "birth_place",
    "place[-_]?of[-_]?birth|country[-_]?of[-_]?birth|city[-_]?of[-_]?birth|" +
      "birth[-_]?place|birth[-_]?country|birth[-_]?city",
  ],
  ["birth_date", "date[-_]?of[-_]?birth|birth[-_]?date|birthday|dob|birth"],
  [
    "person_name",
    "first[-_]?name|last[-_]?name|full[-_]?name|middle[-_]?name|given[-_]?name|" +
      "family[-_]?name|maiden[-_]?name|contact[-_]?name|surname|forename",
  ],
  ["address", "address|street|zip[-_]?code|zip|postal[-_]?code|post[-_]?code|pin[-_]?code"],
  ["pay", "salary|income"],
  ["gender", "gender"],
];

// The lookahead leaves the delimiter after a term unmatched, so a match ends
// exactly where its term (and any number on it) does.
const word = (terms: string) => new RegExp(`(^|[_\\s-])(?:${terms})\\d*(?=[_\\s-]|$)`, "i");
const BY_KIND = TERMS.map(([kind, terms]) => [kind, word(terms)] as const);

// ── About a thing, or holding it ───────────────────────────────────────────
//
// FOUND R558, on the public schemas: `address_id`, `PhoneNumberTypeID`,
// `CreditCardID`, `email_confirmed_at` and `ca_street_type` were all marked as
// holding what they only point at, time or describe. That is not free: since
// R554–R557 a marked column is put to its owner as one to hide from shares,
// keeps no sample in the catalog, and its failing quality checks show no
// examples (an accepted-values check on `phone_type` said nothing useful).
//
// The LAST word of a name says what the column holds; when it comes after the
// term and is one of these, the column is about the thing.

/** A key to a row elsewhere. */
const KEY_WORDS = ["id", "sk", "key", "fk", "ref", "uuid", "guid"];
/** When something happened to it. */
const TIME_WORDS = ["at", "on", "time", "ts", "timestamp", "date", "until", "expiry", "expires"];
/** What sort of it, whether it holds, how many. */
const DESCRIBING_WORDS = [
  "type",
  "status",
  "kind",
  "category",
  "source",
  "format",
  "provider",
  "domain",
  "count",
  "cnt",
  "length",
  "len",
  "flag",
  "verified",
  "confirmed",
  "enabled",
  "disabled",
  "valid",
  "consent",
];

/**
 * For each kind, the last words that make a name about it. Not every kind
 * takes all three:
 * - a key to an email, a password or a secret stays marked: in common usage an
 *   "email id" IS an address, and a `secret_id` is often the credential itself;
 * - a key to a birth date, a birthplace, a pay band or a national id encodes it
 *   (`birth_date_sk` is a date-dimension key, which is the date);
 * - a birth date's own column is a date, so the time words do not apply;
 * - gender, however it is spelled or keyed, is gender.
 */
const ABOUT: Record<PiiNameKind, ReadonlySet<string>> = (() => {
  const all = new Set([...KEY_WORDS, ...TIME_WORDS, ...DESCRIBING_WORDS]);
  const noKeys = new Set([...TIME_WORDS, ...DESCRIBING_WORDS]);
  return {
    password: noKeys,
    secret: noKeys,
    email: noKeys,
    ip: all,
    card: all,
    bank_account: noKeys,
    national_id: noKeys,
    phone: all,
    birth_place: noKeys,
    birth_date: new Set(DESCRIBING_WORDS),
    person_name: all,
    address: all,
    pay: noKeys,
    gender: new Set<string>(),
  };
})();

/** A first word that makes the whole column a yes/no: `is_email_verified`, `has_phone`. */
const FLAG_PREFIXES = new Set(["is", "has"]);

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

/**
 * What kind of personal data a column name suggests, or null: the first kind
 * whose term the name holds rather than is about.
 */
export function piiNameKind(name: string): PiiNameKind | null {
  const words = toWords(name);
  const parts = words.split(/[_\s-]+/).filter(Boolean);
  if (FLAG_PREFIXES.has(parts[0])) return null;
  const last = parts[parts.length - 1];
  for (const [kind, re] of BY_KIND) {
    const m = re.exec(words);
    if (!m) continue;
    const after = words.slice(m.index + m[0].length).replace(/[_\s-]/g, "");
    if (after && ABOUT[kind].has(last)) continue;
    return kind;
  }
  return null;
}

/** True when a column name suggests it holds personal data. */
export function isPiiColumnName(name: string): boolean {
  return piiNameKind(name) !== null;
}
