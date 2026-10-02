// Confluence as a knowledge-base source -- Cloud and Data Center, one
// connector.
//
// The enterprise wiki: Drive, Notion, SharePoint and Dropbox were connected,
// and the place most companies keep their runbooks and policies was not.
// There is no Confluence to run against here, so the tests pin what fails
// quietly in production: which deployment a URL is, which auth form each one
// needs, what the wizard tells the user when something is missing, and that
// storage-format HTML -- with its macros -- becomes readable text.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  confluenceApiBase,
  confluenceAuthHeader,
  isConfluenceCloud,
  storageHtmlToText,
  validateConfluence,
} from "@/utils/kb/confluence.server";

const CONNECTORS = readFileSync("src/utils/kb/connectors.server.ts", "utf8");
const SOURCES_ROUTE = readFileSync("src/routes/api/kb/sources.ts", "utf8");
const DIALOG = readFileSync("src/components/knowledge/ConnectSourceDialog.tsx", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20260852000000_kb_confluence_connector.sql",
  "utf8",
);
const MODULE = readFileSync("src/utils/kb/confluence.server.ts", "utf8");

describe("one connector, two deployments", () => {
  it("tells Cloud from Data Center by the host", () => {
    expect(isConfluenceCloud("https://acme.atlassian.net")).toBe(true);
    expect(isConfluenceCloud("https://confluence.acme.com")).toBe(false);
    expect(isConfluenceCloud("not a url")).toBe(false);
  });

  it("mounts the API where each deployment serves it", () => {
    expect(confluenceApiBase("https://acme.atlassian.net/")).toBe(
      "https://acme.atlassian.net/wiki/rest/api",
    );
    expect(confluenceApiBase("https://confluence.acme.com/")).toBe(
      "https://confluence.acme.com/rest/api",
    );
    // A Data Center behind a context path keeps it.
    expect(confluenceApiBase("https://intranet.acme.com/confluence")).toBe(
      "https://intranet.acme.com/confluence/rest/api",
    );
  });

  it("uses Basic(email:token) on Cloud and a Bearer PAT on Data Center", () => {
    const basic = confluenceAuthHeader("https://acme.atlassian.net", {
      token: "tok",
      email: "a@b.c",
    });
    expect(basic).toBe(`Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
    expect(confluenceAuthHeader("https://confluence.acme.com", { token: "pat" })).toBe(
      "Bearer pat",
    );
    expect(() => confluenceAuthHeader("https://acme.atlassian.net", { token: "tok" })).toThrow(
      /email/,
    );
  });
});

describe("the wizard says what to fix", () => {
  it("needs a site URL", () => {
    expect(validateConfluence({}, { token: "t" })).toMatch(/site URL/);
  });
  it("asks for the right credential for the deployment", () => {
    expect(
      validateConfluence({ site_url: "https://a.atlassian.net", space_keys: ["X"] }, {}),
    ).toMatch(/API token/);
    expect(validateConfluence({ site_url: "https://c.acme.com", space_keys: ["X"] }, {})).toMatch(
      /personal access token/,
    );
    expect(
      validateConfluence(
        { site_url: "https://a.atlassian.net", space_keys: ["X"] },
        { token: "t" },
      ),
    ).toMatch(/email/);
  });
  it("needs at least one well-formed space key", () => {
    const creds = { token: "t", email: "a@b.c" };
    expect(validateConfluence({ site_url: "https://a.atlassian.net" }, creds)).toMatch(/space key/);
    expect(
      validateConfluence({ site_url: "https://a.atlassian.net", space_keys: ["bad key"] }, creds),
    ).toMatch(/space key/);
    expect(
      validateConfluence(
        { site_url: "https://a.atlassian.net", space_keys: ["ENG", "~jdoe"] },
        creds,
      ),
    ).toBeNull();
  });
});

describe("storage format becomes readable text", () => {
  it("keeps prose and code, drops macro parameters and link metadata", () => {
    const html = `
      <h1>Runbook</h1>
      <p>Restart the <strong>worker</strong> first.</p>
      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">bash</ac:parameter>
        <ac:plain-text-body><![CDATA[systemctl restart worker]]></ac:plain-text-body>
      </ac:structured-macro>
      <p>See <ac:link><ri:page ri:content-title="Escalation" /></ac:link>.</p>
      <table><tr><th>Sev</th><th>Pager</th></tr><tr><td>1</td><td>yes</td></tr></table>`;
    const text = storageHtmlToText(html);
    expect(text).toContain("Runbook");
    expect(text).toContain("Restart the worker first.");
    expect(text).toContain("systemctl restart worker");
    expect(text).not.toContain("language");
    expect(text).not.toContain("bash");
    expect(text).toMatch(/Sev\tPager/);
    expect(text).toMatch(/1\tyes/);
  });
});

describe("wired in, at the source", () => {
  it("is a registered kind with token credentials, everywhere a kind is checked", () => {
    expect(CONNECTORS).toMatch(/export type ConnectorKind = [^;]*"confluence"/);
    expect(CONNECTORS).toMatch(/kind: "confluence"/);
    expect(SOURCES_ROUTE).toMatch(/z\.enum\(\[[^\]]*"confluence"/);
    expect(MIGRATION).toContain("'confluence'");
    expect(DIALOG).toMatch(/kind: "confluence"/);
  });

  it("goes through the proxy-aware fetch, never bare fetch", () => {
    // An enterprise Confluence is the source most likely to sit behind an
    // egress proxy, and a bare fetch would fail there with no useful error.
    expect(MODULE).toContain("connectorFetch(");
    expect(MODULE.replace(/\/\/.*$/gm, "")).not.toMatch(/[^a-zA-Z.]fetch\(/);
  });

  it("throws on a bad token rather than returning an empty listing", () => {
    // The file-wide failure policy: [] on failure would delete every synced
    // document as remotely-removed.
    expect(MODULE).toMatch(/if \(res\.status === 401\) \{\s*throw new Error/);
    // Comments off: the module's own header says "never return []" while
    // explaining the policy this asserts.
    const code = MODULE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code).not.toMatch(/return \[\]/);
  });
});
