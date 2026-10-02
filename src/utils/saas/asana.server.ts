// Asana connector.
//
// Auth is a personal access token from Settings → Apps → Developer apps.
//
// Streams are per project, the way Jira's are per project and GitHub's are per
// repository — because Asana's task endpoint is itself scoped to one, and
// because a project is the unit people ask questions about.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://app.asana.com/api/1.0";

/** Asana's maximum page. */
const PAGE_SIZE = 100;

/** Projects offered as streams. More than this and the picker is a wall. */
const MAX_PROJECTS = 200;

/**
 * The fields asked for on a task.
 *
 * Without `opt_fields` Asana returns the gid and the name and nothing else —
 * a dataset of two columns that looks like it worked.
 */
const TASK_FIELDS = [
  "gid",
  "name",
  "notes",
  "completed",
  "completed_at",
  "created_at",
  "modified_at",
  "due_on",
  "due_at",
  "start_on",
  "assignee.name",
  "assignee.email",
  "projects.name",
  "parent.name",
  "tags.name",
  "num_subtasks",
  "resource_subtype",
].join(",");

type AsanaCfg = Extract<SaasConfig, { provider: "asana" }>;

type AsanaPage<T> = {
  data?: T[];
  next_page?: { offset?: string } | null;
  errors?: { message?: string }[];
};

async function asanaFetch<T>(
  cfg: AsanaCfg,
  path: string,
  params: URLSearchParams,
): Promise<AsanaPage<T>> {
  const res = await connectorFetch(`${API}${path}?${params}`, {
    headers: { Authorization: `Bearer ${cfg.access_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    throw new Error("Asana: that token was rejected. Check it has not been revoked.");
  }
  if (res.status === 403) {
    throw new Error(
      "Asana: this token cannot see that workspace or project. A personal access token " +
        "sees exactly what its owner sees.",
    );
  }
  const body = (await res.json().catch(() => ({}))) as AsanaPage<T>;
  if (!res.ok) {
    throw new Error(
      `Asana: ${body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`}`,
    );
  }
  return body;
}

/** `<project gid>` for a stream id, or null if it is not a task stream. */
export function projectOf(streamId: string): string | null {
  const m = /^tasks:(\d+)$/.exec(streamId);
  return m ? m[1] : null;
}

export async function listAsanaStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  const c = cfg as AsanaCfg;

  // A workspace is required to list projects, and most people have exactly
  // one. Asking for it in the form would be a gid nobody knows by heart, so
  // it is discovered — and honoured when it IS given, because an agency with
  // a workspace per client needs to choose.
  let workspaces: string[] = [];
  if (c.workspace_gid?.trim()) {
    workspaces = [c.workspace_gid.trim()];
  } else {
    const page = await asanaFetch<{ gid?: string }>(
      c,
      "/workspaces",
      new URLSearchParams({ limit: "100" }),
    );
    workspaces = (page.data ?? []).map((w) => String(w.gid)).filter(Boolean);
    if (workspaces.length === 0) throw new Error("Asana: this token sees no workspaces.");
  }

  const streams: SaasStream[] = [];
  for (const workspace of workspaces) {
    let offset: string | undefined;
    do {
      const page = await asanaFetch<{ gid?: string; name?: string; archived?: boolean }>(
        c,
        "/projects",
        new URLSearchParams({
          workspace,
          limit: String(PAGE_SIZE),
          opt_fields: "name,archived",
          ...(offset ? { offset } : {}),
        }),
      );
      for (const p of page.data ?? []) {
        // Archived projects are finished work nobody is asking questions
        // about, and including them makes the picker twice as long.
        if (!p.gid || p.archived) continue;
        streams.push({ id: `tasks:${p.gid}`, label: `Tasks — ${p.name ?? p.gid}` });
        if (streams.length >= MAX_PROJECTS) return streams;
      }
      offset = page.next_page?.offset ?? undefined;
    } while (offset);
  }
  if (streams.length === 0) throw new Error("Asana: no active projects visible to this token.");
  return streams;
}

/** Every task carries `modified_at`, so every project stream follows. */
export function asanaIncremental(streamId: string): IncrementalSpec | null {
  return projectOf(streamId)
    ? { cursorField: "modified_at", primaryKey: "gid", compare: "iso" }
    : null;
}

export async function* fetchAsanaRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const project = projectOf(streamId);
  if (!project) throw new Error(`Asana: unknown stream "${streamId}"`);
  const c = cfg as AsanaCfg;

  const at = since ? new Date(since) : null;
  let offset: string | undefined;
  do {
    const page = await asanaFetch<Record<string, unknown>>(
      c,
      "/tasks",
      new URLSearchParams({
        project,
        limit: String(PAGE_SIZE),
        opt_fields: TASK_FIELDS,
        // `modified_since` is EXCLUSIVE in Asana, unlike most of the APIs
        // here. That is safe rather than lossy: the record that set the mark
        // has already been synced, and asking for it again would return the
        // same single task for ever when nothing else has changed.
        ...(at && !Number.isNaN(at.getTime()) ? { modified_since: at.toISOString() } : {}),
        ...(offset ? { offset } : {}),
      }),
    );
    const rows = page.data ?? [];
    if (rows.length === 0) return;
    for (const r of rows) yield flattenRecord({ ...r, project_gid: project });
    // Asana's own cursor. Its absence is the end — a short page is not, since
    // Asana may return fewer than the limit and still have more.
    offset = page.next_page?.offset ?? undefined;
  } while (offset);
}
