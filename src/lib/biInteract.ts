// Dashboards that move with the reader (R503): titles and text that say what
// is picked, a click that opens another page filtered to what was clicked or a
// link built from it, and text links that go to a page.
//
// Words in a title or text widget:
//   {{rider}}                  the parameter's picked value, as its label
//   {{selected}}               what the page is filtered to by a click
//   {{selected|every station}} …or these words when nothing is
// A name that is neither stays as written, so text that happens to contain
// braces is not changed.
//
// Everything here is pure: the dashboard routes, the exports and the tests
// share it.
import { paramValueLabel, type BiParamConfig, type BiParamValues } from "@/lib/biParams";

/** What a chart click does. Absent: it filters the page it is on, as before. */
export type BiClickAction =
  /** Opens another page of the dashboard, filtered to the clicked value. */
  | { kind: "page"; pageId: string }
  /** Opens a link; {{value}} in it becomes the clicked value. */
  | { kind: "url"; url: string };

export type TextTokenState = {
  params: BiParamConfig[];
  values: BiParamValues;
  /** The value the page is filtered to by a click; null when it is not. */
  selected: string | null;
};

const TOKEN = /\{\{\s*([a-z][a-z0-9_]*)\s*(?:\|([^{}]*))?\}\}/gi;

/** Characters markdown would read as formatting, escaped to stay as text. */
function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

/**
 * The text with {{name}} and {{selected}} filled in. `markdown` escapes what is
 * filled in, so a station called "*Main St*" is not set in italics and a value
 * cannot add a link of its own.
 */
export function fillTextTokens(
  text: string,
  state: TextTokenState,
  opts: { markdown?: boolean } = {},
): string {
  if (!text || !text.includes("{{")) return text;
  const byName = new Map(state.params.map((p) => [p.name, p]));
  const out = (s: string) => (opts.markdown ? escapeMarkdown(s) : s);
  return text.replace(TOKEN, (whole, rawName: string, fallback: string | undefined) => {
    const name = rawName.toLowerCase();
    if (name === "selected") {
      return state.selected !== null && state.selected !== ""
        ? out(state.selected)
        : out((fallback ?? "").trim());
    }
    const p = byName.get(name);
    if (!p) return whole;
    return out(paramValueLabel(p, state.values[name] ?? p.default));
  });
}

/**
 * Tokens filled the way a reader first sees them: every parameter at its
 * default and nothing clicked. For exports and messages, which have no reader
 * picking anything.
 */
export function fillAtDefaults(text: string, params: BiParamConfig[]): string {
  return fillTextTokens(text, { params, values: {}, selected: null });
}

/**
 * The link a URL action opens for a clicked value, or null. {{value}} is
 * replaced URL-encoded, and only an http(s) address is opened: a template
 * that makes anything else (javascript:, data:) opens nothing.
 */
export function clickActionUrl(template: string, value: string): string | null {
  if (!template) return null;
  const filled = template.replace(/\{\{\s*value\s*\}\}/gi, encodeURIComponent(value));
  let u: URL;
  try {
    u = new URL(filled.trim());
  } catch {
    return null;
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
}

/** Whether a URL action's template can make a link at all. */
export function isClickUrlTemplate(template: string): boolean {
  return clickActionUrl(template, "x") !== null;
}

/** A click action as saved, or undefined when it is malformed. */
export function parseClickAction(v: unknown): BiClickAction | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (r.kind === "page" && typeof r.pageId === "string" && r.pageId) {
    return { kind: "page", pageId: r.pageId };
  }
  if (r.kind === "url" && typeof r.url === "string" && isClickUrlTemplate(r.url)) {
    return { kind: "url", url: r.url };
  }
  return undefined;
}

/** How a text link names a page: [Stations](#page=Stations) or #page=2. */
export const PAGE_LINK_PREFIX = "#page=";

/**
 * The index of the page a #page= link names: by name (ignoring case and
 * surrounding space), else by its number counting from 1. -1 when none.
 */
export function pageIndexFor(pages: { name: string }[], href: string | null): number {
  if (!href || !href.startsWith(PAGE_LINK_PREFIX)) return -1;
  let ref = href.slice(PAGE_LINK_PREFIX.length);
  try {
    ref = decodeURIComponent(ref);
  } catch {
    // A stray % is part of the name.
  }
  const want = ref.trim().toLowerCase();
  if (!want) return -1;
  const byName = pages.findIndex((p) => p.name.trim().toLowerCase() === want);
  if (byName >= 0) return byName;
  if (/^\d{1,3}$/.test(want)) {
    const n = Number(want) - 1;
    return n >= 0 && n < pages.length ? n : -1;
  }
  return -1;
}

/** What one click does, decided the same way in the editor, a shared link and an embed. */
export type ClickOutcome =
  /** Open this link in a new tab. */
  | { kind: "url"; href: string }
  /** Show this page, filtered to the clicked value. */
  | { kind: "page"; pageId: string; index: number }
  /** Filter the page it is on (or clear the filter, on a second click). */
  | { kind: "filter" }
  /** Nothing: a link action whose template makes no http(s) address. */
  | { kind: "none" };

export function resolveClick(
  saved: unknown,
  value: string,
  pages: { id: string }[],
  activePageId: string,
): ClickOutcome {
  // Read through the parser: a dashboard's JSON can be edited by hand.
  const action = parseClickAction(saved);
  if (action?.kind === "url") {
    const href = clickActionUrl(action.url, value);
    return href ? { kind: "url", href } : { kind: "none" };
  }
  if (action?.kind === "page" && action.pageId !== activePageId) {
    const index = pages.findIndex((p) => p.id === action.pageId);
    // A page deleted since the action was set: filter here instead.
    if (index >= 0) return { kind: "page", pageId: action.pageId, index };
  }
  return { kind: "filter" };
}

/**
 * Widgets with their titles and text filled in, for a copy that leaves the
 * page — a slide deck — where nothing can fill them later.
 */
export function withTokensFilled<W extends { title?: string; text?: string }>(
  widgets: W[],
  state: TextTokenState,
): W[] {
  return widgets.map((w) => {
    const title = w.title ? fillTextTokens(w.title, state) : w.title;
    const text = w.text ? fillTextTokens(w.text, state, { markdown: true }) : w.text;
    return title === w.title && text === w.text ? w : { ...w, title, text };
  });
}
