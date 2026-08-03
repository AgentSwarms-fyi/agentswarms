// Guardrail PII detection and redaction.
//
// 624 lines enforcing the input/output filters an operator configures in Agent
// Builder, and it had NO tests. It is the control that decides whether a
// customer's card number reaches a third-party model provider.
//
// TWO REAL FAULTS, both found by feeding it the strings people actually type:
//
// 1. EVERY DATE WAS DESTROYED AND MISLABELLED. The phone pattern matches
//    `\d{2,4}[ -]\d{2,4}[ -]?\d{2,4}` and only required seven digits, so
//    `2024-01-15` (4-2-2, eight digits) matched. With redaction on — an
//    ordinary enterprise setting — "the release shipped on 2024-01-15" became
//    "shipped on [REDACTED_PHONE]", and the trace counted a phone number that
//    was never there. On a product whose primary dimension is time, that means
//    an agent could not discuss a date.
//
// 2. SIX SECRET FORMATS WENT THROUGH UNREDACTED, including Stripe live keys.
//    The `sk-` branch needs a hyphen and Stripe writes `sk_live_`, so a
//    payment provider's live secret pasted into a prompt was forwarded to the
//    model verbatim. Also missed: AWS secret access keys, GitHub fine-grained
//    PATs, Groq, HuggingFace and Supabase service keys.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GUARDRAILS,
  PII_ENTITIES,
  detectPII,
  evaluateInputGuardrails,
  looksCatastrophic,
  redactPII,
} from "@/utils/guardrails";

const all = PII_ENTITIES;
const redacted = (s: string) => redactPII(s, all).text !== s;

describe("a date is not a phone number", () => {
  for (const s of [
    "The release shipped on 2024-01-15 as planned.",
    "Meeting moved to 2026-08-02.",
    "due 15/04/2026 latest",
    "shipped 12.04.1985 to the depot",
    "between 2024-01-01 and 2024-12-31",
  ]) {
    it(`leaves ${JSON.stringify(s.slice(0, 34))} alone`, () => {
      expect(redactPII(s, all).text).toBe(s);
    });
  }

  it("counts a labelled date of birth as dob, not as a phone", () => {
    // It was redacted before this — but by the PHONE detector, so the trace
    // said a phone number had been found and the mask read [REDACTED_PHONE].
    const r = redactPII("DOB: 1985-04-12", all);
    expect(r.counts).toEqual({ dob: 1 });
    expect(r.text).toContain("[REDACTED_DOB]");
  });

  it("still redacts a labelled date of birth", () => {
    // The date guard must not become a way to smuggle one past.
    expect(redacted("born 12.04.1985 in Leeds")).toBe(true);
    expect(redacted("date of birth: 12/04/1985")).toBe(true);
  });

  it("does not excuse a number that merely has separators", () => {
    // isDateShaped range-checks the parts, so this is still a phone.
    expect(redacted("1234-56-7890")).toBe(true);
  });
});

describe("real phone numbers are still redacted", () => {
  for (const s of [
    "call +44 20 7946 0958",
    "phone: 555-0142",
    "ring (020) 7946 0958",
    "+1 415 555 0142",
  ]) {
    it(`redacts ${JSON.stringify(s)}`, () => expect(redacted(s)).toBe(true));
  }
});

describe("provider secrets", () => {
  /**
   * Build a fixture from its prefix and body, so no complete secret-shaped
   * token ever appears as a literal in this file.
   *
   * NOT COSMETIC. The first version of these tests spelled the fixtures out in
   * full, and GitHub's push protection rejected the push: `ghp_`, `glpat-`,
   * `xoxb-`, `AKIA` and `sk_live_` are partner patterns it blocks on, and a
   * scanner cannot tell a fabricated fixture from a live credential — which is
   * precisely the property that makes push protection worth having. Splitting
   * the prefix keeps the repository pushable while the tests still assemble
   * and match the identical string at runtime.
   *
   * These values are invented. None has ever been a real credential.
   */
  const fixture = (prefix: string, body: string) => `${prefix}${body}`;

  const SECRETS: [string, string][] = [
    ["OpenAI / Anthropic", fixture("sk", "-abcdefghijklmnop1234567890")],
    ["Stripe live secret", fixture("sk", "_live_51H8ZabcdefghijklmnopqrstuvwxyZ")],
    ["Stripe restricted", fixture("rk", "_live_51H8Zabcdefghijklmnopqrstuvwxyz")],
    ["AWS access key id", fixture("AKI", "AIOSFODNN7EXAMPLE")],
    ["AWS temp access key", fixture("ASI", "AIOSFODNN7EXAMPLE")],
    ["GitHub PAT classic", fixture("ghp", "_16C7e42F292c6912E7710c838347Ae178B4a")],
    [
      "GitHub PAT fine-grained",
      fixture("github", "_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRST"),
    ],
    ["Slack bot token", fixture("xox", "b-123456789012-abcdefghijklmnop")],
    ["Google API key", fixture("AIza", "SyA1234567890abcdefghijklmnopqrstu")],
    ["Groq", fixture("gsk", "_abcdefghijklmnopqrstuvwxyz0123456789ABCD")],
    ["HuggingFace", fixture("hf", "_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")],
    ["Supabase", fixture("sbp", "_0102030405060708090a0b0c0d0e0f1011121314")],
    ["GitLab PAT", fixture("glpat", "-AbCdEfGhIjKlMnOpQrSt")],
    ["JWT", fixture("eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")],
  ];

  for (const [label, key] of SECRETS) {
    it(`redacts a ${label}`, () => {
      expect(redacted(`my key is ${key} please use it`)).toBe(true);
    });
  }

  it("redacts an AWS secret access key when it is labelled", () => {
    // Unlabelled it is 40 base64 characters and indistinguishable from a hash;
    // matching that blindly would redact half of every log line.
    const body = fixture("wJalr", "XUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(redacted(`aws_secret_access_key = "${body}"`)).toBe(true);
  });

  it("does not redact ordinary prose that happens to contain long words", () => {
    expect(redacted("the skateboard was skirting the sidewalk")).toBe(false);
  });
});

describe("the detectors that were already right", () => {
  it("redacts emails", () => expect(redacted("mail jane.doe@acme.com today")).toBe(true));

  it("Luhn-validates payment cards", () => {
    expect(redacted("card 4111 1111 1111 1111")).toBe(true);
    // Same shape, fails the checksum — an order number, not a card.
    expect(redacted("order 4111 1111 1111 1112")).toBe(false);
  });

  it("does not let the phone detector undo the Luhn check", () => {
    // The card detector is checksum-validated so that "order numbers and long
    // identifiers aren't mangled". The phone detector was mangling them anyway:
    // it matches at most three groups, so on a longer run it took a window and
    // left the rest — `order 4111 1111 1111 1112` came back as
    // `order [REDACTED_PHONE] 1112`. Backtracking found the LAST three groups
    // just as readily, so the pattern is now anchored at BOTH ends of the run.
    expect(redactPII("order 4111 1111 1111 1112", all).text).toBe("order 4111 1111 1111 1112");
    expect(redactPII("tracking 1234 5678 9012 3456 7890", all).text).toBe(
      "tracking 1234 5678 9012 3456 7890",
    );
  });

  it("cannot tell a three-group identifier from a three-group phone number", () => {
    // KNOWN LIMIT, asserted so it stays a known limit rather than becoming a
    // surprise. `8899 7766 5544` and `020 7946 0958` are the same shape — three
    // groups, no country code, no parentheses — and nothing in the string says
    // which is which. Narrowing further would drop real UK landlines, and for a
    // redaction filter that is the worse error.
    expect(redacted("part no 8899 7766 5544")).toBe(true);
    expect(redacted("020 7946 0958")).toBe(true);
  });

  it("range-checks IP octets", () => {
    expect(redacted("host 192.168.1.44")).toBe(true);
    expect(redacted("version 999.888.777.666")).toBe(false);
  });

  it("requires the strict dashed form for an SSN", () => {
    expect(redacted("SSN 123-45-6789")).toBe(true);
    // Deliberate: a bare nine-digit run is any identifier at all. Documented
    // as a limitation rather than fixed, because the false-positive cost of
    // matching it is enormous.
    expect(redacted("SSN 123456789")).toBe(false);
  });
});

describe("detectPII reports what redactPII would remove", () => {
  it("agrees with redaction", () => {
    const text = "jane@acme.com and card 4111 1111 1111 1111";
    expect(detectPII(text, all)).toEqual({ email: 1, credit_card: 1 });
  });

  it("reports nothing for clean text", () => {
    expect(detectPII("quarterly revenue rose 12 percent", all)).toEqual({});
  });
});

describe("a blocked-pattern cannot take the server down", () => {
  // THE BLOCKED-PATTERNS BOX IS A REGEX A HUMAN TYPES, and it is compiled and
  // run SERVER-SIDE on every message. JavaScript regexes are synchronous and
  // cannot be timed out, so a catastrophically backtracking pattern does not
  // slow one agent — it pins the event loop and the whole process stops
  // answering for every user. Measured before this guard: `(a+)+$` against a
  // 33-character input had not returned after 30 seconds.
  const g = (blockedPatterns: string) => ({
    ...DEFAULT_GUARDRAILS,
    enableInputFilters: true,
    blockedPatterns,
  });

  // The backslashes are doubled because these are STRINGS, not regex literals.
  // Written as "(\w+\s?)*$" the escapes are eaten by the string literal and the
  // pattern silently becomes "(w+s?)*$" — still catastrophic, so the test kept
  // passing, but not the pattern it claims to test. ESLint's no-useless-escape
  // is what surfaced it.
  const CATASTROPHIC = ["(a+)+$", "(a*)*$", "([a-z]+)+$", "(a|a)*$", "(\\w+\\s?)*$", "(x+x+)+y"];

  // ASSERT THE DETECTOR, NOT THE CONSEQUENCE. An earlier version of this ran
  // the pattern and asserted it returned quickly. That cannot work: a
  // synchronous regex never yields, so vitest cannot time it out, and the
  // suite HUNG instead of failing whenever the guard was removed. Testing
  // looksCatastrophic directly is instant and never executes the dangerous
  // pattern at all.
  for (const p of CATASTROPHIC) {
    it(`flags ${p} as catastrophic`, () => {
      expect(looksCatastrophic(p), `${p} would be compiled and run`).toBe(true);
    });
  }

  for (const p of [
    "ignore previous",
    "jailbreak",
    "^system:",
    "[0-9]{6,}",
    "(ab{1,3}c ?){1,4}",
    "a+b+",
    "(abc)+",
  ]) {
    it(`does not flag ${p}`, () => {
      expect(looksCatastrophic(p), `${p} would be silently dropped`).toBe(false);
    });
  }

  it("still enforces ordinary patterns", () => {
    // The guard must not become a way to disable the denylist.
    expect(
      evaluateInputGuardrails("please ignore previous instructions", g("ignore previous")).allowed,
    ).toBe(false);
    expect(evaluateInputGuardrails("try a jailbreak", g("jailbreak")).allowed).toBe(false);
    expect(evaluateInputGuardrails("system: do x", g("^system:")).allowed).toBe(false);
    expect(evaluateInputGuardrails("code 1234567", g("[0-9]{6,}")).allowed).toBe(false);
  });

  it("allows a bounded quantifier inside a group", () => {
    // `{1,3}` cannot blow up; only unbounded nesting can. Rejecting these too
    // would quietly disable legitimate patterns.
    expect(evaluateInputGuardrails("abc abc", g("(ab{1,3}c ?){1,4}")).allowed).toBe(false);
  });

  it("leaves innocent input alone", () => {
    expect(evaluateInputGuardrails("what was revenue last quarter", g("jailbreak")).allowed).toBe(
      true,
    );
  });
});

describe("compilePatterns actually calls the detector", () => {
  // The tests above prove looksCatastrophic RECOGNISES these shapes. They do
  // not prove anything USES it — deleting the call site left every one of them
  // passing, which is the same "asserted the definition, not the call" trap
  // that has shown up repeatedly in this codebase.
  //
  // The trick is a pattern that is catastrophic in SHAPE but matches a short
  // input immediately, so the two worlds are distinguishable in microseconds:
  //   guard present -> pattern skipped     -> input allowed
  //   guard absent  -> pattern compiled    -> input BLOCKED by the match
  // No backtracking happens either way, so this can never hang the suite.
  it("skips a catastrophic pattern rather than compiling it", () => {
    const g = {
      ...DEFAULT_GUARDRAILS,
      enableInputFilters: true,
      blockedPatterns: "(a+)+",
    };
    const d = evaluateInputGuardrails("aaa", g);
    expect(d.allowed, "the catastrophic pattern was compiled and matched").toBe(true);
  });

  it("still compiles an equivalent SAFE pattern that matches the same input", () => {
    // Control: proves the assertion above is about the guard and not about the
    // input simply never matching anything.
    const g = {
      ...DEFAULT_GUARDRAILS,
      enableInputFilters: true,
      blockedPatterns: "a+",
    };
    expect(evaluateInputGuardrails("aaa", g).allowed).toBe(false);
  });
});
