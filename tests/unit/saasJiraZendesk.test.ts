// Jira and Zendesk as SaaS sources.
//
// Five sources covered finance, commerce and CRM; the ticket queue and the
// issue tracker -- where the support and engineering halves of a company
// live -- were missing. There is no Jira or Zendesk to run against here, so
// these pin what fails quietly in production: the odd Zendesk token form
// (`email/token:` -- omit the suffix and a valid token returns 401), the
// subdomain normalisation, that both go through the proxy-aware fetch, that
// both fail loudly on a bad credential, and that every registry the rest of
// the app checks knows the two new providers.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { connectorFor } from "@/utils/saas/sync.server";
import { SAAS_LABELS, SAAS_PROVIDERS } from "@/utils/saas/types";
import { zendeskAuthHeader, zendeskOrigin } from "@/utils/saas/zendesk.server";

const JIRA = readFileSync("src/utils/saas/jira.server.ts", "utf8");
const ZENDESK = readFileSync("src/utils/saas/zendesk.server.ts", "utf8");
const TAB = readFileSync("src/components/integrations/SaasSourcesTab.tsx", "utf8");
const MIGRATION = readFileSync("supabase/migrations/20260853000000_saas_jira_zendesk.sql", "utf8");
const DOCS = readFileSync("docs/DATA_SOURCES.md", "utf8");

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("registered everywhere a provider is checked", () => {
  it("is a provider with a label and a connector", () => {
    for (const p of ["jira", "zendesk"] as const) {
      expect(SAAS_PROVIDERS).toContain(p);
      expect(SAAS_LABELS[p].length).toBeGreaterThan(0);
      expect(() => connectorFor(p)).not.toThrow();
    }
  });

  it("the wizard, the database and the docs agree", () => {
    expect(TAB).toMatch(/\n {2}jira: \{/);
    expect(TAB).toMatch(/\n {2}zendesk: \{/);
    expect(MIGRATION).toContain("'jira'");
    expect(MIGRATION).toContain("'zendesk'");
    expect(DOCS).toMatch(/\*\*Jira\*\*/);
    expect(DOCS).toMatch(/\*\*Zendesk\*\*/);
  });
});

describe("Zendesk's credential form", () => {
  it("normalises whatever was pasted to the subdomain origin", () => {
    expect(zendeskOrigin("acme")).toBe("https://acme.zendesk.com");
    expect(zendeskOrigin("https://Acme.zendesk.com/agent/tickets")).toBe(
      "https://acme.zendesk.com",
    );
    expect(() => zendeskOrigin("not a subdomain")).toThrow(/subdomain/);
  });

  it("sends email/token, which is the part people get wrong", () => {
    expect(zendeskAuthHeader("a@b.c", "tok")).toBe(
      `Basic ${Buffer.from("a@b.c/token:tok").toString("base64")}`,
    );
  });
});

describe("both connectors, at the source", () => {
  it("go through the proxy-aware fetch, never bare fetch", () => {
    for (const [name, src] of [
      ["jira", JIRA],
      ["zendesk", ZENDESK],
    ] as const) {
      expect(src, name).toContain("connectorFetch(");
      expect(code(src), name).not.toMatch(/[^a-zA-Z.]fetch\(/);
    }
  });

  it("fail loudly on a bad credential instead of yielding nothing", () => {
    // An empty dataset that looks like success is the worst outcome a sync can
    // have: the next reader concludes the queue is empty.
    for (const [name, src] of [
      ["jira", JIRA],
      ["zendesk", ZENDESK],
    ] as const) {
      expect(src, name).toMatch(/if \(res\.status === 401\) \{\s*throw new Error/);
    }
  });

  it("page with the cursor the API gives, not an offset cap", () => {
    // Zendesk caps offset pagination at 10,000 records -- the size of desk
    // that needs this connector most.
    expect(ZENDESK).toContain('"page[size]"');
    expect(ZENDESK).toContain("after_cursor");
    expect(JIRA).toContain("startAt");
  });

  it("refuses an unknown stream rather than fetching something else", () => {
    expect(JIRA).toMatch(/unknown stream/);
    expect(ZENDESK).toMatch(/unknown stream/);
  });
});
