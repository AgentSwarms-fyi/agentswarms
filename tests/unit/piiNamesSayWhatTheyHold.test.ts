// What a column's name can say about the personal data in it (R558).
//
// Checked against public sample schemas in `piiNameCorpus.test.ts`; this file
// holds each rule on its own, and what it changes downstream:
// - passwords and keys are found by name (their values have no shape), so the
//   catalog keeps no hash as a sample and quality findings quote none;
// - a name that only points at, times or describes something personal
//   (`address_id`, `email_confirmed_at`, `phone_type`) is not taken for it, so
//   an accepted-values check on `phone_type` shows its examples again;
// - a place of birth is not a date of birth;
// - a column of nothing but true and false holds none of these, gender aside.
import { describe, expect, it, vi } from "vitest";

const hashes = vi.hoisted(() =>
  Array.from({ length: 20 }, (_, i) => ({
    password_hash: `5f4dcc3b5aa765d61d8327deb882cf9${i % 10}`,
    phone_type: ["home", "work", "mobile"][i % 3],
    region: "EU",
  })),
);

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/warehouse/drivers.server", () => ({
  listWarehouseTables: async () => [
    {
      schema: "app",
      name: "users",
      columns: ["password_hash", "phone_type", "region"].map((name) => ({ name, type: "text" })),
    },
  ],
  executeWarehouseQuery: async (_c: unknown, sql: string) => ({
    rows: /limit/i.test(sql) ? hashes : [],
  }),
}));

const { piiNameKind } = await import("@/lib/piiHeuristic");
const { classifyColumn, SENSITIVE_LABEL } = await import("@/lib/sensitiveData");
const { keepableColumn } = await import("@/lib/catalogColumnValues");
const { evaluateQualityTest } = await import("@/lib/dataQualityCore");
const { crawlWarehouse } = await import("@/utils/catalog/crawler.server");

describe("passwords and keys, by name", () => {
  it.each([
    ["password", "password"],
    ["PasswordHash", "password"],
    ["encrypted_password", "password"],
    ["user_pwd", "password"],
    ["passwd", "password"],
    ["api_key", "secret"],
    ["apiKey", "secret"],
    ["client_secret", "secret"],
    ["private_key", "secret"],
    ["refresh_token", "secret"],
    ["webhook_secret", "secret"],
  ])("%s holds %s", (name, kind) => expect(piiNameKind(name)).toBe(kind));

  it("a token about an email or a phone is a key, not an address", () => {
    expect(piiNameKind("email_change_token_new")).toBe("secret");
    expect(piiNameKind("phone_change_token")).toBe("secret");
    expect(piiNameKind("password_reset_token")).toBe("password");
  });

  it("says what they are", () => {
    expect(SENSITIVE_LABEL.password).toBe("passwords or password hashes");
    expect(classifyColumn("PasswordHash", ["x"])?.evidence).toBe(
      "Its name suggests passwords or password hashes.",
    );
  });

  it("counting tokens is not holding one", () => {
    expect(piiNameKind("token_count")).toBeNull();
    expect(piiNameKind("prompt_tokens")).toBeNull();
    expect(piiNameKind("access_token_expires_at")).toBeNull();
  });
});

describe("a name about something personal does not hold it", () => {
  it.each([
    "address_id",
    "ca_address_sk",
    "CreditCardID",
    "PhoneNumberTypeID",
    "phone_type",
    "address_status",
    "email_confirmed_at",
    "phone_verified",
    "email_count",
    "street_type",
    "is_email_verified",
    "has_phone",
    "first_name_length",
  ])("%s", (name) => expect(piiNameKind(name)).toBeNull());

  it("but the last word decides, wherever the term is", () => {
    expect(piiNameKind("address_line1")).toBe("address");
    expect(piiNameKind("phone_number")).toBe("phone");
    expect(piiNameKind("email_change")).toBe("email");
  });

  it("keeps the keys that are the data", () => {
    // In common usage an email id is the address; values overrule it when not.
    expect(piiNameKind("email_id")).toBe("email");
    // A date-dimension key is the date; a key to a gender or country lookup is them.
    expect(piiNameKind("birth_date_sk")).toBe("birth_date");
    expect(piiNameKind("gender_id")).toBe("gender");
    expect(piiNameKind("birth_country_id")).toBe("birth_place");
    expect(piiNameKind("passport_id")).toBe("national_id");
    expect(piiNameKind("secret_id")).toBe("secret");
  });

  it("a birth date's own column is a date", () => {
    expect(piiNameKind("birth_date")).toBe("birth_date");
    expect(piiNameKind("date_of_birth")).toBe("birth_date");
    expect(piiNameKind("dob_date")).toBe("birth_date");
    expect(piiNameKind("birth_date_verified")).toBeNull();
  });
});

describe("a place of birth is not a date of birth", () => {
  it.each(["c_birth_country", "birth_place", "birthplace", "place_of_birth", "country_of_birth"])(
    "%s",
    (name) => expect(piiNameKind(name)).toBe("birth_place"),
  );

  it("the birth date's parts stay dates", () => {
    for (const n of ["c_birth_day", "c_birth_month", "c_birth_year", "birthday", "dob"])
      expect(piiNameKind(n)).toBe("birth_date");
  });

  it("is labelled as a place", () => {
    expect(classifyColumn("C_BIRTH_COUNTRY", ["CHILE", "TOGO"])?.evidence).toBe(
      "Its name suggests places of birth.",
    );
  });
});

describe("names missed before", () => {
  it.each([
    ["Fax", "phone"],
    ["MiddleName", "person_name"],
    ["ContactName", "person_name"],
    ["ca_zip", "address"],
    ["address2", "address"],
    ["phone_2", "phone"],
    ["postcode", "address"],
    ["pincode", "address"],
    ["aadhaar_number", "national_id"],
    ["pan_no", "national_id"],
    ["national_insurance_number", "national_id"],
    ["ipv4_address", "ip"],
  ])("%s holds %s", (name, kind) => expect(piiNameKind(name)).toBe(kind));

  it("and ordinary names stay ordinary", () => {
    for (const n of ["pan", "pin", "zipper", "tokenizer", "passage", "tokens_used"])
      expect([n, piiNameKind(n)]).toEqual([n, null]);
  });
});

describe("a column of true and false", () => {
  const flags = Array.from({ length: 12 }, (_, i) => i % 2 === 0);

  it("holds no phone number, whatever its name", () => {
    expect(classifyColumn("phone_opt_in", flags)).toBeNull();
    expect(classifyColumn("PasswordSet", flags.map(String))).toBeNull();
  });

  it("can hold gender", () => {
    expect(classifyColumn("gender", flags)?.kind).toBe("gender");
  });

  it("three are enough, where values that miss a shape need ten", () => {
    // Found in the UI test: a synced users table of 8 rows listed some 40
    // preference flags as personal data, because the rule waited for ten.
    expect(classifyColumn("UserPreferencesShowFaxToExternalUsers", flags.slice(0, 8))).toBeNull();
    expect(classifyColumn("phone_opt_in", flags.slice(0, 3))).toBeNull();
    expect(classifyColumn("phone_opt_in", flags.slice(0, 2))?.kind).toBe("phone");
    // An email name with 8 values that are not addresses still stands: not ten.
    expect(classifyColumn("EmailEncodingKey", Array(8).fill("UTF-8"))?.kind).toBe("email");
  });

  it("one value that is not a flag keeps the name", () => {
    expect(classifyColumn("phone_opt_in", [...flags, "07700 900123"])?.kind).toBe("phone");
  });
});

describe("downstream", () => {
  it("a crawl marks a password column and the catalog keeps none of its hashes", async () => {
    const { assets } = await crawlWarehouse({ provider: "postgres" } as never);
    const users = assets.find((a) => a.name === "users")!;
    const col = (n: string) => users.columns.find((c) => c.name === n)!;
    expect(col("password_hash")).toMatchObject({ pii: true, pii_kind: "password" });
    expect(col("password_hash").sample).toMatch(/^5f4dcc/);
    const kept = keepableColumn(col("password_hash"));
    expect(kept.sample).toBeUndefined();
    // A type column is not personal, and keeps its sample.
    expect(col("phone_type").pii).toBeUndefined();
    expect(keepableColumn(col("phone_type")).sample).toBe("home");
  });

  const ctx = { rows: hashes, totalRows: hashes.length };
  const check = (column_name: string, values: string[]) =>
    evaluateQualityTest(
      {
        id: "t",
        table_id: "d",
        kind: "accepted_values",
        column_name,
        config: { values },
        enabled: true,
        severity: "error",
      },
      ctx,
    );

  it("an accepted-values check on a type column shows its examples again", () => {
    const out = check("phone_type", ["home", "work"]);
    expect(out.status).toBe("fail");
    expect(out.detail).toContain('e.g. "mobile"');
  });

  it("one on a password column quotes no hash", () => {
    const out = check("password_hash", ["x"]);
    expect(out.status).toBe("fail");
    expect(out.detail).not.toMatch(/5f4dcc/);
    expect(out.detail).toContain("the column holds passwords or password hashes");
  });
});
