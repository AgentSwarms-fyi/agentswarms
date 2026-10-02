// Linear connector (GraphQL).
//
// Auth is a personal API key from Settings → Security & access → API keys.
// Linear sends it as the bare `Authorization` header with no `Bearer` prefix,
// which is unusual enough to be the first thing anybody gets wrong.
//
// GraphQL rather than REST because Linear has no REST API. That makes this the
// one connector here that posts a query rather than assembling a URL, and the
// reason a declarative connector spec would not have covered it.

import { flattenRecord } from "./flatten";
import type { IncrementalSpec, SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://api.linear.app/graphql";

/** Linear's maximum page. */
const PAGE_SIZE = 100;

type LinearCfg = Extract<SaasConfig, { provider: "linear" }>;

/**
 * The fields asked for, per stream.
 *
 * Spelt out rather than requested wholesale because GraphQL has no "give me
 * everything": every field must be named, and a nested object must say which
 * of ITS fields it wants. Naming them here keeps the dataset's shape stable
 * when Linear adds a field.
 */
const STREAMS: Record<string, { label: string; root: string; fields: string }> = {
  issues: {
    label: "Issues",
    root: "issues",
    fields: `
      id identifier title description priority estimate
      createdAt updatedAt completedAt canceledAt dueDate
      state { name type }
      team { key name }
      assignee { name email }
      creator { name email }
      project { name }
      labels { nodes { name } }
    `,
  },
  projects: {
    label: "Projects",
    root: "projects",
    fields: `id name description state progress startDate targetDate createdAt updatedAt`,
  },
  teams: {
    label: "Teams",
    root: "teams",
    fields: `id key name description private createdAt updatedAt`,
  },
  users: {
    label: "Users",
    root: "users",
    fields: `id name displayName email active admin createdAt updatedAt`,
  },
  cycles: {
    label: "Cycles",
    root: "cycles",
    fields: `id number name startsAt endsAt completedAt createdAt updatedAt`,
  },
};

type GraphQLReply = {
  data?: Record<
    string,
    { nodes?: Record<string, unknown>[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
  >;
  errors?: { message?: string }[];
};

async function linearQuery(
  cfg: LinearCfg,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLReply> {
  const res = await connectorFetch(API, {
    method: "POST",
    headers: {
      // NOT `Bearer`. Linear's personal API keys go in bare, and prefixing
      // them is the most common setup mistake.
      Authorization: cfg.api_key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 || res.status === 400) {
    // Linear answers a bad key with 400 as often as 401, so both say the same
    // thing rather than one of them looking like a bug in the query.
    throw new Error(
      "Linear: that API key was rejected. Paste it exactly as issued — it goes in " +
        "without a Bearer prefix.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Linear: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as GraphQLReply;
  // GraphQL answers 200 with an errors array, so a failed query looks like a
  // success to anything that only checks the status.
  if (body.errors?.length) {
    throw new Error(
      `Linear: ${body.errors
        .map((e) => e.message)
        .join("; ")
        .slice(0, 300)}`,
    );
  }
  return body;
}

export async function listLinearStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  // `viewer` is the cheapest query that proves the key and touches no issue
  // data.
  await linearQuery(cfg as LinearCfg, `query { viewer { id } }`, {});
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

/** Everything in Linear carries `updatedAt`, so every stream follows. */
export function linearIncremental(streamId: string): IncrementalSpec | null {
  if (!STREAMS[streamId]) return null;
  return { cursorField: "updatedAt", primaryKey: "id", compare: "iso" };
}

export async function* fetchLinearRows(
  cfg: SaasConfig,
  streamId: string,
  since?: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Linear: unknown stream "${streamId}"`);
  const c = cfg as LinearCfg;

  const at = since ? new Date(since) : null;
  const filter =
    at && !Number.isNaN(at.getTime())
      ? // `gte`, not `gt`: the record on the boundary returns and is folded
        // away by its id, where `gt` would drop anything sharing that instant.
        { updatedAt: { gte: at.toISOString() } }
      : null;

  // Cursor pagination, so the order Linear chooses does not matter: the mark
  // is the MAXIMUM `updatedAt` seen, not the last row of the last page.
  const query = `
    query Page($first: Int!, $after: String, $filter: ${
      streamId === "issues"
        ? "IssueFilter"
        : streamId === "projects"
          ? "ProjectFilter"
          : streamId === "teams"
            ? "TeamFilter"
            : streamId === "users"
              ? "UserFilter"
              : "CycleFilter"
    }) {
      ${stream.root}(first: $first, after: $after, filter: $filter) {
        nodes { ${stream.fields} }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  let after: string | undefined;
  for (;;) {
    const body = await linearQuery(c, query, {
      first: PAGE_SIZE,
      ...(after ? { after } : {}),
      ...(filter ? { filter } : {}),
    });
    const connection = body.data?.[stream.root];
    const nodes = connection?.nodes ?? [];
    if (nodes.length === 0) return;
    for (const n of nodes) yield flattenRecord(n);

    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) return;
    after = connection.pageInfo.endCursor;
  }
}
