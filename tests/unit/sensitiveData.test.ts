// Personal data found from values as well as names (R521).
import { describe, expect, it } from "vitest";

import { isPiiColumnName, piiNameKind } from "@/lib/piiHeuristic";
import {
  classifyColumn,
  describeColumns,
  findSensitiveColumns,
  hiddenBy,
  ibanValid,
  maskWith,
  mentionedKinds,
  readersOf,
  suggestedColumns,
  suggestedDatasetId,
  suggestionFor,
  valueKind,
  type SensitiveFinding,
} from "@/lib/sensitiveData";

const emails = (n: number) => Array.from({ length: n }, (_, i) => `person${i}@example.com`);
/** Numbers that are not card numbers: each fails the Luhn check. */
const notCards = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const base = String(4000000000000000 + i * 7919);
    // Flip the last digit until the checksum fails.
    for (let d = 0; d < 10; d++) {
      const s = base.slice(0, -1) + d;
      if (valueKind(s) !== "card") return s;
    }
    return base;
  });

describe("what a whole value is", () => {
  it.each([
    ["alice@example.com", "email"],
    ["  alice@example.com  ", "email"],
    ["+1 415 555 0123", "phone"],
    ["(415) 555-0123", "phone"],
    ["4111 1111 1111 1111", "card"],
    ["4111111111111111", "card"],
    ["123-45-6789", "national_id"],
    ["GB82WEST12345698765432", "bank_account"],
    ["192.168.10.4", "ip"],
    ["sk-abcdefghijklmnopqrstuvwx", "secret"],
  ])("%s is %s", (v, kind) => expect(valueKind(v)).toBe(kind));

  it.each([
    ["2024-01-15", "a date, not a phone number"],
    ["4111111111111112", "a number that fails the card checksum"],
    ["GB00WEST12345698765432", "an IBAN-shaped code that fails its checksum"],
    ["write to alice@example.com", "text that only mentions one"],
    ["alice@example.com, bob@example.com", "two of them"],
    ["Order 12345", "an order number"],
    ["", "empty"],
    ["x".repeat(200) + "@example.com", "longer than any identifier"],
  ])("%s is nothing (%s)", (v) => expect(valueKind(v)).toBeNull());

  it("checks an IBAN's own checksum", () => {
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(ibanValid("DE89370400440532013001")).toBe(false);
    expect(ibanValid("not an iban")).toBe(false);
  });
});

describe("what text mentions", () => {
  it("finds an email address, a card number, an ID or a key inside text", () => {
    expect(mentionedKinds("reach me at alice@example.com please")).toEqual(["email"]);
    expect(mentionedKinds("paid with 4111 1111 1111 1111 today")).toEqual(["card"]);
    expect(mentionedKinds("ssn 123-45-6789 on file")).toEqual(["national_id"]);
  });

  it("does not take a phone number or an IP address in text for personal data", () => {
    // Too often an order number or a version inside a sentence.
    expect(mentionedKinds("call 415 555 0123 about build 10.0.0.1")).toEqual([]);
  });
});

describe("a column, from its values and its name", () => {
  it("values decide: a column named contact full of email addresses", () => {
    const f = classifyColumn("contact", emails(50));
    expect(f).toMatchObject({ kind: "email", basis: "values", matched: 50, sampled: 50 });
    expect(f?.evidence).toBe("50 of 50 values are email addresses.");
  });

  it("says when the name agrees", () => {
    expect(classifyColumn("email", emails(5))?.basis).toBe("name and values");
  });

  it("needs most values to agree before naming the column for them", () => {
    const mixed = [...emails(5), ...Array.from({ length: 5 }, (_, i) => `n/a ${i}`)];
    // 5 of 10 is below the share; the addresses are still reported, as mentions.
    const f = classifyColumn("contact", mixed);
    expect(f).toMatchObject({ kind: "email", basis: "mentions", matched: 5 });
    expect(f?.evidence).toBe("5 of 10 values mention an email address.");
  });

  it("a name the values contradict is dropped when the kind always shows", () => {
    const ids = Array.from({ length: 20 }, (_, i) => 1000 + i);
    expect(classifyColumn("email_campaign_id", ids)).toBeNull();
  });

  it("but not on too few values to tell", () => {
    expect(classifyColumn("email_campaign_id", [1, 2, 3])?.basis).toBe("name");
  });

  it("keeps a phone column's name when its numbers are bare digits", () => {
    const digits = Array.from({ length: 20 }, (_, i) => String(4155550100 + i));
    const f = classifyColumn("phone", digits);
    expect(f).toMatchObject({ kind: "phone", basis: "name" });
    expect(f?.evidence).toBe("Its name suggests phone numbers.");
  });

  it("names what values cannot show: people's names, addresses, pay", () => {
    expect(classifyColumn("first_name", ["Ada", "Grace"])?.kind).toBe("person_name");
    expect(classifyColumn("home_address", ["1 Main St"])?.kind).toBe("address");
    expect(classifyColumn("salary", [52000])?.kind).toBe("pay");
  });

  it("finds addresses written inside free text", () => {
    const notes = [
      "Called back, all fine",
      "Prefers email: carol@example.com",
      ...Array.from({ length: 18 }, (_, i) => `note ${i}`),
    ];
    const f = classifyColumn("notes", notes);
    expect(f).toMatchObject({ kind: "email", basis: "mentions", matched: 1, sampled: 20 });
    expect(f?.evidence).toBe("1 of 20 values mentions an email address.");
  });

  it("does not take numeric ids for card numbers", () => {
    // A few ids pass the card checksum by chance; that is not a card column.
    const ids = [...notCards(18), "4111111111111111", "5500000000000004"];
    expect(classifyColumn("account_ref", ids)).toBeNull();
  });

  it("ignores empty values and things that are not plain values", () => {
    const f = classifyColumn("contact", [null, "", "  ", { a: 1 }, ...emails(3)]);
    expect(f).toMatchObject({ kind: "email", matched: 3, sampled: 3 });
  });

  // Found on a real synced contacts table on 8080 (R521).
  it("counts true and false as values: a flag named for email is not an address", () => {
    expect(classifyColumn("IsEmailBounced", Array(18).fill(false))).toBeNull();
  });

  it("says when the rows read have nothing in a column it flags by name", () => {
    expect(classifyColumn("BackupEmail", Array(20).fill(null))?.evidence).toBe(
      "Its name suggests email addresses; none of the 20 rows read has a value in it.",
    );
    // Until R558 this column was the example; it holds the date an email
    // bounced, and its name now says so.
    expect(classifyColumn("EmailBouncedDate", Array(20).fill(null))).toBeNull();
  });

  it("says when a few values do not bear a name out", () => {
    expect(classifyColumn("email_campaign_id", [1, 2, 3])?.evidence).toBe(
      "Its name suggests email addresses, though none of its 3 values is one.",
    );
  });

  it("speaks of one value in the singular", () => {
    expect(classifyColumn("OtherPhone", [null, "(415) 555-0199", null])?.evidence).toBe(
      "1 of 1 value is a phone number.",
    );
  });

  it("returns nothing for an ordinary column", () => {
    expect(classifyColumn("region", ["EU", "US", "APAC"])).toBeNull();
    expect(classifyColumn("order_id", [1, 2, 3])).toBeNull();
  });

  it("goes through every column in order", () => {
    const rows = [
      { id: 1, contact: "a@example.com", city: "Lyon", surname: "Curie" },
      { id: 2, contact: "b@example.com", city: "Oslo", surname: "Bohr" },
    ];
    expect(
      findSensitiveColumns(rows, ["id", "contact", "city", "surname"]).map((f) => f.column),
    ).toEqual(["contact", "surname"]);
  });
});

describe("the name check knows what a name suggests", () => {
  it.each([
    ["email_address", "email"],
    ["emailAddress", "email"],
    ["ip_address", "ip"],
    ["home_address", "address"],
    ["dob", "birth_date"],
    ["card_number", "card"],
    ["passport_no", "national_id"],
    ["mobile", "phone"],
    ["last_name", "person_name"],
    ["gender", "gender"],
    ["iban", "bank_account"],
  ])("%s suggests %s", (name, kind) => expect(piiNameKind(name)).toBe(kind));

  it("flags exactly the names it flagged before", () => {
    for (const n of ["order_id", "created_at", "region", "address_count"])
      expect(isPiiColumnName(n)).toBe(piiNameKind(n) !== null);
    expect(piiNameKind("order_id")).toBeNull();
  });
});

const f = (column: string, kind: SensitiveFinding["kind"] = "email"): SensitiveFinding => ({
  column,
  kind,
  basis: "values",
  matched: 1,
  sampled: 1,
  evidence: "1 of 1 value is email addresses.",
});

describe("who can read them", () => {
  it("compares a mask as the database does: trimmed, any case", () => {
    expect(hiddenBy([" Email "], "email")).toBe(true);
    expect(hiddenBy(["phone"], "email")).toBe(false);
    expect(hiddenBy(null, "email")).toBe(false);
  });

  it("counts the grants that can still read each column", () => {
    const r = readersOf([f("email"), f("phone", "phone")], [["EMAIL"], [], ["phone"]]);
    expect(r.map((x) => [x.finding.column, x.readers])).toEqual([
      ["email", 2],
      ["phone", 2],
    ]);
  });

  it("adds to a mask without changing what it already hid", () => {
    expect(maskWith(["Email"], ["email", "phone", " phone ", ""])).toEqual(["Email", "phone"]);
    expect(maskWith(null, ["dob"])).toEqual(["dob"]);
  });
});

describe("what to suggest", () => {
  const found = [f("email"), f("phone", "phone"), f("dob", "birth_date")];

  it("nothing when nobody else can read it", () => {
    expect(suggestionFor(found, [], [])).toBeNull();
  });

  it("only the columns some grant can read", () => {
    expect(suggestionFor(found, [["email"], ["email"]], [])).toEqual(["phone", "dob"]);
  });

  it("nothing while a suggestion is waiting for an answer", () => {
    expect(suggestionFor(found, [[]], [{ status: "pending", columns: ["email"] }])).toBeNull();
  });

  it("never asks twice about a column, whatever the answer was", () => {
    expect(
      suggestionFor(found, [[]], [{ status: "rejected", columns: ["EMAIL", "phone"] }]),
    ).toEqual(["dob"]);
    expect(
      suggestionFor(found, [[]], [{ status: "rejected", columns: ["email", "phone", "dob"] }]),
    ).toBeNull();
  });
});

describe("what the inbox reads from a suggestion", () => {
  it("lists columns, in words", () => {
    expect(describeColumns([f("email")])).toBe("email (email addresses)");
    expect(describeColumns([f("email"), f("phone", "phone"), f("dob", "birth_date")])).toBe(
      "email (email addresses), phone (phone numbers) and dob (dates of birth)",
    );
  });

  it("reads a payload defensively: its owner can write it", () => {
    expect(
      suggestedColumns({
        findings: [
          { column: "email", kind: "email", evidence: "x" },
          { column: "bad", kind: "constructor", evidence: "x" },
          { column: 3, kind: "email", evidence: "x" },
          null,
        ],
      }),
    ).toEqual([{ column: "email", kind: "email", evidence: "x" }]);
    expect(suggestedColumns(null)).toEqual([]);
    expect(suggestedDatasetId({ dataset_id: "11111111-1111-1111-1111-111111111111" })).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(suggestedDatasetId({ dataset_id: "../../admin" })).toBeNull();
  });
});
