// A knowledge base fed by a website, kept in sync -- and the rules that stop
// it wandering off.
//
// The platform could ingest one page and one repo; it could not index a docs
// site. This connector lists pages from a sitemap or by following SAME-SITE
// links, and the sync engine then does what it does for every connector:
// re-fetch what changed, drop what vanished, leave the rest alone.
//
// Judgement (which URLs may be touched) lives in webCrawl.ts with no I/O, so
// every rule below is a fact about a function, not a hope about a mock. The
// I/O half is checked at the source level for the two properties that matter:
// it never needs a credential, and it stays inside the SSRF guard.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  extractLinks,
  looksLikePage,
  normalizeUrl,
  parseRobots,
  parseSitemap,
  robotsAllows,
  sameSite,
  validateWebConfig,
  WEB_MAX_PAGES,
  withinPrefixes,
} from "@/utils/kb/webCrawl";

const CONNECTORS = readFileSync("src/utils/kb/connectors.server.ts", "utf8");
const SYNC = readFileSync("src/utils/kb/sync.server.ts", "utf8");
const SOURCES_ROUTE = readFileSync("src/routes/api/kb/sources.ts", "utf8");
const DIALOG = readFileSync("src/components/knowledge/ConnectSourceDialog.tsx", "utf8");
const MIGRATION = readFileSync("supabase/migrations/20260851000000_kb_web_connector.sql", "utf8");

describe("one page, one item", () => {
  it("maps every spelling of a URL to one canonical form", () => {
    // Otherwise the same page is indexed twice and the count lies.
    const a = normalizeUrl("https://Docs.Example.com/guide/#intro");
    const b = normalizeUrl("https://docs.example.com/guide?utm_source=x");
    expect(a).toBe("https://docs.example.com/guide");
    expect(b).toBe("https://docs.example.com/guide");
  });

  it("keeps the root slash and meaningful query strings", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com/search?q=a")).toBe("https://example.com/search?q=a");
  });

  it("refuses anything that is not http(s)", () => {
    expect(normalizeUrl("ftp://example.com/x")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("staying on the site", () => {
  it("treats www and bare host as the same site, other hosts as not", () => {
    expect(sameSite("https://www.example.com/a", "https://example.com/b")).toBe(true);
    expect(sameSite("https://docs.example.com/a", "https://example.com/b")).toBe(false);
    expect(sameSite("https://example.com", "https://evil.com")).toBe(false);
  });

  it("follows only same-site links out of a page", () => {
    const html = `
      <a href="/guide/intro">in</a>
      <a href="https://example.com/guide/next#x">in</a>
      <a href="https://other.com/leak">out</a>
      <a href="mailto:x@y.z">no</a>
      <a href='#top'>no</a>`;
    const links = extractLinks(html, "https://example.com/guide/");
    expect(links).toContain("https://example.com/guide/intro");
    expect(links).toContain("https://example.com/guide/next");
    // Extracted, but the CONNECTOR must drop it -- pinned separately below.
    expect(links).toContain("https://other.com/leak");
    expect(links.some((l) => l.startsWith("mailto"))).toBe(false);
  });

  it("honours an optional path filter", () => {
    expect(withinPrefixes("https://x.com/docs/a", ["/docs"])).toBe(true);
    expect(withinPrefixes("https://x.com/blog/a", ["/docs"])).toBe(false);
    expect(withinPrefixes("https://x.com/anything", undefined)).toBe(true);
    expect(withinPrefixes("https://x.com/docs/a", ["docs"])).toBe(true);
  });

  it("never fetches assets as pages", () => {
    for (const u of ["https://x.com/a.png", "https://x.com/app.js?v=1", "https://x.com/f.pdf"])
      expect(looksLikePage(u), u).toBe(false);
    expect(looksLikePage("https://x.com/docs/getting-started")).toBe(true);
  });
});

describe("sitemaps", () => {
  it("reads pages and their lastmod, which becomes the change marker", () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc> https://example.com/a </loc><lastmod>2026-09-01</lastmod></url>
        <url><loc><![CDATA[https://example.com/b]]></loc></url>
      </urlset>`;
    const { pages, sitemaps } = parseSitemap(xml);
    expect(pages).toEqual([
      { url: "https://example.com/a", lastmod: "2026-09-01" },
      { url: "https://example.com/b" },
    ]);
    expect(sitemaps).toEqual([]);
  });

  it("reads a sitemap index as sitemaps to follow, not pages", () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>`;
    const { pages, sitemaps } = parseSitemap(xml);
    expect(pages).toEqual([]);
    expect(sitemaps).toEqual(["https://example.com/s1.xml"]);
  });
});

describe("robots.txt", () => {
  const robots = `
    User-agent: *
    Disallow: /private/
    Disallow: /tmp*

    User-agent: AgentSwarms
    Disallow: /internal/
  `;
  it("prefers our own group when the site names us", () => {
    const rules = parseRobots(robots);
    expect(rules).toEqual(["/internal/"]);
    expect(robotsAllows("https://x.com/internal/a", rules)).toBe(false);
    expect(robotsAllows("https://x.com/private/a", rules)).toBe(true);
  });

  it("falls back to * and understands a trailing wildcard", () => {
    const rules = parseRobots(robots, "someone-else");
    expect(rules).toEqual(["/private/", "/tmp*"]);
    expect(robotsAllows("https://x.com/tmp123", rules)).toBe(false);
    expect(robotsAllows("https://x.com/docs", rules)).toBe(true);
  });

  it("an unparseable URL is never allowed", () => {
    expect(robotsAllows("nope", [])).toBe(false);
  });
});

describe("config validation says what to fix", () => {
  it("needs a start URL", () => {
    expect(validateWebConfig({})).toMatch(/at least one start URL/);
    expect(validateWebConfig({ start_urls: ["nope"] })).toMatch(/not an http\(s\) URL/);
  });
  it("keeps the sitemap on the same site", () => {
    expect(
      validateWebConfig({ start_urls: ["https://a.com"], sitemap_url: "https://b.com/s.xml" }),
    ).toMatch(/same site/);
  });
  it("caps pages", () => {
    expect(
      validateWebConfig({ start_urls: ["https://a.com"], max_pages: WEB_MAX_PAGES + 1 }),
    ).toMatch(/between 1 and/);
    expect(validateWebConfig({ start_urls: ["https://a.com"], max_pages: 50 })).toBeNull();
  });
});

describe("the connector, at the source", () => {
  it("is registered as a credential-free kind everywhere a kind is checked", () => {
    expect(CONNECTORS).toMatch(/export type ConnectorKind = [^;]*"web"/);
    expect(CONNECTORS).toMatch(/kind: "web"/);
    expect(CONNECTORS).toMatch(/credentialless: true/);
    expect(SOURCES_ROUTE).toMatch(/z\.enum\(\[[^\]]*"web"/);
    expect(MIGRATION).toContain("'web'");
  });

  it("relaxes the credential requirement ONLY for credential-free connectors", () => {
    // Every other kind keeps failing loudly on missing credentials -- a silent
    // {} there would turn "credentials revoked" into "zero documents", which
    // deletes every synced document. The check must stay for them.
    expect(SYNC).toContain("connector.credentialless");
    expect(SYNC).toContain("No stored credentials — edit this source and save them again.");
    expect(SOURCES_ROUTE).toContain("connector.credentialless");
    expect(SOURCES_ROUTE).toContain('"Credentials are required"');
  });

  it("drops links to other sites before fetching, and obeys robots", () => {
    // extractLinks returns every href; the CONNECTOR is what must filter.
    // The exact gate lines, not the function names: `sameSite(` also appears
    // in the sitemap loop, so a mutation that deleted the crawl gate would
    // otherwise slip past a looser assertion. Found by mutation-testing this
    // very test.
    const web = CONNECTORS.slice(CONNECTORS.indexOf('kind: "web"'));
    expect(web).toContain("if (!sameSite(url, origin)) return false;");
    expect(web).toContain("if (!robotsAllows(url, disallow)) {");
    expect(web).toContain("if (!looksLikePage(url)) return false;");
    expect(web).toContain("if (!withinPrefixes(url, cfg.path_prefixes)) return false;");
  });

  it("fetches through the SSRF guard, never bare fetch", () => {
    // The whole web section: its fetch helper is declared above the connector.
    const web = CONNECTORS.slice(
      CONNECTORS.indexOf("const WEB_FETCH_TIMEOUT_MS"),
      CONNECTORS.indexOf("export const KB_CONNECTORS"),
    );
    expect(web).toContain("safeFetch(");
    expect(web).not.toMatch(/[^a-zA-Z.]fetch\(/);
  });

  it("the wizard offers it and sends empty credentials rather than none", () => {
    // `credentials: undefined` means "keep what is stored" on the server. For a
    // connector with nothing to store, that reads as "credentials required".
    expect(DIALOG).toMatch(/kind: "web"/);
    // Whitespace-tolerant: prettier wraps this ternary.
    expect(DIALOG).toMatch(/provider\.credFields\.length === 0\s*\?\s*\{\}\s*:/);
  });
});
