// The assistant's own two tools: the handbook, and the reader's own things.
//
// Both are registered only when a request names them (the assistant panel
// does); no agent gets them by default, and headless runs never do. The
// handbook is first-party text. The reader's things are read with the
// reader's own token, so row-level security decides what is listed — which
// is why find_my_work refuses on a run without one: there the client is the
// service role and would see every tenant.
import { DOCS_INDEX } from "@/components/docs/docsIndex";
import { buildDocsIndex, searchDocs, type DocsIndex } from "@/lib/docsSearch";
import {
  isObjectKindId,
  linkToObject,
  OBJECT_KINDS,
  objectKind,
  type ObjectEntry,
  type ObjectKindId,
} from "@/lib/objectKinds";
import { rankObjects } from "@/lib/objectSearch";
import { DOCS_TEXT } from "@/utils/assistant/docsText.server";
import { indexExtrasFor, SEALED_NAMES } from "@/utils/objectSearch/extras.server";
import { loadObjectIndex, searchCappedKinds } from "@/utils/objectSearch/sources.server";
import type { AgentToolContext, ToolDef } from "@/utils/tools/registry.server";

// ── docs_search ─────────────────────────────────────────────────────────

export const docsSearchTool: ToolDef = {
  type: "function",
  function: {
    name: "docs_search",
    description:
      "Search this app's handbook for how a feature works or how to do something in the app. " +
      "Returns the best-matching sections, each with a link. Use it before answering any " +
      "question about how the app works, answer from what it returns, and link the section you used.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The question, or the feature's own words, e.g. 'email a dashboard as a PDF every week'",
        },
      },
      required: ["query"],
    },
  },
};

let docsIndex: DocsIndex | null = null;

export async function runDocsSearch(
  _ctx: AgentToolContext,
  args: { query?: string },
): Promise<string> {
  const query = String(args?.query ?? "").slice(0, 300);
  docsIndex ??= buildDocsIndex(
    DOCS_TEXT,
    Object.fromEntries(DOCS_INDEX.map((p) => [p.route, p.description])),
  );
  const hits = searchDocs(docsIndex, query, 4);
  if (!hits.length) {
    return "The handbook has no section on that. Say so, and do not describe how the app works from memory.";
  }
  return hits.map((h) => `[${h.title}](${h.link})\n${h.excerpt}`).join("\n\n");
}

// ── find_my_work ────────────────────────────────────────────────────────

const KIND_IDS = OBJECT_KINDS.map((k) => k.id);

export const findMyWorkTool: ToolDef = {
  type: "function",
  function: {
    name: "find_my_work",
    description:
      "Find the user's own things in this app by name — agents, swarms, dashboards, reports, " +
      "datasets, workbooks, notebooks, pipelines and more — including things shared with them. " +
      "Returns each match's name, kind and a link that opens it. Use it when the user refers " +
      "to one of their things by name or asks where something is.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words from the name, e.g. 'churn'" },
        kind: {
          type: "string",
          enum: KIND_IDS,
          description: "Only this kind of thing (optional).",
        },
      },
      required: ["query"],
    },
  },
};

/** An app link as a path a markdown link can carry: "/bi/<id>" or "/agents?open=<id>". */
export function hrefOf(e: Pick<ObjectEntry, "kind" | "id" | "name" | "parentId">): string {
  const link = linkToObject(e);
  const qs = new URLSearchParams(
    Object.entries(link.search ?? {}).map(([k, v]) => [k, String(v)]),
  ).toString();
  return qs ? `${link.to}?${qs}` : link.to;
}

/** The lines the model reads: a link it can repeat, and what the thing is. */
export function formatMatches(entries: readonly ObjectEntry[]): string {
  return entries
    .map((e) => {
      const bits = [objectKind(e.kind).label];
      if (e.sample) bits.push("sample");
      else if (!e.mine) bits.push("shared with you");
      if (e.detail) bits.push(e.detail.slice(0, 120));
      // A name is the reader's (or a sharer's) text: square brackets inside
      // it would break the link the model repeats.
      const name = e.name.replace(/[[\]]/g, "").slice(0, 120) || "(untitled)";
      return `- [${name}](${hrefOf(e)}) — ${bits.join(" · ")}`;
    })
    .join("\n");
}

export async function runFindMyWork(
  ctx: AgentToolContext,
  args: { query?: string; kind?: string },
): Promise<string> {
  if (ctx.scopeUserId || !ctx.authToken) {
    return "Finding the user's things works only in the signed-in app.";
  }
  const query = String(args?.query ?? "")
    .trim()
    .slice(0, 200);
  if (!query) return "Say which words to look for.";
  const kind: ObjectKindId | undefined = isObjectKindId(args?.kind) ? args.kind : undefined;
  const kinds = kind ? new Set<ObjectKindId>([kind]) : undefined;

  const index = await loadObjectIndex(ctx.sb, ctx.userId, indexExtrasFor(ctx.sb, ctx.userId));
  let ranked = rankObjects(index.entries, query, { kinds, limit: 8 });
  // A kind too large for the index holds its newest names only; an older one
  // is found by asking the database for the name.
  const capped = index.capped.filter((k) => !kind || k === kind);
  if (ranked.length < 8 && capped.length) {
    const more = await searchCappedKinds(
      ctx.sb,
      ctx.userId,
      query,
      capped,
      Object.keys(SEALED_NAMES) as ObjectKindId[],
    );
    const seen = new Set(ranked.map((r) => `${r.kind}:${r.id}`));
    ranked = rankObjects(
      [...ranked, ...more.filter((m) => !seen.has(`${m.kind}:${m.id}`))],
      query,
      { kinds, limit: 8 },
    );
  }
  if (!ranked.length) {
    const what = kind ? objectKind(kind).plural.toLowerCase() : "things";
    return `Nothing of the user's ${what} has a name matching "${query}".`;
  }
  return formatMatches(ranked);
}
