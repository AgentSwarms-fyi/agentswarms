// GitHub connector.
//
// Auth is a personal access token (classic or fine-grained). The datasets
// contain exactly what that token can see, so a read-only token scoped to the
// repositories you want is both possible and the right thing to do.
//
// Streams are per repository, the way Jira's are per project: one dataset of
// issues per repo rather than one enormous table for an organisation, because
// a repo is the unit people actually ask questions about — and because the
// issues endpoint is itself per repo.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://api.github.com";

/** GitHub's maximum for a list page. */
const PAGE_SIZE = 100;

/** Repositories offered as streams. More than this and the picker is a wall. */
const MAX_REPOS = 200;

type GithubCfg = Extract<SaasConfig, { provider: "github" }>;

async function githubFetch(cfg: GithubCfg, url: string): Promise<Response> {
  const res = await connectorFetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.access_token}`,
      Accept: "application/vnd.github+json",
      // Pinned: GitHub changing its default cannot silently change the shape
      // of a synced dataset underneath an existing dashboard.
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentswarms-connector",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error("GitHub: that token was rejected. Check it has not expired or been revoked.");
  }
  if (res.status === 403 || res.status === 404) {
    // 404 is what GitHub returns for a private repo the token cannot see: it
    // refuses to confirm the repo exists. Saying "not found" alone would send
    // somebody hunting for a typo in a name that is correct.
    throw new Error(
      "GitHub: that owner or repository is not visible to this token. For a fine-grained " +
        "token, check it grants Read access to Issues and Metadata on the repositories you want.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  return res;
}

/**
 * The `next` link from GitHub's Link header, or null.
 *
 * GitHub pages with opaque cursors on some endpoints and page numbers on
 * others; following its own link is the only thing that works for both.
 */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

/** `owner/repo` for a stream id, or null if it is not a repo stream. */
export function repoOf(streamId: string): string | null {
  const m = /^issues:(.+)$/.exec(streamId);
  return m ? m[1] : null;
}

export async function listGithubStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as GithubCfg;
  const owner = c.owner
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/.*$/, "");
  if (!owner) throw new Error("GitHub: enter the organisation or user that owns the repositories.");

  // An org and a user need different endpoints, and which one an owner is
  // cannot be assumed. Try the org first and fall back, because asking
  // /users/<org>/repos for an org returns only its PUBLIC repositories —
  // silently omitting the private ones somebody is most likely to want.
  const streams: SaasStream[] = [];
  let url: string | null =
    `${API}/orgs/${encodeURIComponent(owner)}/repos?per_page=${PAGE_SIZE}&sort=updated`;
  let usedOrg = true;
  try {
    await githubFetch(c, url);
  } catch {
    usedOrg = false;
    url = `${API}/users/${encodeURIComponent(owner)}/repos?per_page=${PAGE_SIZE}&sort=updated`;
  }
  void usedOrg;

  while (url && streams.length < MAX_REPOS) {
    const res: Response = await githubFetch(c, url);
    const repos = (await res.json()) as { full_name?: string; archived?: boolean }[];
    if (!Array.isArray(repos) || repos.length === 0) break;
    for (const r of repos) {
      if (!r.full_name) continue;
      streams.push({ id: `issues:${r.full_name}`, label: `Issues — ${r.full_name}` });
      if (streams.length >= MAX_REPOS) break;
    }
    url = nextLink(res.headers.get("link") ?? res.headers.get("Link"));
  }
  if (streams.length === 0) {
    throw new Error(`GitHub: no repositories visible to this token under "${owner}".`);
  }
  return streams;
}

/** Every issue carries `updated_at`, so every repository stream follows. */
export function githubIncremental(streamId: string): IncrementalSpec | null {
  return repoOf(streamId) ? { cursorField: "updated_at", primaryKey: "id", compare: "iso" } : null;
}

export async function* fetchGithubRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const repo = repoOf(streamId);
  if (!repo) throw new Error(`GitHub: unknown stream "${streamId}"`);
  const c = cfg as GithubCfg;

  const first = new URL(`${API}/repos/${repo}/issues`);
  first.searchParams.set("per_page", String(PAGE_SIZE));
  // `state=all`, or GitHub returns only OPEN issues — quietly excluding the
  // closed ones, which is most of any real repository's history.
  first.searchParams.set("state", "all");
  first.searchParams.set("sort", "updated");
  first.searchParams.set("direction", "asc");
  const at = since ? new Date(since) : null;
  if (at && !Number.isNaN(at.getTime())) {
    // `since` is inclusive, so the boundary issue returns and is folded away
    // by its id.
    first.searchParams.set("since", at.toISOString());
  }

  let url: string | null = first.toString();
  while (url) {
    const res: Response = await githubFetch(c, url);
    const issues = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(issues) || issues.length === 0) return;

    for (const raw of issues) {
      // GitHub returns PULL REQUESTS from the issues endpoint — they are
      // issues underneath, and a `pull_request` key is the only thing that
      // distinguishes them. Dropping them would lose data somebody asked for;
      // hiding the difference would make "how many issues" wrong. So the fact
      // is recorded as its own column instead.
      const isPr = "pull_request" in raw;
      yield flattenRecord({ ...raw, is_pull_request: isPr, repository: repo });
    }
    url = nextLink(res.headers.get("link") ?? res.headers.get("Link"));
  }
}
