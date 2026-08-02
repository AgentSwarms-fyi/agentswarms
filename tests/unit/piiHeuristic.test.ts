// The PII column-name heuristic.
//
// It flags catalog columns as "probably personal data" for a human to review.
// Advisory — it masks nothing on its own — so the asymmetry that matters is
// that a false positive costs a glance while a false negative means a column
// of dates of birth is never surfaced at all.
//
// TWO THINGS THIS WAS WRITTEN FOR:
//
// 1. `date_of_birth` was NOT flagged. The term list had `dob`, `birth_date`
//    and `birthday` but not `birth`, so the single most common spelling of one
//    of the most sensitive columns there is went unmarked.
// 2. camelCase was invisible. The terms are anchored on `_`/`-`/space
//    boundaries, and `emailAddress` has none, so any database naming columns
//    that way got no PII detection whatsoever.
//
// And the structural one: this lived in TWO copies — `lib/dataCatalog` and
// `utils/catalog/crawler.server` — because the former imports the browser
// Supabase client, with the second labelled "client-side mirror". They were
// identical, and nothing would have noticed if they were not. That is the same
// arrangement that let the warehouse read-only guard lose its mutation
// denylist while a comment claimed both copies were "in sync in spirit".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isPiiColumnName } from "@/lib/piiHeuristic";

describe("flags personal data columns", () => {
  const PII = [
    "email",
    "customer_email",
    "email_address",
    "phone",
    "phone_number",
    "mobile",
    "home_address",
    "street",
    "zip_code",
    "postal_code",
    "ssn",
    "social_security_number",
    "passport",
    "national_id",
    "tax_id",
    "driver_license",
    "iban",
    "swift",
    "credit_card",
    "card_number",
    "cvv",
    "salary",
    "income",
    "first_name",
    "last_name",
    "full_name",
    "surname",
    "gender",
    "ip_address",
  ];
  for (const name of PII) {
    it(`flags ${name}`, () => expect(isPiiColumnName(name)).toBe(true));
  }
});

describe("date of birth, in the spellings people actually use", () => {
  // `date_of_birth` was missed entirely before this.
  for (const name of ["dob", "date_of_birth", "birth_date", "birthdate", "birthday", "birth"]) {
    it(`flags ${name}`, () => expect(isPiiColumnName(name)).toBe(true));
  }
});

describe("camelCase and PascalCase are seen", () => {
  // A whole-name term matched by accident before (firstName -> "firstname"),
  // but a compound did not: emailAddress had no word boundary before Address.
  for (const name of [
    "emailAddress",
    "EmailAddress",
    "firstName",
    "lastName",
    "phoneNumber",
    "dateOfBirth",
    "ipAddress",
    "creditCard",
    "nationalID",
  ]) {
    it(`flags ${name}`, () => expect(isPiiColumnName(name)).toBe(true));
  }
});

describe("does not flag ordinary columns", () => {
  for (const name of [
    "order_id",
    "product_name",
    "company_name",
    "region",
    "created_at",
    "status",
    "quantity",
    "total_amount",
    "sku",
    "currency",
  ]) {
    it(`ignores ${name}`, () => expect(isPiiColumnName(name)).toBe(false));
  }

  it("handles empty and junk input without throwing", () => {
    for (const v of ["", "   ", "_", "-"]) expect(isPiiColumnName(v)).toBe(false);
    expect(isPiiColumnName(undefined as unknown as string)).toBe(false);
  });
});

describe("over-inclusive on purpose", () => {
  it("flags email_campaign_id even though it is not personal data", () => {
    // Documented rather than fixed. Narrowing the match to exclude this would
    // risk excluding a real one, and the flag only asks a human to look.
    expect(isPiiColumnName("email_campaign_id")).toBe(true);
  });
});

describe("there is only one copy of the heuristic", () => {
  // The bug class this file exists to prevent. Both consumers must import the
  // shared module rather than re-declare the pattern.
  const consumers = [
    "src/lib/dataCatalog.ts",
    "src/utils/catalog/crawler.server.ts",
    "src/components/catalog/CatalogView.tsx",
  ];

  for (const f of consumers) {
    it(`${f} does not carry its own copy`, () => {
      const src = readFileSync(f, "utf8");
      expect(src, "a second PII pattern is declared here").not.toMatch(/social\[-_\]\?security/);
    });
  }

  it("the shared module is the only place the pattern is written", () => {
    const shared = readFileSync("src/lib/piiHeuristic.ts", "utf8");
    expect(shared).toMatch(/social\[-_\]\?security/);
  });
});
