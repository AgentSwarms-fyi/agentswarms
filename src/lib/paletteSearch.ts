// What the palette shows for what was typed: your work first, then the things
// you could start, then the pages. One function, so the palette's contents can
// be tested without rendering it.
//
// One exception to that order: a page or an action NAMED IN FULL goes first.
// Enter opens the first row, and someone who types "Knowledge Base" and
// presses it means the page, not the agent whose description mentions one.
//
// With nothing typed the palette is a menu: the pages, and a short list of
// things to create. Once something is typed it is a search, and every list is
// filtered and ordered by the same scorer (objectSearch).
import type { NavGroup, NavItem } from "@/lib/appNav";
import { createActions, type CreateAction, type ObjectEntry } from "@/lib/objectKinds";
import {
  compareRanked,
  EXACT,
  queryTokens,
  rankObjects,
  scoreMatch,
  type RankedObject,
} from "@/lib/objectSearch";

/** How many of your objects the palette lists before "see all results". */
export const PALETTE_OBJECT_LIMIT = 8;

/** With nothing typed, the "new" actions offered: one per common start. */
export const FEATURED_CREATE: readonly string[] = [
  "agent",
  "swarm",
  "dashboard",
  "dataset",
  "notebook",
  "ai_analyst",
];

export type PalettePage = NavItem & { group: string };

export type PaletteSection = "objects" | "create" | "pages";

/** The order the sections are shown in unless something is named in full. */
export const SECTION_ORDER: readonly PaletteSection[] = ["objects", "create", "pages"];

export type PaletteResults = {
  /** Something was typed. */
  searching: boolean;
  /** The sections, first one first. The first row of the first is what Enter opens. */
  order: PaletteSection[];
  objects: RankedObject[];
  /** Every matching object, not only the ones listed. */
  objectTotal: number;
  create: CreateAction[];
  pages: PalettePage[];
};

/**
 * "New dashboard", "New AI analyst": the kind's title after "New", with its
 * first word lower-cased unless that word is an abbreviation written in
 * capitals (AI, ML, MCP, SQL).
 */
const createTitle = (a: CreateAction) => {
  const [first, ...rest] = a.title.split(" ");
  const head = first === first.toUpperCase() ? first : first.toLowerCase();
  return ["New", head, ...rest].join(" ");
};

export function paletteResults(args: {
  query: string;
  entries: readonly ObjectEntry[];
  navGroups: readonly NavGroup[];
  objectLimit?: number;
}): PaletteResults {
  const { query, entries, navGroups } = args;
  const limit = args.objectLimit ?? PALETTE_OBJECT_LIMIT;
  const pagesAll: PalettePage[] = navGroups.flatMap((g) =>
    g.items.map((item) => ({ ...item, group: g.label })),
  );
  const actions = createActions();

  if (!queryTokens(query).length) {
    return {
      searching: false,
      order: [...SECTION_ORDER],
      objects: [],
      objectTotal: 0,
      create: FEATURED_CREATE.map((k) => actions.find((a) => a.kind === k)).filter(
        (a): a is CreateAction => !!a,
      ),
      pages: pagesAll,
    };
  }

  const ranked = rankObjects(entries, query);
  const scored = <T>(items: T[], name: (t: T) => string, detail: (t: T) => string) =>
    items
      .map((item) => ({
        item,
        score: scoreMatch(query, name(item), detail(item)),
        name: name(item),
      }))
      .filter((r) => r.score > 0)
      .sort(compareRanked);

  // "new dash", "dashboard" and "create report" all find their action: the
  // section and the hint are searched as the description.
  const create = scored(actions, createTitle, (a) => `create add ${a.section} ${a.hint}`);
  // A page is also found by its group, and by what it used to be called. The
  // old name is a NAME, not a description: typed in full it names the page in
  // full, so the page leads and Enter opens it. Scored only as a description,
  // "model registry" opened an agent whose description mentioned one.
  const pages = pagesAll
    .map((item) => ({
      item,
      name: item.title,
      score: Math.max(
        scoreMatch(
          query,
          item.title,
          item.formerly ? `${item.group} ${item.formerly}` : item.group,
        ),
        item.formerly ? scoreMatch(query, item.formerly) : 0,
      ),
    }))
    .filter((r) => r.score > 0)
    .sort(compareRanked);

  // Named in full: the whole of what was typed is the whole of its name. Your
  // own work named in full still comes first; otherwise the section holding
  // that name leads. Nothing else reorders, so a partial word keeps the order
  // people have learned.
  const named: Record<PaletteSection, boolean> = {
    objects: (ranked[0]?.score ?? 0) >= EXACT,
    create: (create[0]?.score ?? 0) >= EXACT,
    pages: (pages[0]?.score ?? 0) >= EXACT,
  };
  const order = [...SECTION_ORDER].sort((a, b) => Number(named[b]) - Number(named[a]));

  return {
    searching: true,
    order,
    objects: ranked.slice(0, limit),
    objectTotal: ranked.length,
    create: create.map((r) => r.item),
    pages: pages.map((r) => r.item),
  };
}

export { createTitle };
