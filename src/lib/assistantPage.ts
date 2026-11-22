// Where the reader is, as the assistant is told it: the page by its name in
// the menu and the group it sits in, and the one thing open on it, if any.
//
// The open object is read back from the address with the same links that
// wrote it. Each kind's `open()` is asked for a link to a marker id, and the
// place the marker lands (a path segment, or a search key) is where that
// kind keeps its id. A hand-written list of routes would be right on the
// day it was written; this one cannot disagree with the links search, My
// work and the New menu make.
import { ALL_NAV_GROUPS, navGroupForPath, navItemForPath } from "@/lib/appNav";
import { OBJECT_KINDS, type ObjectKindId } from "@/lib/objectKinds";

export type AssistantObjectRef = { kind: ObjectKindId; id: string };

export type AssistantPage = {
  /** The path, without the search or hash. */
  path: string;
  /** The page's name in the menu ("Dashboards"), or null for a page the menu does not list. */
  title: string | null;
  /** The menu group ("Analysis"), or null. */
  group: string | null;
  /** The object open on the page, when the address names one. */
  object: AssistantObjectRef | null;
};

const ID = "__assistant_id__";
const PARENT = "__assistant_parent__";

type Matcher = {
  kind: ObjectKindId;
  /** A path with the id in it ("/bi/<id>"), as a pattern. */
  pathPattern: RegExp | null;
  /** The page the id is passed to, when it is passed in the search. */
  page: string | null;
  /** The search key that holds the id. Other values the link sets (a
   *  swarm's view=canvas) are not required to recognise it. */
  idKey: string | null;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One matcher per kind, from the link it writes. Exported for the tests. */
export function objectMatchers(): Matcher[] {
  const out: Matcher[] = [];
  for (const k of OBJECT_KINDS) {
    const link = k.open({ id: ID, name: ID, parentId: PARENT });
    if (link.to.includes(ID)) {
      const pattern = escapeRe(link.to).replace(escapeRe(ID), "([^/]+)");
      out.push({
        kind: k.id,
        pathPattern: new RegExp(`^${pattern}/?$`),
        page: null,
        idKey: null,
      });
      continue;
    }
    const idKey = Object.entries(link.search ?? {}).find(([, v]) => v === ID)?.[0] ?? null;
    if (!idKey) continue;
    out.push({ kind: k.id, pathPattern: null, page: link.to, idKey });
  }
  return out;
}

let cached: Matcher[] | null = null;

/**
 * The object the address names, or null. When two kinds share a page (an
 * analyst and one of its analyses both live on /ai-analyst), the one whose
 * key is present and most specific wins: `?thread=` names the analysis even
 * though `?open=` names its analyst too.
 */
export function objectFromLocation(
  pathname: string,
  search: Record<string, unknown> | URLSearchParams | null | undefined,
): AssistantObjectRef | null {
  cached ??= objectMatchers();
  const path = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  const get = (key: string): string | null => {
    if (!search) return null;
    const v = search instanceof URLSearchParams ? search.get(key) : search[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  };

  for (const m of cached) {
    if (!m.pathPattern) continue;
    const hit = path.match(m.pathPattern);
    if (hit) return { kind: m.kind, id: decodeURIComponent(hit[1]) };
  }

  // Search-keyed kinds on this page. A page with several kinds (the analyst
  // page) is asked for its most specific key first: one that only a single
  // kind uses on this page beats one that every link to the page carries.
  const onPage = cached.filter((m) => m.page === path && m.idKey);
  const keyUse = new Map<string, number>();
  for (const m of onPage) keyUse.set(m.idKey!, (keyUse.get(m.idKey!) ?? 0) + 1);
  const ordered = [...onPage].sort((a, b) => {
    // `open` is how every list page is told what to open; a page-specific key
    // like `thread` or `swarm` names something more particular.
    const aGeneric = a.idKey === "open" ? 1 : 0;
    const bGeneric = b.idKey === "open" ? 1 : 0;
    return aGeneric - bGeneric || (keyUse.get(a.idKey!) ?? 0) - (keyUse.get(b.idKey!) ?? 0);
  });
  for (const m of ordered) {
    const id = get(m.idKey!);
    if (id) return { kind: m.kind, id };
  }
  return null;
}

/** The page and its object, for the assistant's first lines. */
export function assistantPage(
  pathname: string,
  search?: Record<string, unknown> | URLSearchParams | null,
): AssistantPage {
  const path = pathname.split("?")[0].split("#")[0];
  const item = navItemForPath(path, ALL_NAV_GROUPS);
  const group = navGroupForPath(path, ALL_NAV_GROUPS);
  return {
    path,
    title: item?.title ?? null,
    group: group?.label ?? null,
    object: objectFromLocation(path, search),
  };
}
