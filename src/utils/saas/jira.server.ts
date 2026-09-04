// Jira Cloud connector: issues per project, as datasets.
//
// AUTH IS EMAIL + API TOKEN, NOT OAUTH. Jira's OAuth 2.0 (3LO) needs a public
// redirect URL that a self-hosted deployment behind a firewall cannot offer,
// and an app registration the operator has to do either way. An API token is
// created at id.atlassian.com, pasted once, and carries exactly the user's own
// permissions — a read-only account gives a read-only dataset.
//
// One stream per project: "issues:<KEY>". A team's questions ("what is open
// for ENG this sprint?", "how long do P1s take to close?") are almost always
// scoped to a project, and a project is the unit Jira permissions are granted
// at, so a token that cannot see a project fails on that stream alone rather
// than poisoning the whole sync.
import { flattenRecord } from "./flatten";
import type { SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

/** Jira's maximum for a search page. */
const PAGE_SIZE = 100;

type JiraCfg = Extract<SaasConfig, { provider: "jira" }>;

/** The fields worth a column. Everything else on an issue is UI chrome. */
const FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "created",
  "updated",
  "resolutiondate",
  "labels",
  "project",
  "parent",
  "duedate",
];

function siteRoot(cfg: JiraCfg): string {
  const u = new URL(cfg.site_url);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

async function jiraFetch<T>(cfg: JiraCfg, path: string, params: URLSearchParams): Promise<T> {
  const url = `${siteRoot(cfg)}${path}${params.toString() ? `?${params}` : ""}`;
  const res = await connectorFetch(
    url,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.api_token}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    },
    { label: "Jira" },
  );
  if (res.status === 401) {
    throw new Error(
      "Jira: the email or API token was rejected (id.atlassian.com → Security → API tokens).",
    );
  }
  if (res.status === 403) {
    throw new Error(
      "Jira: that account cannot browse this project — check its project permissions.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

type ProjectPage = {
  values?: { key?: string; name?: string }[];
  isLast?: boolean;
  nextPage?: string;
};

export async function listJiraStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as JiraCfg;
  const wanted = (c.project_keys ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const streams: SaasStream[] = [];
  let startAt = 0;
  for (;;) {
    // Also the cheapest authenticated call, so a bad token fails at setup.
    const page = await jiraFetch<ProjectPage>(
      c,
      "/rest/api/3/project/search",
      new URLSearchParams({ startAt: String(startAt), maxResults: "50" }),
    );
    for (const p of page.values ?? []) {
      if (!p.key) continue;
      if (wanted.length > 0 && !wanted.includes(p.key.toUpperCase())) continue;
      streams.push({ id: `issues:${p.key}`, label: `${p.name ?? p.key} issues (${p.key})` });
    }
    if (page.isLast !== false || (page.values ?? []).length === 0) break;
    startAt += 50;
  }
  if (streams.length === 0) {
    throw new Error(
      wanted.length > 0
        ? `Jira: none of the project keys (${wanted.join(", ")}) is visible to this account.`
        : "Jira: this account can see no projects.",
    );
  }
  return streams;
}

type Issue = {
  id?: string;
  key?: string;
  fields?: Record<string, unknown>;
};
type SearchPage = { issues?: Issue[]; startAt?: number; total?: number };

/** A named object's display name, else the raw value. */
function nameOf(v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return o.displayName ?? o.name ?? o.key ?? o.emailAddress ?? v;
  }
  return v;
}

export async function* fetchJiraRows(
  cfg: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const c = cfg as JiraCfg;
  const m = /^issues:([A-Za-z0-9_]+)$/.exec(streamId);
  if (!m) throw new Error(`Jira: unknown stream "${streamId}"`);
  const key = m[1];
  let startAt = 0;
  for (;;) {
    const page = await jiraFetch<SearchPage>(
      c,
      "/rest/api/3/search",
      new URLSearchParams({
        jql: `project = "${key}" ORDER BY updated DESC`,
        startAt: String(startAt),
        maxResults: String(PAGE_SIZE),
        fields: FIELDS.join(","),
      }),
    );
    const issues = page.issues ?? [];
    if (issues.length === 0) return;
    for (const i of issues) {
      const f = i.fields ?? {};
      yield flattenRecord({
        id: i.id ?? null,
        key: i.key ?? null,
        summary: f.summary ?? null,
        status: nameOf(f.status),
        issue_type: nameOf(f.issuetype),
        priority: nameOf(f.priority),
        assignee: nameOf(f.assignee),
        reporter: nameOf(f.reporter),
        project: nameOf(f.project),
        parent: (f.parent as { key?: string } | undefined)?.key ?? null,
        labels: f.labels ?? [],
        created: f.created ?? null,
        updated: f.updated ?? null,
        resolved: f.resolutiondate ?? null,
        due: f.duedate ?? null,
      });
    }
    startAt += issues.length;
    // `total` is Jira's own count; a short page also ends it, which saves the
    // wasted request on an exact multiple of the page size.
    if (issues.length < PAGE_SIZE || (typeof page.total === "number" && startAt >= page.total)) {
      return;
    }
  }
}
