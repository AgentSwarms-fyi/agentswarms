// User attributes a share's row filter can reference as {{user.<key>}} (R496).
//
// The token was typed from memory, and a misspelt key is a grant that refuses
// every query its grantees make ("your access is filtered by an attribute you
// do not have"). The share form now lists the keys set on the Attributes tab.
import type { TemplateToken } from "@/components/templates/TemplateInsert";

export type AttributeRow = { user_id: string; key: string; values: string[] };

/** One menu entry per attribute key, saying who has it and with what. */
export function attributeFilterTokens(rows: AttributeRow[]): TemplateToken[] {
  const byKey = new Map<string, { users: Set<string>; values: Set<string> }>();
  for (const a of rows) {
    const e = byKey.get(a.key) ?? { users: new Set<string>(), values: new Set<string>() };
    e.users.add(a.user_id);
    for (const v of a.values) e.values.add(v);
    byKey.set(a.key, e);
  }
  return [...byKey]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => {
      const vals = [...e.values];
      const n = e.users.size;
      return {
        insert: `{{user.${key}}}`,
        label: `user.${key}`,
        detail:
          `Set for ${n} user${n === 1 ? "" : "s"}: ` +
          (vals.length > 4 ? `${vals.slice(0, 4).join(", ")}, …` : vals.join(", ")),
      };
    });
}

/**
 * The comma-separated values with one more. An attribute token must be a
 * WHOLE value (USER_ATTR_TOKEN_RE), so a pick is its own item, never spliced
 * into another at the cursor; picking one already there changes nothing.
 */
export function addFilterValue(current: string, value: string): string {
  const items = current
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return items.includes(value) ? current : [...items, value].join(", ");
}
