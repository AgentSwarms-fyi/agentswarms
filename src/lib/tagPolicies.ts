// Policies by tag: one rule an owner writes once, applied wherever the tag
// is. The enforcement stays the per-table policy the parser-level rewrite
// already applies — this module only computes that policy from what a table
// and its columns are tagged with. Pure, so a test can hand it tags and
// rules and read the result.

export type TagPolicy = {
  id: string;
  tag: string;
  /** column: mask every column carrying the tag; table: filter every table carrying it. */
  scope: "column" | "table";
  mask_style: "null" | "hash";
  row_filter: string | null;
};

export type EffectivePolicy = {
  row_filter: string | null;
  masked_columns: string[];
  mask_style: "null" | "hash";
  /** The tag rules that contributed, for the audit trail and the page. */
  via_tags: string[];
};

/** Tags compare trimmed and case-insensitively: `PII` and `pii` are one tag. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * The policy a reader gets on one table: the explicit table policy (if any)
 * folded with every tag rule its tags and its columns' tags trigger. Masks
 * union; filters AND; a blank mask beats a scramble, because a stricter rule
 * anywhere must not be weakened by a looser one elsewhere. Null when nothing
 * applies, so the ordinary path pays no cost.
 */
export function effectivePolicy(args: {
  explicit: {
    row_filter: string | null;
    masked_columns: string[];
    mask_style: "null" | "hash";
  } | null;
  tableTags: string[];
  columns: { name: string; tags?: string[] }[];
  tagPolicies: TagPolicy[];
}): EffectivePolicy | null {
  const rules = args.tagPolicies.map((p) => ({ ...p, tag: normalizeTag(p.tag) }));
  const tableTags = new Set(args.tableTags.map(normalizeTag));
  const masked = new Map<string, string>(); // lower-cased name → as written
  const filters: string[] = [];
  const via = new Set<string>();
  let style: "null" | "hash" | null = null;
  const strictest = (s: "null" | "hash") => {
    style = style === "null" || s === "null" ? "null" : "hash";
  };

  if (args.explicit) {
    for (const c of args.explicit.masked_columns) masked.set(c.toLowerCase(), c);
    if (args.explicit.masked_columns.length) strictest(args.explicit.mask_style);
    if (args.explicit.row_filter?.trim()) filters.push(args.explicit.row_filter.trim());
  }
  for (const rule of rules) {
    if (rule.scope === "column") {
      for (const col of args.columns) {
        if (!(col.tags ?? []).some((t) => normalizeTag(t) === rule.tag)) continue;
        masked.set(col.name.toLowerCase(), col.name);
        strictest(rule.mask_style);
        via.add(rule.tag);
      }
    } else if (tableTags.has(rule.tag) && rule.row_filter?.trim()) {
      filters.push(rule.row_filter.trim());
      via.add(rule.tag);
    }
  }
  if (!masked.size && !filters.length) return null;
  return {
    row_filter: filters.length ? filters.map((f) => `(${f})`).join(" AND ") : null,
    masked_columns: [...masked.values()],
    mask_style: style ?? "null",
    via_tags: [...via].sort(),
  };
}
