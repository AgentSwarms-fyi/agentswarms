// The sheet tabs' rules around hidden sheets (R160).

/**
 * The sheet to show when the one in view is hidden: the next sheet showing,
 * or else the one before it. Undefined when the sheet in view is not hidden
 * (or no other sheet shows).
 */
export function shownInstead<T extends { id: string }>(
  tabs: readonly T[],
  inViewId: string | null | undefined,
  hidden: (t: T) => boolean,
): string | undefined {
  const i = tabs.findIndex((t) => t.id === inViewId);
  if (i < 0 || !hidden(tabs[i])) return undefined;
  const after = tabs.slice(i + 1).find((t) => !hidden(t));
  if (after) return after.id;
  for (let j = i - 1; j >= 0; j--) if (!hidden(tabs[j])) return tabs[j].id;
  return undefined;
}
