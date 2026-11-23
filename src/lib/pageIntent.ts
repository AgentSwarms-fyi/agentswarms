// What a link into a list page can ask of it: open one of its objects, or
// start a new one, optionally from one of its templates.
//
// Search results and the "New" menu are links (src/lib/objectKinds.ts). A kind
// with its own page per object links straight to it; the others are opened
// from their list page, which is told which one by `?open=<id>` and told to
// start a new one by `?new=1`. The template gallery (R530) adds
// `?new=1&template=<id>`: start a new one from that template. Every list page
// reads them the same way, so a link written once works on all of them.

export type PageIntent = {
  /** The id of the object to open. */
  open?: string;
  /** Start a new one. */
  new?: 1;
  /** ...from this template. Only read together with `new`. */
  template?: string;
};

/**
 * What a template id may look like: registry ids, slugs, file stems and the
 * `sample:` skill ids. Anything else in the address is ignored, not passed on.
 */
export const TEMPLATE_ID_RULE = /^[a-z0-9][a-z0-9_:.-]{0,79}$/i;

/**
 * The intent in a route's raw search, for use inside `validateSearch`. The
 * router parses search values as JSON, so an id of digits arrives as a number
 * and `new=1` as the number 1; both spellings are accepted.
 */
export function readPageIntent(s: Record<string, unknown>): PageIntent {
  const out: PageIntent = {};
  if (typeof s.open === "string" && s.open.trim() && s.open.length <= 400) out.open = s.open;
  else if (typeof s.open === "number" && Number.isFinite(s.open)) out.open = String(s.open);
  if (s.new === 1 || s.new === "1" || s.new === true || s.new === "true") {
    out.new = 1;
    if (typeof s.template === "string" && TEMPLATE_ID_RULE.test(s.template)) {
      out.template = s.template;
    }
  }
  return out;
}

/** The search with the intent taken out, once the page has acted on it. */
export function withoutPageIntent<T extends Record<string, unknown>>(
  search: T,
): Omit<T, "open" | "new" | "template"> {
  const { open: _open, new: _new, template: _template, ...rest } = search as T & PageIntent;
  return rest as Omit<T, "open" | "new" | "template">;
}
