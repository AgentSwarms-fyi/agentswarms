// The IAM page's tabs, as they are written in the address (?tab=budgets).
//
// Here and not in the route file because two things read them: the page, and
// every link to one of its tabs ("Admin → IAM → Budgets" on the budgets page).

export const IAM_TABS = [
  "users",
  "groups",
  "access",
  "attributes",
  "budgets",
  "sso",
  "settings",
] as const;
export type IamTab = (typeof IAM_TABS)[number];

/**
 * The tab an address asks for, or the first one.
 *
 * The address is a suggestion, not a fact: a link written before a tab was
 * renamed, or a typo, must open the page on its first tab. Taken at its word
 * it selected a tab that does not exist, and the page drew its header over
 * nothing at all.
 */
export function iamTabFrom(value: unknown): IamTab {
  return typeof value === "string" && (IAM_TABS as readonly string[]).includes(value)
    ? (value as IamTab)
    : IAM_TABS[0];
}
