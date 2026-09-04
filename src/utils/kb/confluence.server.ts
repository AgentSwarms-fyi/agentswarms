// Confluence as a knowledge-base source: Cloud and Data Center.
//
// The enterprise wiki. Drive, Notion, SharePoint and Dropbox were connected;
// the place most companies actually keep their runbooks, ADRs and policies
// was not. Two deployments, one connector:
//
//   CLOUD        https://<site>.atlassian.net  -> API under /wiki, auth is
//                Basic(email:API token). Detected by the host.
//   DATA CENTER  any other base URL            -> API under /rest, auth is a
//                Bearer personal access token.
//
// Both speak the v1 content API, which is why it is used here rather than
// Cloud's newer v2: one code path, and v1 is still served by Cloud. Pages are
// listed per space with `version.number` as the change marker -- a page that
// was not edited costs one line of a listing per sync, never a download.
//
// Every request goes through connectorFetch: an enterprise Confluence is the
// connector most likely to sit behind an egress proxy.
//
// Failure policy is the file-wide one: throw with status and body, never
// return [] on a bad token, because an empty listing deletes every synced
// document as remotely-removed.
import * as cheerio from "cheerio";

import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Pages per space per listing page; Confluence's own ceiling is 100-250. */
const PAGE_SIZE = 100;

export type ConfluenceCreds = { token: string; email?: string };
export type ConfluenceConfig = { site_url: string; space_keys: string[] };

/** Cloud sites live on atlassian.net and mount the API under /wiki. */
export function isConfluenceCloud(siteUrl: string): boolean {
  try {
    return /(^|\.)atlassian\.net$/i.test(new URL(siteUrl).hostname);
  } catch {
    return false;
  }
}

/** The REST base for either deployment, with no trailing slash. */
export function confluenceApiBase(siteUrl: string): string {
  const u = new URL(siteUrl);
  const root = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return isConfluenceCloud(siteUrl) ? `${root}/wiki/rest/api` : `${root}/rest/api`;
}

/** Basic for Cloud (email + API token), Bearer for a Data Center PAT. */
export function confluenceAuthHeader(siteUrl: string, creds: ConfluenceCreds): string {
  if (isConfluenceCloud(siteUrl)) {
    if (!creds.email)
      throw new Error("Confluence Cloud needs the account email beside the API token");
    return `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString("base64")}`;
  }
  return `Bearer ${creds.token}`;
}

export function validateConfluence(
  config: Record<string, unknown>,
  creds: Record<string, string>,
): string | null {
  const site = typeof config.site_url === "string" ? config.site_url : "";
  try {
    const u = new URL(site);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    return "Enter the site URL, e.g. https://acme.atlassian.net or https://confluence.example.com";
  }
  if (!creds.token) {
    return isConfluenceCloud(site)
      ? "Paste an API token (id.atlassian.com → Security → API tokens) and the email it belongs to."
      : "Paste a personal access token (Profile → Personal Access Tokens).";
  }
  if (isConfluenceCloud(site) && !creds.email) {
    return "Confluence Cloud authenticates with email + API token — add the account email.";
  }
  const spaces = Array.isArray(config.space_keys) ? config.space_keys : [];
  if (
    spaces.length === 0 ||
    spaces.some((s) => typeof s !== "string" || !/^[A-Za-z0-9~_-]+$/.test(s))
  ) {
    return "List at least one space key (the short code in the space URL, e.g. ENG).";
  }
  return null;
}

/**
 * Storage-format HTML to readable text. Confluence macros (`ac:structured-
 * macro`) wrap code blocks, panels and tables of contents; their plain-text
 * bodies are kept, their parameters dropped, and the rest is ordinary HTML.
 * Exported for tests.
 */
export function storageHtmlToText(html: string): string {
  // Code macros carry their body as CDATA. An HTML parser treats CDATA
  // outside foreign content as a bogus comment and drops it -- which would
  // silently lose every code block on a runbook page, the part people search
  // for. Unwrap it first, escaping so `<` inside code is text, not markup.
  const unwrapped = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, body: string) =>
    body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
  const $ = cheerio.load(unwrapped, { xml: false });
  $("ac\\:parameter, ri\\:page, ri\\:attachment, script, style").remove();
  // Keep block structure readable once flattened.
  $("p, div, li, h1, h2, h3, h4, h5, h6, tr, br, ac\\:structured-macro").each((_, el) => {
    $(el).append("\n");
  });
  $("td, th").each((_, el) => {
    $(el).append("\t");
  });
  return $.root()
    .text()
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function api<T>(
  siteUrl: string,
  creds: ConfluenceCreds,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${confluenceApiBase(siteUrl)}${path}${qs ? `?${qs}` : ""}`;
  const res = await connectorFetch(
    url,
    {
      headers: { Authorization: confluenceAuthHeader(siteUrl, creds), Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    },
    { label: "Confluence" },
  );
  if (res.status === 401) {
    throw new Error(
      isConfluenceCloud(siteUrl)
        ? "Confluence 401: the API token or email was rejected."
        : "Confluence 401: the personal access token was rejected.",
    );
  }
  if (res.status === 403 || res.status === 404) {
    // 404 is what Confluence returns for a space the token cannot see, so it
    // is a permissions message, not a typo message.
    throw new Error(
      `Confluence ${res.status}: the token cannot see that space (check the space key and that the account has view permission).`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Confluence ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

type ContentPage = {
  id: string;
  title?: string;
  version?: { number?: number };
  body?: { storage?: { value?: string } };
};
type ContentList = { results?: ContentPage[]; size?: number; _links?: { next?: string } };

export type ConfluenceItem = { externalId: string; name: string; version: string };

/** Every page in the configured spaces, capped by the caller. */
export async function listConfluencePages(
  config: ConfluenceConfig,
  creds: ConfluenceCreds,
  cap: number,
): Promise<{ items: ConfluenceItem[]; truncated: boolean }> {
  const items: ConfluenceItem[] = [];
  for (const space of config.space_keys) {
    for (let start = 0; items.length < cap; start += PAGE_SIZE) {
      const page = await api<ContentList>(config.site_url, creds, "/content", {
        spaceKey: space,
        type: "page",
        status: "current",
        limit: String(PAGE_SIZE),
        start: String(start),
        expand: "version",
      });
      const results = page.results ?? [];
      for (const p of results) {
        items.push({
          externalId: p.id,
          name: p.title || p.id,
          version: String(p.version?.number ?? ""),
        });
        if (items.length >= cap) break;
      }
      if (results.length < PAGE_SIZE) break;
    }
    if (items.length >= cap) return { items, truncated: true };
  }
  return { items, truncated: false };
}

/** One page's body as text, with its title as a heading. */
export async function fetchConfluencePage(
  config: ConfluenceConfig,
  creds: ConfluenceCreds,
  id: string,
): Promise<string> {
  const p = await api<ContentPage>(config.site_url, creds, `/content/${encodeURIComponent(id)}`, {
    expand: "body.storage,version",
  });
  const body = storageHtmlToText(p.body?.storage?.value ?? "");
  return p.title ? `# ${p.title}\n\n${body}` : body;
}
