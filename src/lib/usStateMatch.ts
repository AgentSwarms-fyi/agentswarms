// Matching a column of location values to US states on a map (R506).
//
// The whole rule — names, postal codes, FIPS codes and ISO 3166-2 — with no
// atlas in it, for the same reason countryMatch.ts has none: a test can run
// the shipped rule instead of restating it. The map draws the 50 states and
// the District of Columbia, so those are the only places listed; a value for
// Puerto Rico or Guam has no shape and is counted as unmatched, not guessed.
//
// Choosing between a world map and a US map is the subtle part. Postal codes
// and country codes share an alphabet: AZ is Azerbaijan, CO Colombia, CA
// Canada, GA Gabon. A column of state codes drawn on the world map shades a
// dozen countries and reads as a real chart, so `chooseMapRegion` decides
// from all of the values, never from one.
import { normalizeName, resolveCountry, type CountryIndex } from "@/lib/countryMatch";

export type UsState = {
  /** Two-digit FIPS code, the atlas's feature id ("06"). */
  fips: string;
  /** USPS postal code ("CA"). */
  usps: string;
  name: string;
};

/** The 50 states and DC: every place the US map has a shape for. */
export const US_STATES: readonly UsState[] = [
  ["01", "AL", "Alabama"],
  ["02", "AK", "Alaska"],
  ["04", "AZ", "Arizona"],
  ["05", "AR", "Arkansas"],
  ["06", "CA", "California"],
  ["08", "CO", "Colorado"],
  ["09", "CT", "Connecticut"],
  ["10", "DE", "Delaware"],
  ["11", "DC", "District of Columbia"],
  ["12", "FL", "Florida"],
  ["13", "GA", "Georgia"],
  ["15", "HI", "Hawaii"],
  ["16", "ID", "Idaho"],
  ["17", "IL", "Illinois"],
  ["18", "IN", "Indiana"],
  ["19", "IA", "Iowa"],
  ["20", "KS", "Kansas"],
  ["21", "KY", "Kentucky"],
  ["22", "LA", "Louisiana"],
  ["23", "ME", "Maine"],
  ["24", "MD", "Maryland"],
  ["25", "MA", "Massachusetts"],
  ["26", "MI", "Michigan"],
  ["27", "MN", "Minnesota"],
  ["28", "MS", "Mississippi"],
  ["29", "MO", "Missouri"],
  ["30", "MT", "Montana"],
  ["31", "NE", "Nebraska"],
  ["32", "NV", "Nevada"],
  ["33", "NH", "New Hampshire"],
  ["34", "NJ", "New Jersey"],
  ["35", "NM", "New Mexico"],
  ["36", "NY", "New York"],
  ["37", "NC", "North Carolina"],
  ["38", "ND", "North Dakota"],
  ["39", "OH", "Ohio"],
  ["40", "OK", "Oklahoma"],
  ["41", "OR", "Oregon"],
  ["42", "PA", "Pennsylvania"],
  ["44", "RI", "Rhode Island"],
  ["45", "SC", "South Carolina"],
  ["46", "SD", "South Dakota"],
  ["47", "TN", "Tennessee"],
  ["48", "TX", "Texas"],
  ["49", "UT", "Utah"],
  ["50", "VT", "Vermont"],
  ["51", "VA", "Virginia"],
  ["53", "WA", "Washington"],
  ["54", "WV", "West Virginia"],
  ["55", "WI", "Wisconsin"],
  ["56", "WY", "Wyoming"],
].map(([fips, usps, name]) => ({ fips, usps, name }));

const BY_NAME = new Map(US_STATES.map((s) => [normalizeName(s.name), s]));
const BY_USPS = new Map(US_STATES.map((s) => [s.usps.toLowerCase(), s]));
const BY_FIPS = new Map(US_STATES.map((s) => [s.fips, s]));

/** Other ways a state's name is written. Every value is a listed name. */
export const US_STATE_ALIASES: Record<string, string> = {
  "washington dc": "district of columbia",
  "washington d c": "district of columbia",
  "dist of columbia": "district of columbia",
  "washington state": "washington",
  "new york state": "new york",
};

/**
 * The state a location value refers to, or null. Names first, then the
 * postal code ("NY", "ny"), the ISO 3166-2 code ("US-NY"), and the FIPS code
 * ("36", or "6" for California once a spreadsheet drops the leading zero).
 */
export function resolveUsState(raw: unknown): UsState | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  const iso = /^US-([A-Za-z]{2})$/i.exec(text);
  if (iso) return BY_USPS.get(iso[1].toLowerCase()) ?? null;
  const norm = normalizeName(text);
  if (!norm) return null;
  const byName = BY_NAME.get(US_STATE_ALIASES[norm] ?? norm);
  if (byName) return byName;
  if (/^[a-z]{2}$/.test(norm)) return BY_USPS.get(norm) ?? null;
  if (/^[0-9]{1,2}$/.test(norm)) return BY_FIPS.get(norm.padStart(2, "0")) ?? null;
  return null;
}

/** Which map a location column is drawn on. */
export type MapRegion = "world" | "us";

/**
 * Pick the map for a column whose owner left it on "automatic".
 *
 * US states only when at least 80% of the distinct values are states AND
 * either more of them are states than countries, or the column's name says
 * "state". A tie stays on the world map — that is how maps were drawn before
 * there was a choice, so no saved dashboard changes under its owner. Codes
 * are what make the tie common: {CA, CO, GA} are three states and three
 * countries, and only the column's name can say which were meant.
 */
export function chooseMapRegion<T>(
  values: unknown[],
  countries: CountryIndex<T>,
  field = "",
): MapRegion {
  const distinct = [
    ...new Set(values.filter((v) => v !== null && v !== undefined).map((v) => String(v).trim())),
  ].filter(Boolean);
  if (distinct.length === 0) return "world";
  let states = 0;
  let nations = 0;
  for (const v of distinct) {
    if (resolveUsState(v)) states++;
    if (resolveCountry(v, countries)) nations++;
  }
  if (states < 0.8 * distinct.length) return "world";
  const named = /state/i.test(field) && !/country|nation/i.test(field);
  return states > nations || named ? "us" : "world";
}
