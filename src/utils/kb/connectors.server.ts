// KB source connectors: Google Drive, Notion, SharePoint (Microsoft Graph),
// Dropbox.
//
// One deliberately small interface so the sync engine treats every provider
// identically:
//
//   listItems  — enumerate remote items with a stable externalId and a cheap
//                change marker (`version`). Listing is the every-sync cost, so
//                it never downloads content.
//   fetchItem  — download one item's text (and its sharing principals when the
//                source mirrors provider ACLs). Called only for items whose
//                `version` changed — the first level of the dedup contract.
//
// Auth is token-based (paste-a-credential), matching the BYOK pattern the rest
// of the app uses. OAuth consent flows need operator-registered apps and are
// NOT implemented; validate() says exactly what to paste instead. Credentials
// arrive decrypted from kb_sources.credentials — the sync engine owns
// encryption, adapters never see storage.
//
// Failure policy: throw with the provider's status + body slice. A connector
// that quietly returns [] turns "credentials revoked" into "source is fine,
// zero documents", which deletes every synced document as remotely-removed.

import {
  extractLinks,
  looksLikePage,
  normalizeUrl,
  parseRobots,
  parseSitemap,
  robotsAllows,
  sameSite,
  validateWebConfig,
  WEB_DEFAULT_MAX_PAGES,
  WEB_MAX_PAGES,
  withinPrefixes,
  type WebConfig,
} from "./webCrawl";

const FETCH_TIMEOUT_MS = 30_000;
/** Per-item text cap — protects the embedding pipeline from a 300MB log file. */
export const MAX_ITEM_CHARS = 400_000;
const MAX_FOLDER_DEPTH = 5;
const MAX_ITEMS_PER_SOURCE = 500;

export type ConnectorKind = "gdrive" | "notion" | "sharepoint" | "dropbox" | "web";

export type RemoteItem = {
  /** Provider's stable id — the dedup key alongside source_id. */
  externalId: string;
  name: string;
  /** Change marker: mtime / revision / provider hash. Differs ⇒ re-fetch. */
  version: string;
  sizeBytes?: number;
};

export type SkippedItem = { name: string; reason: string };

export type ListResult = { items: RemoteItem[]; skipped: SkippedItem[] };

export type FetchResult = {
  text: string;
  /**
   * Lowercased principal entries from the provider's sharing settings:
   * plain emails, "domain:example.com", "*" (public link), "org" (whole
   * tenant). null when the provider doesn't expose ACLs or the credential
   * cannot read them — the caller records that, it must not guess.
   */
  aclPrincipals: string[] | null;
};

export interface KbConnector {
  kind: ConnectorKind;
  label: string;
  /** Whether fetchItem can ever return principals for this provider. */
  supportsAcl: boolean;
  /**
   * True for a source that needs nothing pasted (a public website). The save
   * route and the sync engine relax their credential requirement for these
   * ONLY; every other connector keeps failing loudly on missing credentials.
   */
  credentialless?: boolean;
  /** Human-readable problem with config/credentials, or null when usable. */
  validate(config: Record<string, unknown>, creds: Record<string, string>): string | null;
  listItems(config: Record<string, unknown>, creds: Record<string, string>): Promise<ListResult>;
  fetchItem(
    config: Record<string, unknown>,
    creds: Record<string, string>,
    item: RemoteItem,
    wantAcl: boolean,
  ): Promise<FetchResult>;
}

// ── shared helpers ───────────────────────────────────────────────────────────

async function httpJson<T>(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  provider: string,
): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${provider} ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function httpText(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  provider: string,
): Promise<string> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${provider} ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.text();
}

const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "text",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "rst",
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "sql",
  "sh",
  "toml",
  "ini",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function isTextName(name: string): boolean {
  return TEXT_EXTENSIONS.has(extOf(name));
}

function capText(s: string): string {
  return s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) : s;
}

// ── Google Drive ─────────────────────────────────────────────────────────────
//
// Credentials: { access_token } or { refresh_token, client_id, client_secret }
// (refresh trio preferred — access tokens expire in an hour). Config:
// { folder_id } — required; "root" works for My Drive.

const GOOGLE_EXPORTABLE: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

async function gdriveAccessToken(creds: Record<string, string>): Promise<string> {
  if (creds.refresh_token && creds.client_id && creds.client_secret) {
    const json = await httpJson<{ access_token?: string }>(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: creds.refresh_token,
          client_id: creds.client_id,
          client_secret: creds.client_secret,
        }).toString(),
      },
      "Google OAuth",
    );
    if (!json.access_token) throw new Error("Google OAuth: refresh returned no access_token");
    return json.access_token;
  }
  if (creds.access_token) return creds.access_token;
  throw new Error("Google Drive credentials missing");
}

const gdrive: KbConnector = {
  kind: "gdrive",
  label: "Google Drive",
  supportsAcl: true,
  validate(config, creds) {
    if (!config.folder_id || typeof config.folder_id !== "string") {
      return 'Set a folder ID (the part of the folder URL after /folders/; "root" for My Drive).';
    }
    const hasRefresh = creds.refresh_token && creds.client_id && creds.client_secret;
    if (!hasRefresh && !creds.access_token) {
      return (
        "Paste either an OAuth access token (expires ~1h; fine for a first test) or a " +
        "refresh token + client ID + client secret for unattended scheduled syncs."
      );
    }
    return null;
  },
  async listItems(config, creds) {
    const token = await gdriveAccessToken(creds);
    const auth = { Authorization: `Bearer ${token}` };
    const items: RemoteItem[] = [];
    const skipped: SkippedItem[] = [];
    // Iterative BFS over folders — Drive's q filter is per-parent.
    const queue: Array<{ id: string; depth: number }> = [
      { id: String(config.folder_id), depth: 0 },
    ];
    while (queue.length > 0 && items.length < MAX_ITEMS_PER_SOURCE) {
      const folder = queue.shift()!;
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          q: `'${folder.id.replace(/'/g, "\\'")}' in parents and trashed=false`,
          fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
          pageSize: "200",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const json = await httpJson<{
          nextPageToken?: string;
          files?: Array<{
            id: string;
            name: string;
            mimeType: string;
            modifiedTime?: string;
            size?: string;
          }>;
        }>(
          `https://www.googleapis.com/drive/v3/files?${params}`,
          { headers: auth },
          "Google Drive",
        );
        for (const f of json.files ?? []) {
          if (f.mimeType === "application/vnd.google-apps.folder") {
            if (folder.depth + 1 <= MAX_FOLDER_DEPTH)
              queue.push({ id: f.id, depth: folder.depth + 1 });
            else
              skipped.push({
                name: f.name,
                reason: `folder deeper than ${MAX_FOLDER_DEPTH} levels`,
              });
            continue;
          }
          const exportable = GOOGLE_EXPORTABLE[f.mimeType];
          const texty = f.mimeType.startsWith("text/") || isTextName(f.name);
          if (!exportable && !texty) {
            skipped.push({ name: f.name, reason: `unsupported type ${f.mimeType}` });
            continue;
          }
          items.push({
            externalId: f.id,
            name: f.name,
            version: f.modifiedTime ?? "",
            sizeBytes: f.size ? Number(f.size) : undefined,
          });
          if (items.length >= MAX_ITEMS_PER_SOURCE) break;
        }
        pageToken = json.nextPageToken;
      } while (pageToken && items.length < MAX_ITEMS_PER_SOURCE);
    }
    if (queue.length > 0 || items.length >= MAX_ITEMS_PER_SOURCE) {
      skipped.push({
        name: "(remaining items)",
        reason: `capped at ${MAX_ITEMS_PER_SOURCE} items per source`,
      });
    }
    return { items, skipped };
  },
  async fetchItem(_config, creds, item, wantAcl) {
    const token = await gdriveAccessToken(creds);
    const auth = { Authorization: `Bearer ${token}` };
    // Need the mime type to decide export vs download.
    const meta = await httpJson<{ mimeType: string }>(
      `https://www.googleapis.com/drive/v3/files/${item.externalId}?fields=mimeType&supportsAllDrives=true`,
      { headers: auth },
      "Google Drive",
    );
    const exportMime = GOOGLE_EXPORTABLE[meta.mimeType];
    const url = exportMime
      ? `https://www.googleapis.com/drive/v3/files/${item.externalId}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `https://www.googleapis.com/drive/v3/files/${item.externalId}?alt=media&supportsAllDrives=true`;
    const text = capText(await httpText(url, { headers: auth }, "Google Drive"));

    let aclPrincipals: string[] | null = null;
    if (wantAcl) {
      const perms = await httpJson<{
        permissions?: Array<{ type?: string; emailAddress?: string; domain?: string }>;
      }>(
        `https://www.googleapis.com/drive/v3/files/${item.externalId}/permissions?fields=permissions(type,emailAddress,domain)&supportsAllDrives=true`,
        { headers: auth },
        "Google Drive",
      );
      aclPrincipals = (perms.permissions ?? [])
        .map((p) => {
          if (p.type === "anyone") return "*";
          if (p.type === "domain" && p.domain) return `domain:${p.domain.toLowerCase()}`;
          if (p.emailAddress) return p.emailAddress.toLowerCase();
          return null;
        })
        .filter((s): s is string => Boolean(s));
    }
    return { text, aclPrincipals };
  },
};

// ── Notion ───────────────────────────────────────────────────────────────────
//
// Credentials: { token } — an internal-integration secret (ntn_/secret_…); the
// integration must be added to the pages/databases via Share → Connections.
// Config: { page_ids?: string[]; database_ids?: string[] } — at least one.
// Notion's API does not expose page-level sharing, so supportsAcl=false and a
// 'source_acl' scope on a Notion source falls back to owner-only visibility.

const NOTION_VERSION = "2022-06-28";
const NOTION_BLOCK_DEPTH = 3;
const NOTION_MAX_BLOCKS = 2000;

function notionHeaders(creds: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

type NotionRichText = { plain_text?: string };
type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

function notionBlockText(block: NotionBlock): string {
  const payload = block[block.type] as { rich_text?: NotionRichText[]; title?: string } | undefined;
  if (!payload) return "";
  if (Array.isArray(payload.rich_text)) {
    return payload.rich_text.map((r) => r.plain_text ?? "").join("");
  }
  if (block.type === "child_page" && typeof payload.title === "string") return payload.title;
  return "";
}

async function notionPageText(
  creds: Record<string, string>,
  blockId: string,
  depth: number,
  budget: { blocks: number },
): Promise<string> {
  if (depth > NOTION_BLOCK_DEPTH || budget.blocks <= 0) return "";
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const json = await httpJson<{
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>(
      `https://api.notion.com/v1/blocks/${blockId}/children${params}`,
      { headers: notionHeaders(creds) },
      "Notion",
    );
    for (const block of json.results ?? []) {
      if (budget.blocks-- <= 0) return lines.join("\n");
      const text = notionBlockText(block);
      if (text.trim()) lines.push(text);
      if (block.has_children && block.type !== "child_page" && block.type !== "child_database") {
        const nested = await notionPageText(creds, block.id, depth + 1, budget);
        if (nested.trim()) lines.push(nested);
      }
    }
    cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
  } while (cursor);
  return lines.join("\n");
}

function notionTitleOf(page: {
  properties?: Record<string, { type?: string; title?: NotionRichText[] }>;
}): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      const t = prop.title.map((r) => r.plain_text ?? "").join("");
      if (t.trim()) return t;
    }
  }
  return "Untitled";
}

const notion: KbConnector = {
  kind: "notion",
  label: "Notion",
  supportsAcl: false,
  validate(config, creds) {
    if (!creds.token) {
      return "Paste an internal-integration secret (Settings → Connections → Develop or manage integrations), then share the target pages with that integration.";
    }
    const pages = Array.isArray(config.page_ids) ? config.page_ids : [];
    const dbs = Array.isArray(config.database_ids) ? config.database_ids : [];
    if (pages.length === 0 && dbs.length === 0) {
      return "List at least one page ID or database ID (the 32-char id from the page URL).";
    }
    return null;
  },
  async listItems(config, creds) {
    const items: RemoteItem[] = [];
    const skipped: SkippedItem[] = [];
    const pageIds = (Array.isArray(config.page_ids) ? config.page_ids : []).map(String);
    const dbIds = (Array.isArray(config.database_ids) ? config.database_ids : []).map(String);

    for (const id of pageIds) {
      const page = await httpJson<{
        id: string;
        last_edited_time?: string;
        properties?: Record<string, { type?: string; title?: NotionRichText[] }>;
      }>(`https://api.notion.com/v1/pages/${id}`, { headers: notionHeaders(creds) }, "Notion");
      items.push({
        externalId: page.id,
        name: notionTitleOf(page),
        version: page.last_edited_time ?? "",
      });
    }
    for (const dbId of dbIds) {
      let cursor: string | undefined;
      do {
        const json = await httpJson<{
          results?: Array<{
            id: string;
            last_edited_time?: string;
            properties?: Record<string, { type?: string; title?: NotionRichText[] }>;
          }>;
          has_more?: boolean;
          next_cursor?: string | null;
        }>(
          `https://api.notion.com/v1/databases/${dbId}/query`,
          {
            method: "POST",
            headers: notionHeaders(creds),
            body: JSON.stringify(
              cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 },
            ),
          },
          "Notion",
        );
        for (const page of json.results ?? []) {
          items.push({
            externalId: page.id,
            name: notionTitleOf(page),
            version: page.last_edited_time ?? "",
          });
          if (items.length >= MAX_ITEMS_PER_SOURCE) break;
        }
        cursor =
          json.has_more && json.next_cursor && items.length < MAX_ITEMS_PER_SOURCE
            ? json.next_cursor
            : undefined;
      } while (cursor);
      if (items.length >= MAX_ITEMS_PER_SOURCE) {
        skipped.push({
          name: "(remaining items)",
          reason: `capped at ${MAX_ITEMS_PER_SOURCE} items per source`,
        });
        break;
      }
    }
    return { items, skipped };
  },
  async fetchItem(_config, creds, item) {
    const text = capText(
      await notionPageText(creds, item.externalId, 0, { blocks: NOTION_MAX_BLOCKS }),
    );
    return { text, aclPrincipals: null };
  },
};

// ── SharePoint (Microsoft Graph, client credentials) ─────────────────────────
//
// Credentials: { tenant_id, client_id, client_secret } — an Entra app
// registration with application permission Files.Read.All (+ Sites.Read.All),
// admin-consented. Config: { site_id?, drive_id?, folder_path? } — drive_id
// wins; otherwise site_id's default document library.

async function graphToken(creds: Record<string, string>): Promise<string> {
  const json = await httpJson<{ access_token?: string }>(
    `https://login.microsoftonline.com/${creds.tenant_id}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    },
    "Microsoft login",
  );
  if (!json.access_token) throw new Error("Microsoft login returned no access_token");
  return json.access_token;
}

async function graphDriveId(
  config: Record<string, unknown>,
  auth: Record<string, string>,
): Promise<string> {
  if (typeof config.drive_id === "string" && config.drive_id) return config.drive_id;
  const site = String(config.site_id ?? "");
  const json = await httpJson<{ id?: string }>(
    `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(site)}/drive?$select=id`,
    { headers: auth },
    "SharePoint",
  );
  if (!json.id) throw new Error("SharePoint: site has no default document library");
  return json.id;
}

type GraphItem = {
  id: string;
  name: string;
  lastModifiedDateTime?: string;
  size?: number;
  folder?: unknown;
  file?: { hashes?: { quickXorHash?: string } };
};

const sharepoint: KbConnector = {
  kind: "sharepoint",
  label: "SharePoint",
  supportsAcl: true,
  validate(config, creds) {
    if (!creds.tenant_id || !creds.client_id || !creds.client_secret) {
      return "Provide tenant ID, client ID and client secret from an Entra app registration with admin-consented Files.Read.All application permission.";
    }
    if (!config.site_id && !config.drive_id) {
      return "Set a site ID (Graph format: host,siteCollectionId,siteId) or a drive ID.";
    }
    return null;
  },
  async listItems(config, creds) {
    const token = await graphToken(creds);
    const auth = { Authorization: `Bearer ${token}` };
    const driveId = await graphDriveId(config, auth);
    const folderPath =
      typeof config.folder_path === "string" ? config.folder_path.replace(/^\/+|\/+$/g, "") : "";
    const rootUrl = folderPath
      ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(folderPath)}:/children`
      : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`;

    const items: RemoteItem[] = [];
    const skipped: SkippedItem[] = [];
    const queue: Array<{ url: string; depth: number }> = [{ url: `${rootUrl}?$top=200`, depth: 0 }];
    while (queue.length > 0 && items.length < MAX_ITEMS_PER_SOURCE) {
      const { url, depth } = queue.shift()!;
      let next: string | undefined = url;
      while (next && items.length < MAX_ITEMS_PER_SOURCE) {
        const json: { value?: GraphItem[]; "@odata.nextLink"?: string } = await httpJson(
          next,
          { headers: auth },
          "SharePoint",
        );
        for (const it of json.value ?? []) {
          if (it.folder !== undefined) {
            if (depth + 1 <= MAX_FOLDER_DEPTH) {
              queue.push({
                url: `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${it.id}/children?$top=200`,
                depth: depth + 1,
              });
            } else {
              skipped.push({
                name: it.name,
                reason: `folder deeper than ${MAX_FOLDER_DEPTH} levels`,
              });
            }
            continue;
          }
          if (!isTextName(it.name)) {
            skipped.push({ name: it.name, reason: `unsupported type .${extOf(it.name) || "?"}` });
            continue;
          }
          items.push({
            externalId: it.id,
            name: it.name,
            version: it.file?.hashes?.quickXorHash || it.lastModifiedDateTime || "",
            sizeBytes: it.size,
          });
          if (items.length >= MAX_ITEMS_PER_SOURCE) break;
        }
        next = json["@odata.nextLink"];
      }
    }
    if (queue.length > 0 || items.length >= MAX_ITEMS_PER_SOURCE) {
      skipped.push({
        name: "(remaining items)",
        reason: `capped at ${MAX_ITEMS_PER_SOURCE} items per source`,
      });
    }
    return { items, skipped };
  },
  async fetchItem(config, creds, item, wantAcl) {
    const token = await graphToken(creds);
    const auth = { Authorization: `Bearer ${token}` };
    const driveId = await graphDriveId(config, auth);
    const text = capText(
      await httpText(
        `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${item.externalId}/content`,
        { headers: auth },
        "SharePoint",
      ),
    );
    let aclPrincipals: string[] | null = null;
    if (wantAcl) {
      const json = await httpJson<{
        value?: Array<{
          link?: { scope?: string };
          grantedToV2?: { user?: { email?: string } };
          grantedToIdentitiesV2?: Array<{ user?: { email?: string } }>;
        }>;
      }>(
        `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${item.externalId}/permissions`,
        { headers: auth },
        "SharePoint",
      );
      const out = new Set<string>();
      for (const perm of json.value ?? []) {
        if (perm.link?.scope === "anonymous") out.add("*");
        if (perm.link?.scope === "organization") out.add("org");
        const direct = perm.grantedToV2?.user?.email;
        if (direct) out.add(direct.toLowerCase());
        for (const g of perm.grantedToIdentitiesV2 ?? []) {
          if (g.user?.email) out.add(g.user.email.toLowerCase());
        }
      }
      aclPrincipals = Array.from(out);
    }
    return { text, aclPrincipals };
  },
};

// ── Dropbox ──────────────────────────────────────────────────────────────────
//
// Credentials: { access_token } or { refresh_token, app_key, app_secret }.
// Config: { path? } — folder path ("" = whole Dropbox). Dropbox supplies a
// native content_hash per file, which makes its change detection exact.

async function dropboxAccessToken(creds: Record<string, string>): Promise<string> {
  if (creds.refresh_token && creds.app_key && creds.app_secret) {
    const json = await httpJson<{ access_token?: string }>(
      "https://api.dropboxapi.com/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: creds.refresh_token,
          client_id: creds.app_key,
          client_secret: creds.app_secret,
        }).toString(),
      },
      "Dropbox OAuth",
    );
    if (!json.access_token) throw new Error("Dropbox OAuth: refresh returned no access_token");
    return json.access_token;
  }
  if (creds.access_token) return creds.access_token;
  throw new Error("Dropbox credentials missing");
}

type DropboxEntry = {
  ".tag": "file" | "folder" | string;
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  server_modified?: string;
  content_hash?: string;
  size?: number;
};

const dropbox: KbConnector = {
  kind: "dropbox",
  label: "Dropbox",
  supportsAcl: true,
  validate(config, creds) {
    const hasRefresh = creds.refresh_token && creds.app_key && creds.app_secret;
    if (!hasRefresh && !creds.access_token) {
      return "Paste an access token (App Console → Generate), or a refresh token + app key + app secret for unattended scheduled syncs.";
    }
    if (config.path !== undefined && typeof config.path !== "string") {
      return "Folder path must be a string like /Team/Docs (empty for the whole Dropbox).";
    }
    return null;
  },
  async listItems(config, creds) {
    const token = await dropboxAccessToken(creds);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const items: RemoteItem[] = [];
    const skipped: SkippedItem[] = [];
    let body: string | null = JSON.stringify({
      path: typeof config.path === "string" ? config.path : "",
      recursive: true,
      limit: 500,
    });
    let url = "https://api.dropboxapi.com/2/files/list_folder";
    for (;;) {
      const json: { entries?: DropboxEntry[]; cursor?: string; has_more?: boolean } =
        await httpJson(url, { method: "POST", headers, body: body! }, "Dropbox");
      for (const e of json.entries ?? []) {
        if (e[".tag"] !== "file") continue;
        if (!isTextName(e.name)) {
          skipped.push({ name: e.name, reason: `unsupported type .${extOf(e.name) || "?"}` });
          continue;
        }
        items.push({
          externalId: e.id,
          name: e.name,
          // Native content hash — exact change detection, no mtime noise.
          version: e.content_hash || e.server_modified || "",
          sizeBytes: e.size,
        });
        if (items.length >= MAX_ITEMS_PER_SOURCE) break;
      }
      if (!json.has_more || items.length >= MAX_ITEMS_PER_SOURCE) {
        if (json.has_more) {
          skipped.push({
            name: "(remaining items)",
            reason: `capped at ${MAX_ITEMS_PER_SOURCE} items per source`,
          });
        }
        break;
      }
      url = "https://api.dropboxapi.com/2/files/list_folder/continue";
      body = JSON.stringify({ cursor: json.cursor });
    }
    return { items, skipped };
  },
  async fetchItem(_config, creds, item, wantAcl) {
    const token = await dropboxAccessToken(creds);
    const text = capText(
      await httpText(
        "https://content.dropboxapi.com/2/files/download",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Dropbox-API-Arg": JSON.stringify({ path: item.externalId }),
          },
        },
        "Dropbox",
      ),
    );
    let aclPrincipals: string[] | null = null;
    if (wantAcl) {
      // Sharing info needs sharing.read scope and a plan that supports it.
      // Failure here is recorded as "ACL unavailable", not invented.
      try {
        const json = await httpJson<{
          users?: Array<{ user?: { email?: string } }>;
          invitees?: Array<{ invitee?: { ".tag"?: string; email?: string } }>;
        }>(
          "https://api.dropboxapi.com/2/sharing/list_file_members",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ file: item.externalId }),
          },
          "Dropbox",
        );
        const out = new Set<string>();
        for (const u of json.users ?? []) if (u.user?.email) out.add(u.user.email.toLowerCase());
        for (const i of json.invitees ?? [])
          if (i.invitee?.email) out.add(i.invitee.email.toLowerCase());
        aclPrincipals = Array.from(out);
      } catch {
        aclPrincipals = null;
      }
    }
    return { text, aclPrincipals };
  },
};

// ── registry ─────────────────────────────────────────────────────────────────

// ── Web (crawl) ──────────────────────────────────────────────────────────────
//
// The platform could ingest ONE page (kind=url). It could not index a docs
// site: a hundred pages discovered from a sitemap or by following same-site
// links, re-checked on a schedule so a changed page is re-embedded and a
// removed one dropped. That is the most common "connect my knowledge" request
// there is, and it needs no credential -- which no connector allowed for.
//
// Two rules are load-bearing and live in webCrawl.ts where they are testable
// without a network: never leave the site the user named, and obey robots.txt.
// A crawler that ignores either is one a site eventually blocks at the
// firewall, taking the whole platform's egress reputation with it.
//
// Every fetch goes through safeFetch, the same SSRF guard as url ingestion. A
// public page that redirects to a link-local address is exactly the case that
// guard exists for, and a crawl follows more links than any other feature.
const WEB_FETCH_TIMEOUT_MS = 20_000;

const WEB_USER_AGENT =
  "Mozilla/5.0 (compatible; AgentSwarms/1.0; +https://github.com/AgentSwarms-fyi/agentswarms)";

async function webGet(url: string): Promise<{ status: number; text: string; etag: string }> {
  const { safeFetch } = await import("@/utils/ssrfGuard.server");
  const res = await safeFetch(url, {
    signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    headers: { "User-Agent": WEB_USER_AGENT, Accept: "text/html,application/xml;q=0.9,*/*;q=0.5" },
  });
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const etag = res.headers.get("etag") || res.headers.get("last-modified") || "";
  if (!res.ok) return { status: res.status, text: "", etag };
  if (!/text\/html|application\/xhtml|xml|text\/plain/.test(type)) {
    return { status: 415, text: "", etag };
  }
  return { status: res.status, text: await res.text(), etag };
}

const web: KbConnector = {
  kind: "web",
  label: "Website",
  supportsAcl: false,
  credentialless: true,
  validate(config) {
    return validateWebConfig(config);
  },
  async listItems(config) {
    const cfg = config as unknown as WebConfig;
    const cap = Math.min(Number(cfg.max_pages) || WEB_DEFAULT_MAX_PAGES, WEB_MAX_PAGES);
    const origin = normalizeUrl(cfg.start_urls[0])!;
    const items: RemoteItem[] = [];
    const skipped: SkippedItem[] = [];
    const seen = new Set<string>();

    // robots.txt first. A missing one allows everything; an unreadable one is
    // treated the same way -- but a present one is obeyed.
    let disallow: string[] = [];
    try {
      const r = await webGet(new URL("/robots.txt", origin).toString());
      if (r.status === 200) disallow = parseRobots(r.text);
    } catch {
      /* no robots.txt is the common case */
    }

    const admit = (url: string, why: string): boolean => {
      if (seen.has(url)) return false;
      seen.add(url);
      if (!sameSite(url, origin)) return false; // off-site links are normal, not skips
      if (!looksLikePage(url)) return false;
      if (!withinPrefixes(url, cfg.path_prefixes)) return false;
      if (!robotsAllows(url, disallow)) {
        skipped.push({ name: url, reason: `disallowed by robots.txt (${why})` });
        return false;
      }
      return true;
    };

    // Sitemap: the cheap path. lastmod is the change marker, so an unchanged
    // page costs one line of XML per sync rather than a download.
    const sitemapUrl = cfg.sitemap_url
      ? normalizeUrl(cfg.sitemap_url)
      : new URL("/sitemap.xml", origin).toString();
    const sitemapQueue = sitemapUrl ? [sitemapUrl] : [];
    const fromSitemap = new Map<string, string | undefined>();
    for (let i = 0; i < sitemapQueue.length && i < 20; i++) {
      try {
        const r = await webGet(sitemapQueue[i]);
        if (r.status !== 200) continue;
        const { pages, sitemaps } = parseSitemap(r.text);
        for (const s of sitemaps) {
          if (!sitemapQueue.includes(s) && sameSite(s, origin)) sitemapQueue.push(s);
        }
        for (const p of pages) if (!fromSitemap.has(p.url)) fromSitemap.set(p.url, p.lastmod);
      } catch {
        /* an explicit sitemap that fails is reported below; a guessed one is not */
      }
    }
    if (cfg.sitemap_url && fromSitemap.size === 0) {
      throw new Error(`Website: the sitemap at ${cfg.sitemap_url} returned no pages`);
    }

    for (const [url, lastmod] of fromSitemap) {
      if (items.length >= cap) break;
      if (!admit(url, "sitemap")) continue;
      items.push({ externalId: url, name: url, version: lastmod || "sitemap:no-lastmod" });
    }

    // Crawl: breadth-first from the start URLs, same site only -- and only
    // when the sitemap gave nothing. A site with a sitemap has told us its
    // pages; crawling on top of it mostly finds navigation chrome.
    if (fromSitemap.size === 0) {
      const { createHash } = await import("node:crypto");
      const queue = cfg.start_urls.map((u) => normalizeUrl(u)).filter((u): u is string => !!u);
      for (let i = 0; i < queue.length && items.length < cap; i++) {
        const url = queue[i];
        if (!admit(url, "crawl")) continue;
        let page: { status: number; text: string; etag: string };
        try {
          page = await webGet(url);
        } catch (e) {
          skipped.push({ name: url, reason: (e as Error).message.slice(0, 120) });
          continue;
        }
        if (page.status !== 200) {
          skipped.push({ name: url, reason: `HTTP ${page.status}` });
          continue;
        }
        // The change marker is the server's own (ETag / Last-Modified) when it
        // offers one, else a hash of the HTML. A marker that never changes
        // hides every edit for ever; one that always changes re-embeds the
        // whole site every sync.
        const version =
          page.etag || createHash("sha256").update(page.text).digest("hex").slice(0, 16);
        items.push({ externalId: url, name: url, version, sizeBytes: page.text.length });
        for (const link of extractLinks(page.text, url)) if (!seen.has(link)) queue.push(link);
      }
    }

    if (items.length >= cap) {
      skipped.push({ name: "(remaining pages)", reason: `capped at ${cap} pages per source` });
    }
    if (items.length === 0) {
      // Loud, per the failure policy at the top of this file: an empty listing
      // would delete every previously synced page as "removed from the site".
      throw new Error(
        "Website: no pages could be listed. Check the start URL is reachable, is not blocked by robots.txt, and is server-rendered (a JavaScript-only site has no links in its HTML).",
      );
    }
    return { items, skipped };
  },
  async fetchItem(_config, _creds, item) {
    const { nativeScrape } = await import("@/utils/nativeScrape.server");
    const r = await nativeScrape(item.externalId, { maxChars: MAX_ITEM_CHARS });
    const title = r.title ? `# ${r.title}\n\n` : "";
    const note = r.thin
      ? "\n\n_(This page returned very little text -- it may render its content with JavaScript.)_"
      : "";
    return { text: capText(`${title}${r.markdown}${note}`), aclPrincipals: null };
  },
};

export const KB_CONNECTORS: Record<ConnectorKind, KbConnector> = {
  gdrive,
  notion,
  sharepoint,
  dropbox,
  web,
};

export function isConnectorKind(kind: string): kind is ConnectorKind {
  return kind in KB_CONNECTORS;
}
