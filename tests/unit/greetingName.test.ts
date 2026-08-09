// Which store wins when the app knows your name in more than one place.
//
// Measured on the live instance: profiles held {first_name: "Rohan",
// display_name: "Rohan Ghosh"} while auth user_metadata held no name at all.
// The dashboard read only the metadata and greeted "Welcome back, Rghosh044",
// two inches from a sidebar that said "Rohan Ghosh".
import { describe, expect, it } from "vitest";

import { greetingName } from "@/lib/greetingName";

describe("greetingName prefers the name the user actually set", () => {
  it("uses profiles.first_name over the email prefix", () => {
    // The exact state of this instance before the fix.
    expect(
      greetingName({
        firstName: "Rohan",
        displayName: "Rohan Ghosh",
        metaFullName: null,
        email: "rghosh044@gmail.com",
      }),
    ).toBe("Rohan");
  });

  it("prefers first_name over display_name when they differ", () => {
    // The case above cannot prove this on its own: its display_name starts
    // with the same word, so ignoring first_name entirely still yields
    // "Rohan". Verified by mutation — deleting the first_name branch left that
    // test green. Here the two sources disagree, so only the real precedence
    // passes.
    expect(
      greetingName({
        firstName: "Rohan",
        displayName: "Dr Ghosh",
        email: "rghosh044@gmail.com",
      }),
    ).toBe("Rohan");
  });

  it("falls back to display_name when no first name is stored", () => {
    expect(greetingName({ displayName: "Ada Lovelace", email: "ada@example.com" })).toBe("Ada");
  });

  it("does not greet an email address as a name", () => {
    // Admin-provisioned accounts default display_name to the address. Greeting
    // it produces "Welcome back, ada@example.com".
    expect(greetingName({ displayName: "ada@example.com", email: "ada@example.com" })).toBe("Ada");
  });

  it("still honours auth metadata when there is no profile row", () => {
    // A brand-new OAuth user has metadata but no profile yet.
    expect(greetingName({ metaFullName: "Grace Hopper", email: "grace@example.com" })).toBe(
      "Grace",
    );
  });

  it("capitalises the email prefix when nothing else is known", () => {
    expect(greetingName({ email: "rghosh044@gmail.com" })).toBe("Rghosh044");
  });

  it("uses the fallback when there is nothing at all", () => {
    expect(greetingName({})).toBe("there");
    expect(greetingName({ email: "" })).toBe("there");
  });

  it("reduces a full name to one word", () => {
    // "Welcome back, Rohan Ghosh" reads as a form letter.
    expect(greetingName({ firstName: "  Rohan   Kumar " })).toBe("Rohan");
  });

  it("treats whitespace-only values as absent", () => {
    expect(greetingName({ firstName: "   ", displayName: "  ", email: "sam@example.com" })).toBe(
      "Sam",
    );
  });
});
