// The pure half of the web connector: URL rules, sitemap parsing, link
// extraction, robots.txt. No network, no server imports — so every decision
// about WHICH pages a crawl may touch is testable without fetching anything.
//
// The connector itself (connectors.server.ts) does the fetching and calls in
// here for every judgement. Keeping judgement and I/O apart is what lets a
// test assert "a link to another host is never followed" as a fact about a
// function rather than a hope about a mock.

/** Pages per source. Matches MAX_ITEMS_PER_SOURCE in connectors.server.ts. */
export const WEB_MAX_PAGES = 500;
/** The default when the user leaves the field empty — a docs site, not the web. */
export const WEB_DEFAULT_MAX_PAGES = 100;

export type WebConfig = {
  /** Where the crawl begins. Same-site links are followed from here. */
  start_urls: string[];
  /** Optional: read this sitemap instead of discovering links by crawling. */
  sitemap_url?: string;
  /** Hard cap on pages listed, 1..WEB_MAX_PAGES. */
  max_pages?: number;
  /** Only URLs whose path starts with one of these are kept. Empty = all. */
  path_prefixes?: string[];
};

/**
 * Canonical form for dedup: lowercase host, no fragment, no trailing slash
 * (except the root), and tracking parameters stripped. Two links to the same
 * page must map to one item, or the crawl indexes it twice and the passport
 * says the site has twice as many pages as it does.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$|mc_)/i.test(k)) u.searchParams.delete(k);
  }
  let s = u.toString();
  if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Same registrable host, ignoring a leading "www." on either side. */
export function sameSite(a: string, b: string): boolean {
  const host = (s: string) => {
    try {
      return new URL(s).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
  };
  const ha = host(a);
  const hb = host(b);
  return ha !== null && ha === hb;
}

/** True when the URL passes the user's optional path filter. */
export function withinPrefixes(url: string, prefixes: string[] | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return prefixes.some((p) => path.startsWith(p.startsWith("/") ? p : `/${p}`));
}

/** Things that are not pages: assets, binaries, feeds. Never fetched. */
const NON_PAGE_RE =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|eot|zip|gz|tgz|tar|pdf|mp[34]|webm|mov|avi|xml|rss|atom|json|txt)(\?|$)/i;

export function looksLikePage(url: string): boolean {
  return !NON_PAGE_RE.test(url);
}

/**
 * Extract candidate links from HTML without a DOM: href="…" and href='…'.
 * Good enough for navigation links, which is all a crawler needs; the page
 * TEXT is extracted properly by nativeScrape, not here.
 */
export function extractLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] ?? m[2] ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    const n = normalizeUrl(href, pageUrl);
    if (n) out.add(n);
  }
  return [...out];
}

export type SitemapEntry = { url: string; lastmod?: string };

/**
 * Parse a sitemap or sitemap index. Returns page entries and any nested
 * sitemap URLs (an index points at sitemaps, not pages). Tolerant of the
 * whitespace and CDATA real sitemaps contain; a regex is enough because the
 * schema is two tags deep and we only need <loc> and <lastmod>.
 */
export function parseSitemap(xml: string): { pages: SitemapEntry[]; sitemaps: string[] } {
  const pages: SitemapEntry[] = [];
  const sitemaps: string[] = [];
  const strip = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
  const blocks = xml.match(/<(url|sitemap)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(block)?.[1];
    if (!loc) continue;
    const url = normalizeUrl(strip(loc));
    if (!url) continue;
    if (/^<sitemap\b/i.test(block)) {
      sitemaps.push(url);
    } else {
      const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(block)?.[1];
      pages.push({ url, ...(lastmod ? { lastmod: strip(lastmod) } : {}) });
    }
  }
  return { pages, sitemaps };
}

/**
 * Minimal robots.txt: the Disallow rules that apply to us (our own agent
 * group, else `*`). A crawler that ignores robots.txt is a crawler someone
 * eventually blocks at the firewall, taking the whole platform's egress with
 * it. Allow rules and wildcards beyond a trailing `*` are not modelled — when
 * in doubt this errs toward NOT fetching.
 */
export function parseRobots(text: string, agent = "agentswarms"): string[] {
  const groups: { agents: string[]; disallow: string[] }[] = [];
  let cur: { agents: string[]; disallow: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!cur || cur.disallow.length > 0) {
        cur = { agents: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
    } else if (key === "disallow" && cur) {
      if (val) cur.disallow.push(val);
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const star = groups.find((g) => g.agents.includes("*"));
  return (mine ?? star)?.disallow ?? [];
}

export function robotsAllows(url: string, disallow: string[]): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  return !disallow.some((rule) => {
    const r = rule.endsWith("*") ? rule.slice(0, -1) : rule;
    return path.startsWith(r);
  });
}

/** Validate user config; a message for the wizard, or null when usable. */
export function validateWebConfig(config: Record<string, unknown>): string | null {
  const starts = config.start_urls;
  if (!Array.isArray(starts) || starts.length === 0) {
    return "Enter at least one start URL, e.g. https://docs.example.com";
  }
  for (const s of starts) {
    if (typeof s !== "string" || !normalizeUrl(s)) return `"${String(s)}" is not an http(s) URL`;
  }
  if (config.sitemap_url !== undefined) {
    if (typeof config.sitemap_url !== "string" || !normalizeUrl(config.sitemap_url)) {
      return "Sitemap URL must be an http(s) URL";
    }
    if (!sameSite(config.sitemap_url, starts[0] as string)) {
      return "The sitemap must be on the same site as the start URL";
    }
  }
  if (config.max_pages !== undefined) {
    const n = Number(config.max_pages);
    if (!Number.isInteger(n) || n < 1 || n > WEB_MAX_PAGES) {
      return `Max pages must be a whole number between 1 and ${WEB_MAX_PAGES}`;
    }
  }
  return null;
}
