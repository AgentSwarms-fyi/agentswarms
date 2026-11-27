// Personal data in lakehouse shares, and masking it there (R554).
//
// A share hands lakehouse tables to people outside the platform (Delta
// Sharing). Each shared table may mask columns on top of the table's own
// policy, but the owner had to know which ones: the catalog flags a column
// from its name, and a table added to a share with `contact` holding email
// addresses went out unmasked. R521 asks a dataset's owner about personal
// data its grants can read; this asks a share's owner the same about what a
// recipient can read, from the values, and masks it in that share on a yes.
//
// Pure: the words, the payload and the link. Which columns look personal, how
// masks compare and when to ask again are sensitiveData's, shared with R521.
import { describeColumns, type SensitiveFinding, type SuggestedColumn } from "@/lib/sensitiveData";

export const MASK_SHARE_ACTION = "lakehouse.share.mask_columns";

/** What a suggestion to mask columns in one shared table carries. */
export type ShareMaskPayload = {
  share_id: string;
  share_table_id: string;
  share_name: string;
  schema: string;
  table: string;
  columns: string[];
  findings: SuggestedColumn[];
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A suggestion back from an approval's payload, or null for anything else. */
export function shareMaskFromPayload(payload: unknown): ShareMaskPayload | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const shareId = str(p.share_id);
  const shareTableId = str(p.share_table_id);
  const schema = str(p.schema);
  const table = str(p.table);
  const columns = Array.isArray(p.columns)
    ? p.columns.filter((c): c is string => typeof c === "string" && !!c.trim())
    : [];
  if (!shareId || !shareTableId || !schema || !table || !columns.length) return null;
  const findings = Array.isArray(p.findings)
    ? (p.findings as SuggestedColumn[]).filter(
        (f) => f && typeof f.column === "string" && typeof f.kind === "string",
      )
    : [];
  return {
    share_id: shareId,
    share_table_id: shareTableId,
    share_name: str(p.share_name) ?? "",
    schema,
    table,
    columns,
    findings,
  };
}

/** The approval's title: fixed words, the table and the share. */
export function shareMaskTitle(p: Pick<ShareMaskPayload, "schema" | "table" | "share_name">) {
  const share = p.share_name ? ` in the share ${p.share_name}` : "";
  return `Mask personal data in ${p.schema}.${p.table}${share}`;
}

/** What approving does, in fixed words and the columns' names. */
export function shareMaskDescription(
  findings: readonly SensitiveFinding[],
  recipients: number,
): string {
  const one = findings.length === 1;
  const who =
    recipients === 1 ? "the one recipient who holds a token" : `the ${recipients} recipients`;
  return (
    `${describeColumns(findings)} ${one ? "looks" : "look"} personal from ${one ? "its" : "their"} ` +
    `values, and ${who} for this share can read ${one ? "it" : "them"}. Approving masks ` +
    `${one ? "that column" : "those columns"} in this share, from the next read on; your own ` +
    `queries and the table are unchanged. Rejecting leaves the share as it is, and you will not ` +
    `be asked about ${one ? "it" : "them"} again.`
  );
}

/** The lakehouse page, opened on one share. */
export function shareIntent(shareId: string): string {
  return `share:${shareId}`;
}

/** The share a lakehouse page link asks for, or null when it asks for none. */
export function shareIdFromIntent(open: string | null | undefined): string | null {
  const m = /^share:([0-9a-f-]{36})$/i.exec(open ?? "");
  return m ? m[1] : null;
}
