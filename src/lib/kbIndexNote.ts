/**
 * What the embed step did to documents just added, as a sentence for the
 * toast, or null when every one was indexed.
 *
 * FOUND IN R208: the Add Source dialog called the embed step and looked at
 * nothing it returned. A failed call went to the console and a skipped one
 * (no embedding key) to nowhere, and the toast said "1 file added" either
 * way. The document was there, but not indexed, so search found it by
 * keyword only.
 */
export type EmbedOutcome =
  | { ok: { skipped?: boolean; reason?: string; warnings?: string[] } | null | undefined }
  | { error: unknown };

export function indexNote(outcome: EmbedOutcome): string | null {
  if ("error" in outcome) {
    const e = outcome.error;
    const why = e instanceof Error ? e.message : String(e);
    return `Not indexed yet: ${why}. Re-index retries; until then it is found by keyword only.`;
  }
  const r = outcome.ok;
  if (r?.skipped) {
    return r.reason === "no_api_key"
      ? "Not indexed: no embedding key is set (RAG Settings), so it is found by keyword only until one is."
      : "Not indexed: the embed step was skipped, so it is found by keyword only.";
  }
  const warnings = r?.warnings ?? [];
  if (warnings.length > 0) {
    return `Indexed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${warnings[0]}`;
  }
  return null;
}
