// Matching a column of location values to countries on a map.
//
// This is the whole rule — normalisation, aliases, ISO alpha-2 and ISO
// numeric — with no atlas in it. The caller supplies the shapes it can draw
// as two indexes and gets back one of its own objects, so the rule can be
// exercised directly instead of re-implemented in a test. It lives apart from
// BiGeoMap for exactly that reason: the earlier version was private to the
// component, the test restated it, and a mutation that deleted the numeric
// path from the component sailed past a green suite.
//
// Codes are not a nicety: country data is stored as alpha-2 far more often
// than as prose. Before codes were handled, a column of them matched TWO of
// the 280 assigned alpha-2 codes — "US" and "UK" — and "UK" is not even ISO,
// so `GB`, the real code for the United Kingdom, drew nothing. A dashboard
// built on such a column rendered one shaded country and a grey note in the
// corner reading "10 rows not matched to a country".

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalised input → the Natural Earth name that has a shape.
 *
 * Two kinds of entry: everyday shorthand a person would type ("uk", "drc"),
 * and the names `Intl.DisplayNames` returns where Natural Earth spells them
 * differently ("North Macedonia" → "Macedonia"). Every value must be a name
 * the atlas can actually draw — an alias pointing at nothing is worse than no
 * alias, because it looks like coverage and renders blank. A test asserts
 * that for every entry here.
 */
export const COUNTRY_ALIASES: Record<string, string> = {
  // Intl spelling → Natural Earth spelling, with the code each one arrives as.
  "bosnia herzegovina": "bosnia and herz", // BA
  "congo kinshasa": "dem rep congo", // CD
  "central african republic": "central african rep", // CF
  "congo brazzaville": "congo", // CG
  "dominican republic": "dominican rep", // DO
  "western sahara": "w sahara", // EH
  "falkland islands": "falkland is", // FK
  "equatorial guinea": "eq guinea", // GQ
  "myanmar burma": "myanmar", // MM
  "north macedonia": "macedonia", // MK
  "palestinian territories": "palestine", // PS
  "solomon islands": "solomon is", // SB
  "south sudan": "s sudan", // SS
  "french southern territories": "fr s antarctic lands", // TF
  turkiye: "turkey", // TR
  "trinidad tobago": "trinidad and tobago", // TT
  // Shorthand a person types.
  usa: "united states of america",
  us: "united states of america",
  "united states": "united states of america",
  america: "united states of america",
  uk: "united kingdom",
  "great britain": "united kingdom",
  britain: "united kingdom",
  england: "united kingdom",
  uae: "united arab emirates",
  "czech republic": "czechia",
  "ivory coast": "cote divoire",
  "democratic republic of the congo": "dem rep congo",
  drc: "dem rep congo",
  "republic of the congo": "congo",
  korea: "south korea",
  "russian federation": "russia",
  "viet nam": "vietnam",
  holland: "netherlands",
  "bosnia and herzegovina": "bosnia and herz",
  burma: "myanmar",
  swaziland: "eswatini",
  // NOT `macedonia: "north macedonia"` — the atlas shape is named
  // "Macedonia", so that alias sent the plain name to a key with no geometry
  // and the country vanished. The mapping runs the other way, above.
  //
  // No `cape verde` alias either: the 110m atlas carries no Cape Verde shape
  // under either spelling, so an alias would promise coverage that cannot
  // exist. It stays in the unmatched count, which is the truth.
};

/**
 * `Intl.DisplayNames` already knows every assigned region code, so the
 * alternative — a 249-row table in this file — would be a second copy of
 * something the platform ships, kept by hand, and wrong the first time a code
 * is reassigned.
 */
const REGION_NAMES: Intl.DisplayNames | null = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null; // ancient runtime: names still work, codes just do not
  }
})();

/**
 * An ISO 3166-1 ALPHA-2 code as its English country name, or null.
 *
 * Alpha-2 only, and both other forms are deliberate: measured, `of("276")`
 * returns the input unchanged (so numeric goes through the atlas's own ids
 * instead), and `of("DEU")` throws `invalid_argument` (alpha-3 is not a
 * region subtag, and nothing offline maps it to a name).
 */
export function nameForCode(token: string): string | null {
  if (!REGION_NAMES) return null;
  const t = token.toUpperCase();
  if (!/^[A-Z]{2}$/.test(t)) return null;
  try {
    const name = REGION_NAMES.of(t);
    // An unassigned code comes back as the code itself.
    return name && name !== t ? name : null;
  } catch {
    return null;
  }
}

/** The shapes a caller can draw, keyed the two ways a value can arrive. */
export type CountryIndex<T> = {
  /** Normalised country name → shape. */
  byKey: ReadonlyMap<string, T>;
  /** Zero-padded ISO 3166-1 numeric → shape. */
  byNum: ReadonlyMap<string, T>;
};

/**
 * The country a location value refers to, or null if it refers to none.
 *
 * Names are tried first and codes only as a fallback, so a country whose name
 * happens to be two letters cannot be hijacked by the code path. Anything
 * that resolves to no country returns null rather than a guess, because the
 * caller counts those and shows the total — a wrong match would be invisible,
 * an unmatched row is not.
 */
export function resolveCountry<T>(raw: unknown, index: CountryIndex<T>): T | null {
  if (raw === null || raw === undefined) return null;
  const norm = normalizeName(String(raw));
  if (!norm) return null;
  const byName = index.byKey.get(COUNTRY_ALIASES[norm] ?? norm);
  if (byName) return byName;
  // ISO numeric, straight off the atlas's feature ids ("276", and "76" for
  // Brazil's 076 — spreadsheets drop the leading zero).
  if (/^[0-9]{1,3}$/.test(norm)) return index.byNum.get(norm.padStart(3, "0")) ?? null;
  // Then as an alpha-2 code, running the resolved name back through the same
  // alias path (Intl says "Türkiye", Natural Earth says "Turkey").
  const fromCode = nameForCode(norm);
  if (!fromCode) return null;
  const k = normalizeName(fromCode);
  return index.byKey.get(COUNTRY_ALIASES[k] ?? k) ?? null;
}
