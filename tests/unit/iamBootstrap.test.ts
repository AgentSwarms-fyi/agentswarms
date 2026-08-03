// Who gets to be the ADMIN_EMAIL bootstrap superadmin.
//
// The grant is permanent — iamRevokeSuperadmin refuses to demote it — and it is
// decided by an email address, which is a claim rather than a credential. On a
// fresh deploy `allow_public_signup` defaults to true
// (20260720000000_iam.sql), and DEPLOYMENT.md tells the operator to register
// ADMIN_EMAIL *after* deploying and enable invite-only *after* that. Until they
// do, the address is unclaimed and whoever registers it first is handed
// permanent superadmin. "admin@<their-domain>" is not a hard guess.
//
// Requiring a confirmed address closes that wherever Supabase actually verifies
// addresses. It does NOT close it under autoconfirm, and the tests say so
// explicitly rather than leaving a reader to assume the check is stronger than
// it is.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bootstrapClaimAllowed } from "@/utils/iam.server";

const CONFIRMED = "2026-01-01T00:00:00Z";
const claim = (over: Partial<Parameters<typeof bootstrapClaimAllowed>[0]> = {}) =>
  bootstrapClaimAllowed({
    email: "admin@example.com",
    bootstrapEmail: "admin@example.com",
    emailConfirmedAt: CONFIRMED,
    ...over,
  });

describe("the operator can still bootstrap", () => {
  it("accepts the configured address once confirmed", () => {
    expect(claim()).toBe(true);
  });

  it("ignores case and surrounding whitespace on both sides", () => {
    // The address arrives from two different places — a JWT and an env var —
    // and neither is normalised at the source.
    expect(claim({ email: "  ADMIN@Example.com " })).toBe(true);
    expect(claim({ bootstrapEmail: " Admin@EXAMPLE.com" })).toBe(true);
  });
});

describe("an address alone is not enough", () => {
  it("refuses an unconfirmed account holding the bootstrap address", () => {
    // THE LAND GRAB. Someone registers ADMIN_EMAIL in the window between
    // deployment and the operator's own signup.
    expect(claim({ emailConfirmedAt: null })).toBe(false);
    expect(claim({ emailConfirmedAt: undefined })).toBe(false);
    expect(claim({ emailConfirmedAt: "" })).toBe(false);
  });

  it("refuses any other address, confirmed or not", () => {
    expect(claim({ email: "attacker@example.com" })).toBe(false);
    expect(claim({ email: "attacker@example.com", emailConfirmedAt: null })).toBe(false);
  });

  it("refuses a lookalike rather than matching loosely", () => {
    for (const email of [
      "admin@example.com.evil.test",
      "xadmin@example.com",
      "admin@example.co",
      "admin+x@example.com",
    ]) {
      expect(claim({ email }), email).toBe(false);
    }
  });
});

describe("no ADMIN_EMAIL configured means nobody is the bootstrap admin", () => {
  it("does not treat an empty setting as a wildcard", () => {
    // The failure mode to avoid: an unset env var reading as "" and an account
    // with no email also reading as "", so they match and everyone is admin.
    expect(claim({ bootstrapEmail: "" })).toBe(false);
    expect(claim({ bootstrapEmail: "", email: "" })).toBe(false);
    expect(claim({ bootstrapEmail: "   ", email: "   " })).toBe(false);
  });

  it("does not grant to an account with no email at all", () => {
    expect(claim({ email: "" })).toBe(false);
  });
});

describe("both decision points use the same rule", () => {
  // ADDED BECAUSE A MUTATION SURVIVED. Reverting isBootstrapAdmin to a bare
  // address comparison broke nothing above, because everything above tests the
  // pure function. isBootstrapAdmin is what makes the account UNDEMOTABLE, so
  // if it matches more loosely than the claim does, an unconfirmed squatter on
  // the address is locked out of admin and simultaneously protected from
  // removal.
  //
  // A source assertion because the alternative is mocking the Supabase admin
  // client to test one boolean.
  const src = readFileSync("src/utils/iam.server.ts", "utf8");

  /** A top-level function's body, delimited by the closing brace in column 0. */
  const fnBody = (name: string) => {
    const from = src.indexOf(`export async function ${name}`);
    expect(from, `${name} not found`).toBeGreaterThan(-1);
    const end = src.indexOf("\n}", from);
    return src.slice(from, end);
  };

  it("isBootstrapAdmin decides through bootstrapClaimAllowed", () => {
    const body = fnBody("isBootstrapAdmin");
    expect(body).toContain("bootstrapClaimAllowed({");
    // A bare address comparison anywhere in this function is the mutation this
    // test exists for: it would grant demotion-immunity on the address alone.
    // The first version sliced to the first "}", which lands inside the
    // `const { data }` destructuring — so it asserted against three words and
    // the mutant sailed through.
    expect(body, "bare address comparison is back").not.toMatch(/===\s*bootstrap\b/);
  });

  it("requireSuperadmin decides through it too", () => {
    const body = src.slice(
      src.indexOf("export async function requireSuperadmin"),
      src.indexOf("export async function isBootstrapAdmin"),
    );
    expect(body).toContain("bootstrapClaimAllowed({");
    // The near-miss message is allowed to compare addresses — it grants
    // nothing, it only explains. So the assertion is that the GRANT does not.
    const grant = body.slice(0, body.indexOf("upsert"));
    expect(grant).toContain("bootstrapClaimAllowed({");
  });
});

describe("what this check does not do", () => {
  it("cannot distinguish the operator from a squatter under autoconfirm", () => {
    // Documented as a test because it is a real, remaining exposure and the
    // next person to read this code should not conclude it is handled. With
    // Supabase email confirmations disabled, email_confirmed_at is stamped at
    // signup for EVERY account — so both of these are the same input, and the
    // server has no way to tell them apart. The mitigation is configuration
    // (turn confirmations on), which is why the docs say so.
    const operator = claim({ emailConfirmedAt: CONFIRMED });
    const squatterUnderAutoconfirm = claim({ emailConfirmedAt: CONFIRMED });
    expect(operator).toBe(true);
    expect(squatterUnderAutoconfirm).toBe(true);
  });
});
