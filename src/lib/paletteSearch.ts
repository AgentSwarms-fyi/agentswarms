// What the palette shows for what was typed: your work first, then the things
// you could start, then the pages. One function, so the palette's contents can
// be tested without rendering it.
//
// With nothing typed the palette is a menu: the pages, and a short list of
// things to create. Once something is typed it is a search, and every list is
// filtered and ordered by the same scorer (objectSearch).
import type { NavGroup, NavItem } from "@/lib/appNav";
import { createActions, type CreateAction, type ObjectEntry } from "@/lib/objectKinds";
import {
  compareRanked,
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

export type PaletteResults = {
  /** Something was typed. */
  searching: boolean;
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
      .sort(compareRanked)
      .map((r) => r.item);

  return {
    searching: true,
    objects: ranked.slice(0, limit),
    objectTotal: ranked.length,
    // "new dash", "dashboard" and "create report" all find their action: the
    // section and the hint are searched as the description.
    create: scored(actions, createTitle, (a) => `create add ${a.section} ${a.hint}`),
    pages: scored(
      pagesAll,
      (p) => p.title,
      (p) => p.group,
    ),
  };
}

export { createTitle };
