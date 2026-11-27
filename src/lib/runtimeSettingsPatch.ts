// What a save on Admin → Developer runtime sends, and what the audit keeps
// of it (R550).
//
// FOUND IN R550. The page sent every field on every save. A setting it had
// never been told about by the database showed its built-in default, so one
// save — made for any reason, on any tab — wrote that default over the value
// the server's environment set, and the environment stopped counting with no
// sign anywhere. Now a save sends only what changed since the page loaded,
// and what was reset, which clears the saved value (null) so the environment
// or the built-in value is in force again.
//
// Pure.

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields a save sends: those changed since the page loaded, and those reset (as null). */
export function settingsPatch(
  loaded: Record<string, unknown>,
  form: Record<string, unknown>,
  reset: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) {
    if (reset.has(k)) out[k] = null;
    else if (!same(v, loaded[k])) out[k] = v;
  }
  for (const k of reset) if (!(k in out)) out[k] = null;
  return out;
}

export type SettingChange = { field: string; from: unknown; to: unknown };

/**
 * One entry per setting a save changed, from the stored value to the new
 * one. A list says how many entries it went from and to; anything that may
 * carry an address with credentials in it (a URL) says only that it changed.
 */
export function settingsAuditChanges(
  before: Record<string, unknown>,
  fields: Record<string, unknown>,
): SettingChange[] {
  const out: SettingChange[] = [];
  for (const [field, to] of Object.entries(fields)) {
    const from = before[field] ?? null;
    if (same(from, to ?? null)) continue;
    if (/url/i.test(field)) {
      out.push({ field, from: "(set)", to: "(changed)" });
    } else if (Array.isArray(to) || Array.isArray(from)) {
      const n = (v: unknown) => (Array.isArray(v) ? `${v.length} entries` : "(none)");
      out.push({ field, from: n(from), to: n(to) });
    } else {
      out.push({ field, from, to: to ?? null });
    }
  }
  return out.sort((a, b) => a.field.localeCompare(b.field));
}
