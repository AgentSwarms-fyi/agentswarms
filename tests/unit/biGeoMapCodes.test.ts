// A column of ISO country codes drew one country.
//
// Found by putting a filled map and a bubble map on a dashboard over
// `SELECT country, sum(amount) … GROUP BY country`, where `country` holds
// ISO 3166-1 alpha-2 codes — the ordinary way country data is stored. Both
// maps rendered, shaded a single country, and said so in grey 9px text in the
// corner: **"10 rows not matched to a country"**.
//
// The matcher worked on the country NAME, through a hand-kept alias table
// whose only code-shaped entries were "usa"/"us" and "uk". So of the 280
// assigned alpha-2 codes exactly TWO resolved — and `UK` is not one of them in
// ISO: the real code for the United Kingdom is `GB`, which drew nothing.
//
// The fix resolves alpha-2 through `Intl.DisplayNames`, which already knows
// every assigned region, and the numeric form through the atlas's own feature
// ids, which ARE ISO 3166-1 numeric — rather than adding a 249-row table that
// would be wrong the first time a code is reassigned.
//
// This file calls the shipped rule against the shipped atlas index, both
// imported. An earlier draft restated the rule locally and a mutation that
// deleted the numeric path from the component passed it; that is why the rule
// was moved to src/lib/countryMatch.ts, which is importable without a DOM.
import { describe, expect, it } from "vitest";

import { COUNTRY_INDEX } from "@/components/bi/BiGeoMap";
import { COUNTRY_ALIASES, nameForCode, normalizeName, resolveCountry } from "@/lib/countryMatch";

/** What the map would draw for one cell of the location column. */
const drawn = (raw: unknown): string | null => resolveCountry(raw, COUNTRY_INDEX)?.name ?? null;

const REGION = new Intl.DisplayNames(["en"], { type: "region" });

describe("the country a map value resolves to", () => {
  it("takes ISO alpha-2 codes — including GB, which never worked", () => {
    // GB is the point: "UK" was aliased, the actual ISO code was not.
    expect(drawn("GB")).toBe("United Kingdom");
    expect(drawn("DE")).toBe("Germany");
    expect(drawn("BR")).toBe("Brazil");
    expect(drawn("JP")).toBe("Japan");
    expect(drawn("US")).toBe("United States of America");
    expect(drawn("ZA")).toBe("South Africa");
    expect(drawn("CD")).toBe("Dem. Rep. Congo"); // via an Intl→NaturalEarth alias
    expect(drawn("TR")).toBe("Turkey"); // Intl says "Türkiye"
    expect(drawn("gb")).toBe("United Kingdom"); // case is not the user's problem
  });

  it("takes the three-digit numeric form, off the atlas's own ids", () => {
    expect(drawn("276")).toBe("Germany");
    expect(drawn("392")).toBe("Japan");
    expect(drawn("076")).toBe("Brazil");
    // A spreadsheet drops the leading zero; the value still means Brazil.
    expect(drawn("76")).toBe("Brazil");
    // Intl is NOT the source for numeric, and this is exactly why:
    expect(REGION.of("276")).toBe("276");
    expect(nameForCode("276")).toBeNull();
  });

  it("still takes plain names and the informal aliases", () => {
    expect(drawn("Germany")).toBe("Germany");
    expect(drawn("USA")).toBe("United States of America");
    expect(drawn("UK")).toBe("United Kingdom");
    expect(drawn("England")).toBe("United Kingdom");
    expect(drawn("Czech Republic")).toBe("Czechia");
    expect(drawn("côte d'Ivoire")).toBe("Côte d'Ivoire"); // diacritics, apostrophe
    expect(drawn("  Brazil  ")).toBe("Brazil");
  });

  it("covers 171 of the atlas's 177 countries from a code, not 2", () => {
    // The number is the finding. Before: two codes resolved, and one of them
    // was not ISO. A regression that quietly dropped the code path would sail
    // past a spot-check of half a dozen countries but not past this.
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const hit = new Set<string>();
    for (const a of letters) {
      for (const b of letters) {
        const name = drawn(a + b);
        if (name) hit.add(name);
      }
    }
    expect(COUNTRY_INDEX.byKey.size).toBe(177);
    expect(hit.size).toBeGreaterThanOrEqual(171);
  });

  it("reaches most of the atlas from the numeric form too", () => {
    const hit = new Set<string>();
    for (let n = 1; n <= 999; n++) {
      const name = drawn(String(n).padStart(3, "0"));
      if (name) hit.add(name);
    }
    // Every shape carrying an id is reachable; a handful of NE shapes have none.
    expect(hit.size).toBeGreaterThanOrEqual(170);
  });

  it("indexes every atlas id in the zero-padded form, already padded upstream", () => {
    // Measured against world-atlas 2.0.2: all 177 feature ids are 3-character
    // STRINGS ("076"), so the padStart in BiGeoMap is belt-and-braces and no
    // mutation of it is observable. If an atlas upgrade ever ships numeric or
    // unpadded ids, this is the test that says so.
    for (const key of COUNTRY_INDEX.byNum.keys()) {
      expect(key, `${key} is not a 3-digit id`).toMatch(/^[0-9]{3}$/);
    }
    // 3 of the 177 shapes carry no id at all (disputed territories).
    expect(COUNTRY_INDEX.byNum.size).toBe(174);
  });

  it("refuses what is not a country rather than guessing", () => {
    // Region-shaped strings that are NOT countries must stay unmatched, so the
    // "N rows not matched" notice keeps meaning something.
    for (const junk of ["AMER", "EMEA", "APAC", "ZZ", "999", "", "   ", "Atlantis", "-1"]) {
      expect(drawn(junk), `${junk} must not resolve`).toBeNull();
    }
    expect(drawn(null)).toBeNull();
    expect(drawn(undefined)).toBeNull();
    // Alpha-3 is not a region subtag; Intl throws on it. Unmatched, not crashed.
    expect(drawn("DEU")).toBeNull();
    expect(nameForCode("DEU")).toBeNull();
    // 396 well-formed alpha-2 strings are unassigned, and Intl answers those
    // with the code itself. Handing that back as a country NAME would be a
    // lie the map could not act on, so it is rejected.
    expect(REGION.of("AA")).toBe("AA");
    expect(nameForCode("AA")).toBeNull();
    expect(drawn("AA")).toBeNull();
  });

  it("tries names before codes, so a name cannot be hijacked by a code", () => {
    // If codes were tried first, a country whose name normalises to two
    // letters would resolve to whatever region shares those letters. Both
    // candidates have to be present for the order to be observable — with
    // only one of them in the index either order returns the same shape,
    // which is how an earlier version of this test passed against a mutant
    // that put codes first.
    const index = {
      byKey: new Map([
        ["in", { name: "Land called In" }],
        ["india", { name: "India" }],
      ]),
      byNum: new Map<string, { name: string }>(),
    };
    expect(nameForCode("IN")).toBe("India"); // the code path does know it
    expect(resolveCountry("In", index)?.name).toBe("Land called In");
    // And the code still wins when the name matches nothing.
    expect(
      resolveCountry("IN", { ...index, byKey: new Map([["india", { name: "India" }]]) })?.name,
    ).toBe("India");
  });
});

describe("the alias table", () => {
  it("has no alias pointing at a shape the atlas cannot draw", () => {
    // An alias to a name with no geometry is worse than no alias: it looks
    // like coverage and renders nothing. This caught two that had always been
    // broken — `macedonia -> north macedonia` and `cape verde -> cabo verde`.
    for (const [from, to] of Object.entries(COUNTRY_ALIASES)) {
      expect(COUNTRY_INDEX.byKey.has(to), `alias ${from} -> ${to} has no shape`).toBe(true);
    }
  });

  it("has no alias that maps a name to itself", () => {
    // An identity entry does nothing but suggest it does.
    for (const [from, to] of Object.entries(COUNTRY_ALIASES)) {
      expect(from, `alias ${from} is a no-op`).not.toBe(to);
    }
  });

  it("is keyed in the normalised form the lookup uses", () => {
    // A key with a capital or an accent can never be hit.
    for (const from of Object.keys(COUNTRY_ALIASES)) {
      expect(normalizeName(from), `alias key ${from} is not normalised`).toBe(from);
    }
  });
});
