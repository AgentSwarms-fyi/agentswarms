/**
 * Whole days since the credential was entered, or null when unknown.
 *
 * Mirrors credentialAgeDays in connectionHealth.server. It is duplicated here
 * for one specific reason: that module imports the Supabase admin client and
 * pulls the whole server graph into the browser bundle. The logic is a single
 * subtraction, and the test asserts the two agree.
 */
export function credentialAgeDays(rotatedAt: string | null | undefined): number | null {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
