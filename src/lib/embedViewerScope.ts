// Turning a verified viewer's attributes into the rows that viewer may see.
//
// embedViewerToken.ts answers "who is looking?". This answers "so what do they
// get?" — and the honest answer for a snapshot-rendered dashboard is not
// always "their rows".
//
// WHY A SNAPSHOT COMPLICATES THIS. An embedded dashboard renders STORED result
// rows: the widget query already ran, as the owner, and what survives is its
// output. If a widget projects `tenant`, we can filter that output down to one
// tenant and the number is right. If the widget aggregated `tenant` away —
// `SELECT month, sum(revenue) FROM sales GROUP BY month` — the total already
// contains every tenant and NOTHING done to those rows can recover one
// tenant's share. There is no filter that fixes it, only a re-run.
//
// So a widget has three outcomes, and the third is the one that matters:
//
//   scoped       — the filter column is in the output; rows filtered; correct.
//   empty        — the column is there and this viewer matched no rows. An
//                  honest zero.
//   unscopable   — the column is NOT in the output. We WITHHOLD the widget and
//                  say why. Rendering it unfiltered leaks every tenant's data;
//                  rendering it blank is a lie that reads as "no data". The
//                  owner's fix is to project the column, and they can only
//                  make that fix if we tell them.
//
// ATTRIBUTES INTERSECT. Two grants union — grants are additive, holding two
// must never show you less than holding one. Attributes are the opposite:
// {tenant: acme, region: emea} describes ONE viewer, and a row must satisfy
// both to be theirs. Union here would hand an acme viewer every row in emea.
// The composition below is a reduce over applyRowFilters — the shared,
// already-fail-closed primitive — one attribute at a time, so each step is a
// union of one and the sequence is the intersection.
import { applyRowFilters, type BiRowFilter, type BiWidget } from "@/lib/biDashboards";

export type ViewerScopeResult =
  | { ok: true; filters: BiRowFilter[] }
  | { ok: false; missing: string[]; reason: string };

/**
 * The filters a viewer's attributes produce, given the attributes this embed
 * REQUIRES.
 *
 * The required list is what makes a typo fail closed. Without it we would
 * filter by whatever the token happened to carry, so a host sending `tenat`
 * instead of `tenant` would produce no filters at all and every viewer would
 * see everything — the failure mode being paid for here. With it, a missing
 * attribute is a refusal that names what was missing.
 *
 * Attributes the embed did not ask for are ignored rather than applied. They
 * could only narrow, so honouring them would be safe; ignoring them keeps the
 * owner's configuration the single description of what this embed shows, so
 * two hosts sending different extras cannot render two different dashboards.
 */
export function viewerScopeFilters(
  required: string[],
  attrs: Record<string, string[]>,
): ViewerScopeResult {
  const want = required.map((r) => r.trim()).filter(Boolean);
  if (want.length === 0) {
    // An embed that requires a signed viewer but names no attributes cannot
    // scope anything, so a verified token would grant the FULL dashboard —
    // "signed in" mistaken for "authorized". Refuse instead.
    return {
      ok: false,
      missing: [],
      reason:
        "This embed requires a signed viewer but no viewer attributes are configured, " +
        "so there is nothing to scope the data by.",
    };
  }
  const lower = new Map(Object.entries(attrs).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const filters: BiRowFilter[] = [];
  const missing: string[] = [];
  for (const name of want) {
    const values = lower.get(name.toLowerCase()) ?? [];
    if (values.length === 0) missing.push(name);
    else filters.push({ column: name, values });
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `The viewer token is missing ${missing.map((m) => `"${m}"`).join(", ")}, which this embed scopes its data by.`,
    };
  }
  return { ok: true, filters };
}

export type ScopedWidget = {
  widget: BiWidget;
  /** Set when the widget could not be scoped and was therefore withheld. */
  withheld?: string;
};

/** Case-insensitive lookup of a filter column among a widget's output columns. */
function canonicalColumn(widget: BiWidget, column: string): string | null {
  const target = column.trim().toLowerCase();
  for (const c of widget.columns ?? []) {
    if (String(c).trim().toLowerCase() === target) return String(c);
  }
  // A widget may carry rows without a declared column list; the row keys are
  // then the only statement of what it projects.
  for (const row of widget.rows ?? []) {
    for (const k of Object.keys(row)) {
      if (k.trim().toLowerCase() === target) return k;
    }
  }
  return null;
}

/**
 * Scope one widget to a viewer.
 *
 * The narrative is DROPPED from any widget whose rows changed. It was written
 * about the owner's full result — "revenue grew 12% to $4.2M" — and leaving it
 * beside one tenant's filtered chart states another tenant's numbers in prose
 * next to a chart that no longer supports them.
 */
export function scopeWidget(widget: BiWidget, filters: BiRowFilter[]): ScopedWidget {
  if (filters.length === 0) return { widget };
  // Text and image widgets carry no result rows to scope. They are the
  // owner's own prose, identical for every viewer, and that is what they look
  // like on screen.
  if (widget.kind !== "chart") return { widget };

  const resolved: BiRowFilter[] = [];
  for (const f of filters) {
    const canonical = canonicalColumn(widget, f.column);
    if (!canonical) {
      return {
        widget: { ...widget, rows: [], narrative: undefined },
        withheld:
          `Withheld: this widget's results do not include "${f.column}", so they cannot be ` +
          `limited to your data. Add "${f.column}" to the widget's query to show it here.`,
      };
    }
    resolved.push({ ...f, column: canonical });
  }
  // One filter at a time: applyRowFilters unions within a call, so a single
  // filter per call makes the sequence an intersection. See the header.
  const rows = resolved.reduce(
    (acc, f) => applyRowFilters(acc, [f]),
    Array.isArray(widget.rows) ? widget.rows : [],
  );
  return { widget: { ...widget, rows, narrative: undefined } };
}

/** scopeWidget across a widgets array, carrying the withheld reason inline. */
export function scopeWidgets(widgets: unknown, filters: BiRowFilter[]): unknown {
  if (!Array.isArray(widgets) || filters.length === 0) return widgets;
  return (widgets as BiWidget[]).map((w) => {
    if (!w || typeof w !== "object") return w;
    const scoped = scopeWidget(w, filters);
    return scoped.withheld ? { ...scoped.widget, withheld: scoped.withheld } : scoped.widget;
  });
}

/** scopeWidgets across the pages array, which carries its own widgets. */
export function scopePages(pages: unknown, filters: BiRowFilter[]): unknown {
  if (!Array.isArray(pages) || filters.length === 0) return pages;
  return (pages as Record<string, unknown>[]).map((p) => ({
    ...p,
    widgets: scopeWidgets(p.widgets, filters),
  }));
}

/**
 * One line describing the scope in force, for the embed's footer.
 *
 * A viewer looking at a filtered dashboard has no way to tell it is filtered,
 * and a number that is a SUBSET presented as if it were the TOTAL is the same
 * wrong answer whether the cause is a bug or a policy.
 */
export function describeViewerScope(filters: BiRowFilter[]): string | null {
  if (filters.length === 0) return null;
  const parts = filters.map((f) => `${f.column} = ${f.values.join(" or ")}`);
  return `Showing data for ${parts.join(", ")}.`;
}

/**
 * The dashboard rows an AI answer may be computed from.
 *
 * The embedded analyst reads the stored widget rows. Left alone it would read
 * the OWNER's rows and answer a scoped viewer's question with everyone's data
 * — a leak with a friendlier voice than a chart. Withheld widgets are removed
 * entirely rather than passed empty, so the model is never asked to reason
 * about a widget whose numbers it must not see.
 */
export function scopeWidgetsForAi(widgets: unknown, filters: BiRowFilter[]): BiWidget[] {
  if (!Array.isArray(widgets)) return [];
  if (filters.length === 0) return widgets as BiWidget[];
  const out: BiWidget[] = [];
  for (const w of widgets as BiWidget[]) {
    if (!w || typeof w !== "object") continue;
    const scoped = scopeWidget(w, filters);
    if (scoped.withheld) continue;
    out.push(scoped.widget);
  }
  return out;
}
