// Built-in page fetcher: the floor under web_browse and URL ingestion when no
// Firecrawl key is configured.
//
// WHY THIS EXISTS. Both surfaces used to require Firecrawl outright: the
// web_browse tool was hidden from the model unless a key existed, and adding a
// URL to a knowledge base failed with FIRECRAWL_NOT_CONNECTED. So a
// self-hoster who had not signed up for a third-party service could not read a
// page at all — while web_search, the sibling tool, degraded to a free
// provider rather than disappearing. This closes that gap.
//
// WHAT IT IS NOT. This fetches HTML and converts it; it does not run
// JavaScript. A server-rendered page (docs, blogs, licences, most
// documentation sites) converts well. A client-rendered SPA returns its empty
// shell, and no amount of parsing recovers text the server never sent — that
// needs a headless browser, which is what Firecrawl is worth paying for. The
// result reports `thin: true` in that case rather than pretending, so callers
// can say so instead of handing the model an empty string.
import * as cheerio from "cheerio";
import TurndownService from "turndown";

import { safeFetch } from "@/utils/ssrfGuard.server";

/** Hard ceiling on the bytes we will read from a URL (8 MiB). */
const MAX_BYTES = 8 * 1024 * 1024;
/** Wall-clock budget for the fetch. */
const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * Below this many characters of extracted text, the page is reported as thin —
 * in practice a client-rendered shell. Kept low so a short but genuine page (a
 * definition, a changelog entry) is not mislabelled as JavaScript-rendered; an
 * empty SPA shell yields far less than this.
 */
const THIN_TEXT_CHARS = 120;
/** A content container must beat this to be preferred over <body>. */
const MIN_CONTAINER_CHARS = 200;

/**
 * A browser-ish UA. Some sites 403 an obviously scripted client, and being
 * refused is worse for the user than being identified — but the token still
 * names this app so an operator reading their logs can tell who called.
 */
const USER_AGENT =
  "Mozilla/5.0 (compatible; AgentSwarms/1.0; +https://github.com/AgentSwarms-fyi/agentswarms)";

export type NativeScrapeResult = {
  provider: "native";
  url: string;
  /** The final URL after redirects, when it differs from the request. */
  finalUrl?: string;
  title: string | null;
  description: string | null;
  markdown: string;
  /** Characters of extracted text, before markdown syntax is added. */
  textChars: number;
  /**
   * True when the page yielded almost no text. Nearly always a client-rendered
   * page whose content arrives via JavaScript.
   */
  thin: boolean;
  note?: string;
};

/**
 * Elements that are never the article. Stripped before extraction so a page's
 * nav and cookie banner do not become the "content" of a thin page.
 */
const CHROME_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  "template",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='search']",
  ".nav",
  ".navbar",
  ".sidebar",
  ".menu",
  ".breadcrumb",
  ".cookie",
  ".cookies",
  ".consent",
  ".advertisement",
  ".ads",
  ".social-share",
  ".skip-link",
];

/**
 * Where the article usually is, MOST SPECIFIC FIRST — the order is the whole
 * point. Picking the densest match across all of these sounds smarter and is
 * worse: on GitHub the densest container is the entire page shell, so a README
 * came back with "Uh oh! There was an error while loading" and the repo nav in
 * front of it. A precise hook like .markdown-body wins even though it holds
 * less text than <main>, because it holds the RIGHT text.
 */
const CONTENT_SELECTORS = [
  ".markdown-body", // GitHub / GitLab rendered markdown
  "#readme",
  ".article-content",
  ".post-content",
  ".entry-content",
  ".docs-content",
  ".documentation",
  "article",
  "[role='main']",
  "main",
  "#main-content",
  "#content",
];

function buildTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  // Tables survive as pipe tables rather than being flattened to prose. A
  // pricing or spec table is often the only thing on the page worth reading,
  // and Turndown drops the structure by default.
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      // `node` is a DOM node, not a string. Passing it straight to cheerio
      // parsed nothing, so the rule returned "" and every table vanished.
      const html = (node as unknown as { outerHTML?: string }).outerHTML || "";
      const $ = cheerio.load(html, null, false);
      const rows: string[][] = [];
      $("tr").each((_i, tr) => {
        const cells: string[] = [];
        $(tr)
          .find("th,td")
          .each((_j, cell) => {
            cells.push($(cell).text().trim().replace(/\s+/g, " "));
          });
        if (cells.length) rows.push(cells);
      });
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
      const [head, ...body] = rows;
      const lines = [
        `| ${pad(head).join(" | ")} |`,
        `| ${Array(width).fill("---").join(" | ")} |`,
        ...body.map((r) => `| ${pad(r).join(" | ")} |`),
      ];
      return `\n\n${lines.join("\n")}\n\n`;
    },
  });
  return td;
}

/** Collapse the runs of blank lines that stripping chrome tends to leave. */
function tidyMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fetch a URL and convert it to markdown, without a third-party service.
 *
 * Every request goes through safeFetch, so the target and EVERY redirect hop
 * are re-validated against the SSRF guard. That matters more here than in most
 * places: for web_browse the URL is chosen by the model, which means it is
 * reachable by prompt injection.
 */
export async function nativeScrape(
  rawUrl: string,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): Promise<NativeScrapeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await safeFetch(rawUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  // Only HTML is handled here. PDFs and Office files have their own extractors
  // elsewhere in the app; sending their bytes through an HTML parser would
  // produce confident nonsense, so refuse instead and let the caller decide.
  if (contentType && !/text\/html|application\/xhtml|text\/plain|^$/.test(contentType)) {
    throw new Error(`Unsupported content type for the built-in fetcher: ${contentType}`);
  }

  const declaredLength = Number(res.headers.get("content-length") || 0);
  if (declaredLength && declaredLength > MAX_BYTES) {
    throw new Error(`Page too large (${declaredLength} bytes; limit ${MAX_BYTES})`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`Page too large (${buf.byteLength} bytes; limit ${MAX_BYTES})`);
  }
  const html = new TextDecoder("utf-8").decode(buf);

  // Plain text needs no extraction — return it as-is rather than letting the
  // HTML parser invent structure that was never in the document.
  if (/text\/plain/.test(contentType)) {
    const text = tidyMarkdown(html);
    return {
      provider: "native",
      url: rawUrl,
      finalUrl: res.url && res.url !== rawUrl ? res.url : undefined,
      title: null,
      description: null,
      markdown: opts.maxChars ? text.slice(0, opts.maxChars) : text,
      textChars: text.length,
      thin: text.length < THIN_TEXT_CHARS,
    };
  }

  const $ = cheerio.load(html);
  const title =
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    null;
  const description =
    $("meta[name='description']").attr("content")?.trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    null;

  $(CHROME_SELECTORS.join(",")).remove();

  // Pick the densest of the candidate containers rather than the first that
  // exists. Sites that wrap everything in <main> AND mark the real article
  // with <article> would otherwise hand back the whole page.
  // First selector that yields a real amount of text wins. Density only breaks
  // ties WITHIN one selector (a page with several <article> elements), never
  // across them — see the note on CONTENT_SELECTORS.
  let container = "";
  for (const sel of CONTENT_SELECTORS) {
    const matches: { html: string; text: number }[] = [];
    $(sel).each((_i, el) => {
      const node = $(el);
      matches.push({
        html: node.html() || "",
        text: node.text().replace(/\s+/g, " ").trim().length,
      });
    });
    const densest = matches.sort((a, b) => b.text - a.text)[0];
    if (densest && densest.text > MIN_CONTAINER_CHARS) {
      container = densest.html;
      break;
    }
  }
  if (!container) container = $("body").html() || "";

  const td = buildTurndown();
  let markdown = tidyMarkdown(td.turndown(container));
  const textChars = markdown
    .replace(/[#*_`>[\]()|-]/g, "")
    .replace(/\s+/g, " ")
    .trim().length;

  if (opts.maxChars && markdown.length > opts.maxChars) {
    markdown = `${markdown.slice(0, opts.maxChars)}\n\n…[truncated]`;
  }

  const thin = textChars < THIN_TEXT_CHARS;
  return {
    provider: "native",
    url: rawUrl,
    finalUrl: res.url && res.url !== rawUrl ? res.url : undefined,
    title,
    description,
    markdown,
    textChars,
    thin,
    note: thin
      ? "The page returned almost no text. It is most likely rendered by JavaScript, which the built-in fetcher does not run — connect Firecrawl on the Integrations page to read pages like this."
      : undefined,
  };
}
