// Email has two transports and needs no account for either.
//
// FOUND FROM A QUESTION: "right now we are using resend, can we not provide
// in-built email and keep resend as optional?" The answer was that SMTP had
// been built in all along and Resend was never required — but everything a
// reader touches said otherwise. The mailer's own header told them to
// `npm install nodemailer`, which is a dependency of this package and needs no
// installing, and called SMTP "Node/Docker deployments only", which is every
// deployment shape there is. The installation guide gave Resend a four-step
// walkthrough with DNS records and gave SMTP one clause inside a sentence.
//
// None of that was a bug in the code. It was a bug in what the code appeared
// to be, and it cost a reader the belief that a third party was mandatory. So
// these tests pin the shape of the offer, not the behaviour of the sender.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const mailer = rd("src/lib/email/mailer.server.ts");
const env = rd(".env.example");
const install = rd("docs/INSTALL.md");
const configPage = rd("src/routes/docs.self-hosting_.configuration.tsx");

/**
 * Comments removed, for asserting an ABSENCE.
 *
 * The mailer now carries a comment explaining why it no longer tells anyone to
 * install nodemailer — and that explanation contains the sentence it forbids.
 * The first version of this file failed on its own reasoning, which is the same
 * trap the vector-store tests documented.
 */
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Prose with its line breaks flattened, since JSX wraps mid-sentence. */
const proseOf = (s: string) => s.replace(/\s+/g, " ");

describe("SMTP is built in, not an extra step", () => {
  it("ships nodemailer as a dependency", () => {
    const pkg = JSON.parse(rd("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // A runtime dependency, not a dev one: the SMTP path runs in production.
    expect(pkg.dependencies?.nodemailer, "nodemailer is not a runtime dependency").toBeTruthy();
  });

  it("never tells the operator to install it", () => {
    for (const doc of [mailer, env, install, configPage]) {
      expect(codeOf(doc)).not.toMatch(/npm install nodemailer/);
    }
  });

  it("does not describe SMTP as a restricted deployment shape", () => {
    // "Node/Docker deployments only" excludes nothing — every way this product
    // ships is one of those — while reading as a caveat.
    for (const doc of [mailer, env]) {
      expect(codeOf(doc)).not.toMatch(/Node\/Docker deployments only/);
    }
  });
});

describe("neither transport is mandatory", () => {
  it("keeps working with no mailer at all", () => {
    // The third branch is the one that matters most: a deployment that
    // configured nothing must still run, and must say what it skipped.
    expect(mailer).toContain("no_mailer_configured");
    expect(mailer).toMatch(/sendMail[\s\S]{0,600}console\.log/);
    // And a send never throws, because every caller treats mail as
    // best-effort and none of them is prepared to handle a rejection.
    expect(mailer).toMatch(/Never throws/i);
  });

  it("offers SMTP first where somebody chooses", () => {
    // Resend still wins at RUNTIME when both are set — that is a precedence
    // rule, not a recommendation — but the documents a person reads before
    // configuring anything lead with the option that needs no account.
    for (const [name, doc] of [
      [".env.example", env],
      ["INSTALL.md", install],
    ] as const) {
      const smtp = doc.indexOf("SMTP_HOST");
      const resend = doc.indexOf("RESEND_API_KEY");
      expect(smtp, `${name} does not mention SMTP_HOST`).toBeGreaterThan(-1);
      expect(resend, `${name} does not mention RESEND_API_KEY`).toBeGreaterThan(-1);
      expect(smtp, `${name} still introduces Resend before SMTP`).toBeLessThan(resend);
    }
  });

  it("says outright that no third party is needed", () => {
    for (const [name, doc] of [
      [".env.example", env],
      ["INSTALL.md", install],
      ["the configuration page", configPage],
    ] as const) {
      expect(proseOf(doc), `${name} never says an account is unnecessary`).toMatch(
        /No (third-party )?account is required|no third party/i,
      );
    }
  });

  it("keeps Resend's real constraint documented rather than deleting it", () => {
    // Demoting it is not the same as hiding it: a key on its own sends only
    // from onboarding@resend.dev to the account owner, which is the failure
    // that looks like success.
    expect(install).toMatch(/onboarding@resend\.dev/);
    expect(env).toMatch(/onboarding@resend\.dev/);
  });
});

describe("auth email is a separate system", () => {
  it("says so wherever outbound mail is configured", () => {
    // Password resets and confirmations go through Supabase. Somebody who
    // configures neither transport and then cannot sign up would otherwise
    // look for the cause here, where it is not.
    for (const [name, doc] of [
      [".env.example", env],
      ["INSTALL.md", install],
      ["the configuration page", configPage],
    ] as const) {
      expect(proseOf(doc), `${name} does not separate auth email from transactional`).toMatch(
        /Supabase sends (those|them)|sent by Supabase itself/i,
      );
    }
  });
});
