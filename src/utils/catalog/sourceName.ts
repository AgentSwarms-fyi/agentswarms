// What a Data Catalog source may be called.
//
// catalogCreateSource refuses any other name in its validator, before the
// connection is tested. The Add source wizard used to find that out only at
// Connect & crawl: "R422 private store (kept fixture)" came back as the
// validator's issue JSON in the dialog. The wizard now checks the same rule
// before Continue, so the person reads it next to the field they typed.
//
// PURE: the form and the server use the same rules.

export const SOURCE_NAME_MAX = 60;
export const SOURCE_NAME_PATTERN = /^[a-zA-Z0-9_\- .]+$/;
export const SOURCE_NAME_RULE = "Letters, numbers, spaces, - _ . only";
export const SOURCE_NAME_TOO_LONG = `${SOURCE_NAME_MAX} characters at most`;

/**
 * Why the server would refuse this name, or null when it would not. Checks
 * the name as the wizard sends it (trimmed); an empty one is not a problem to
 * report, because the form simply waits for a name.
 */
export function sourceNameProblem(name: string): string | null {
  const n = name.trim();
  if (n === "") return null;
  if (n.length > SOURCE_NAME_MAX) return SOURCE_NAME_TOO_LONG;
  if (!SOURCE_NAME_PATTERN.test(n)) return SOURCE_NAME_RULE;
  return null;
}
