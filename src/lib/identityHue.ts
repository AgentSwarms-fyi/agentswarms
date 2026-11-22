// Stable identity colour for a named thing (agent, dashboard, …): hash the
// name, pick from a fixed ramp. Grids of user-created items get the at-a-
// glance variety of project icons without asking anyone to choose a colour —
// and the same name always lands on the same hue, everywhere it appears.
//
// A tint, not a fill: a soft wash of the hue behind an icon drawn in it. The
// ramp used to be bright two-stop gradients under white icons with a shadow,
// which on a grid of twenty cards was twenty small posters.
const IDENTITY_HUES = [
  "bg-teal-500/12 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300",
  "bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  "bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  "bg-fuchsia-500/12 text-fuchsia-700 dark:bg-fuchsia-400/15 dark:text-fuchsia-300",
  "bg-amber-500/14 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  "bg-indigo-500/12 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300",
  "bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
] as const;

/** The tint classes for a name: background wash and icon colour. */
export function identityHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return IDENTITY_HUES[h % IDENTITY_HUES.length];
}
