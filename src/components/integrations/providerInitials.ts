/**
 * Initials for a provider with no bundled logo.
 *
 * A single-word label takes its first TWO letters, not one: ClickHouse and
 * CockroachDB would otherwise render as two identical "C" tiles in the same
 * grid.
 */
export function providerInitials(label: string): string {
  const words = label
    .replace(/[^A-Za-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
