// Stable identity colour for a named thing (agent, dashboard, …): hash the
// name, pick from a fixed ramp. Grids of user-created items get the at-a-
// glance variety of project icons without asking anyone to choose a colour —
// and the same name always lands on the same hue, everywhere it appears.
const IDENTITY_HUES = [
  "from-teal-500/80 to-cyan-600/80",
  "from-violet-500/80 to-purple-600/80",
  "from-sky-500/80 to-blue-600/80",
  "from-emerald-500/80 to-teal-600/80",
  "from-fuchsia-500/80 to-pink-600/80",
  "from-amber-500/80 to-orange-600/80",
  "from-indigo-500/80 to-violet-600/80",
  "from-rose-500/80 to-red-600/80",
] as const;

export function identityHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return IDENTITY_HUES[h % IDENTITY_HUES.length];
}
