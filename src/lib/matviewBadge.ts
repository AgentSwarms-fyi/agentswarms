// What a materialized view's badge says about its last rebuild.
//
// FOUND IN R185 (sweep item 2; left open by R101 at S3). A failed rebuild
// keeps the previous rows, which is the right trade, and the server's comment
// gives the reason: "stale data a user can see and diagnose beats no data at
// all". Nobody could see it. Driven: analytics.r185_mv built over
// analytics.r185_base (1 row); the base renamed; Rebuild → the toast "Rebuild
// failed: Catalog Error: Table with name r185_base does not exist!", gone in
// seconds. The badge went on reading "materialized", the failure only in its
// hover title, and after a reload the table's tab held no word of it.
export type MatviewState = {
  schedule: string;
  last_status: string | null;
  last_error: string | null;
  last_refreshed_at: string | null;
};

export type MatviewBadge = {
  /** The badge's own words. */
  label: string;
  failed: boolean;
  /** The hover title: the whole error when the rebuild failed. */
  title: string;
  /** A line shown beside the badge when the rebuild failed, else null. */
  note: string | null;
};

/** An error's first line, as a sentence. */
function firstSentence(s: string | null): string {
  const line = (s ?? "").split("\n")[0].trim();
  return !line || /[.!?]$/.test(line) ? line : `${line}.`;
}

export function matviewBadge(
  mv: MatviewState,
  when: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): MatviewBadge {
  const cadence = mv.schedule === "manual" ? "materialized" : `rebuilt ${mv.schedule}`;
  if (mv.last_status !== "error") {
    return { label: cadence, failed: false, title: `Rebuilt ${mv.schedule}`, note: null };
  }
  const reason = firstSentence(mv.last_error) || "No reason was recorded.";
  return {
    label: "last rebuild failed",
    failed: true,
    title: `Last rebuild failed: ${mv.last_error ?? ""}`,
    note: mv.last_refreshed_at
      ? `${reason} These rows are from the rebuild of ${when(mv.last_refreshed_at)}.`
      : `${reason} The view has never been built.`,
  };
}
